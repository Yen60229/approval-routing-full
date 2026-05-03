/**
 * 批次角色建立工具（kintone App 685）
 *
 * 功能：
 * 1. 讀取 CSV，支援「登入帳號 / 使用者名稱 / title_level」或舊版「code / title」欄位。
 * 2. 以 CSV 的登入帳號對應後台登入名稱、使用者名稱對應後台顯示名稱，解析成真正的使用者 code。
 * 3. 依每位同仁每個所屬組織各建一列；兼任 N 個部門者顯示 N 列，每列可獨立設定。
 * 4. 每個組織卡片提供 unit_name 與 title_level 批次帶入，仍可逐列微調。
 * 5. 批次建立角色定義記錄，寫入 unit_name / title_level / holder_user / is_active。
 *
 * 【變更履歷】
 *   2026-05-01  Jimmy/Claude  unit_name / title_level 兩個下拉選項一律從
 *                              kintone.app.getFormFields() 動態讀取，
 *                              欄位未設下拉或選項為空時 SweetAlert 報錯停止流程
 *   2026-05-02  Jimmy/Claude  兼任多組織者改為每個組織各顯示一列，可獨立設定
 *   2026-05-02  Jimmy/Claude  unit_name 改為 <input list="datalist"> 可打字搜尋，送出時驗證值必須在選項內
 *   2026-05-02  Jimmy/Claude  每列加刪除按鈕；每張卡片加「＋ 新增人員」可打字搜尋後手動加列
 *   2026-05-03  Jimmy/Claude  逐卡儲存：每張卡片獨立「✓ 建立此組」，POST 新列 / PUT dirty 列，
 *                              列狀態圖示（✓已存 / ●待更新），避免整批失敗需重填
 *   2026-05-03  Jimmy/Claude  修正 CB_IL02：補上必填欄位 role_name（unit_name_title_level）
 *                              與 signing_mode；卡片批控區新增 signing_mode 下拉選單
 */
(function () {
  'use strict';

  const HOLDER_TYPE_USER =
    (window.ApprovalRouting &&
      window.ApprovalRouting.Config &&
      window.ApprovalRouting.Config.HOLDER_TYPE_OPTIONS &&
      window.ApprovalRouting.Config.HOLDER_TYPE_OPTIONS.USER) ||
    '指定個人';

  const HOLDER_TYPE_GROUP =
    (window.ApprovalRouting &&
      window.ApprovalRouting.Config &&
      window.ApprovalRouting.Config.HOLDER_TYPE_OPTIONS &&
      window.ApprovalRouting.Config.HOLDER_TYPE_OPTIONS.GROUP) ||
    '指定群組';

  const ACTIVE_VALUE =
    (window.ApprovalRouting &&
      window.ApprovalRouting.Config &&
      window.ApprovalRouting.Config.CHECKBOX &&
      window.ApprovalRouting.Config.CHECKBOX.ACTIVE) ||
    '啟用中';

  const FALLBACK_ORG_NAME = '未分配組織';
  const API_PAGE_SIZE = 100;

  let _parsedGroups = [];
  let _userDirectory = null;
  let _titleLevelOptions = [];
  let _unitNameOptions = [];
  let _allGroups = [];
  let _rowUniqueId = 10000; // 動態新增列的唯一 ID 起點，避免與 CSV 解析列的 rIdx 衝突

  const _esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const normalize = (value) =>
    String(value == null ? '' : value)
      .trim()
      .replace(/\uFEFF/g, '')
      .toLowerCase();

  const csvSplit = (line) => {
    const result = [];
    let current = '';
    let inQuote = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuote && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuote = !inQuote;
        }
      } else if (char === ',' && !inQuote) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    result.push(current.trim());
    return result.map((part) => part.replace(/^"|"$/g, '').trim());
  };

  const buildOptionsHtml = (options, selectedValue) =>
    [
      '<option value="">請選擇</option>',
      ...options.map(
        (option) =>
          `<option value="${_esc(option)}"${option === selectedValue ? ' selected' : ''}>${_esc(option)}</option>`,
      ),
    ].join('');

  const buildTitleOptionsHtml = (selectedValue) =>
    buildOptionsHtml(_titleLevelOptions, selectedValue);

  const buildUnitOptionsHtml = (selectedValue) =>
    buildOptionsHtml(_unitNameOptions, selectedValue);

  /** 產生共用 datalist（unit_name 搜尋輸入框用） */
  const buildUnitDatalist = () =>
    `<datalist id="br-unit-datalist">${_unitNameOptions.map((o) => `<option value="${_esc(o)}">`).join('')}</datalist>`;

  /** 產生人員搜尋共用 datalist（value = loginCode，文字提示為顯示名稱） */
  const buildPersonDatalist = () => {
    if (!_userDirectory || !_userDirectory.users) {
      return '<datalist id="br-person-datalist"></datalist>';
    }
    const options = _userDirectory.users
      .map((u) => `<option value="${_esc(u.code)}">${_esc(u.name)}</option>`)
      .join('');
    return `<datalist id="br-person-datalist">${options}</datalist>`;
  };

  /** 解析 kintone form field 的 options 物件 → 依 index 排序的 label 陣列 */
  function extractFieldOptions(field) {
    if (!field || !field.options || typeof field.options !== 'object') return null;
    const labels = Object.entries(field.options)
      .sort((a, b) => Number(a[1].index) - Number(b[1].index))
      .map(([, option]) => option && option.label)
      .filter(Boolean);
    return labels.length ? labels : null;
  }

  async function alertConfigError(title, html) {
    if (typeof Swal !== 'undefined' && typeof Swal.fire === 'function') {
      await Swal.fire({
        icon: 'error',
        title,
        html,
        confirmButtonText: '確定',
      });
    } else {
      // SweetAlert 沒載入時退回原生 alert
      alert(`${title}\n\n${html.replace(/<[^>]+>/g, '')}`);
    }
  }

  function formatKintoneError(error) {
    const parts = [
      error && error.message,
      error && error.code ? `code=${error.code}` : '',
      error && error.id ? `id=${error.id}` : '',
    ].filter(Boolean);
    return parts.join(' / ') || '未知錯誤';
  }

  /** 從 App 685 動態載入 unit_name / title_level 兩個下拉欄位的選項。
   *  任一欄位非下拉、或選項為空 → SweetAlert 報錯並 throw，停止後續流程。 */
  async function loadFieldOptions() {
    let formFields;
    try {
      formFields = await kintone.app.getFormFields();
    } catch (error) {
      console.error('[batch-role-creator] getFormFields error', error);
      await alertConfigError(
        '無法讀取欄位設定',
        `呼叫 <code>kintone.app.getFormFields()</code> 失敗：<br><strong>${_esc(error.message || String(error))}</strong>`,
      );
      throw new Error('讀取欄位設定失敗，請查看 SweetAlert 錯誤訊息');
    }

    const titleOptions = extractFieldOptions(formFields && formFields.title_level);
    const unitOptions  = extractFieldOptions(formFields && formFields.unit_name);

    const missing = [];
    if (!titleOptions) missing.push('title_level');
    if (!unitOptions)  missing.push('unit_name');

    if (missing.length) {
      await alertConfigError(
        'kintone 欄位設定不完整',
        `App 685 的 <strong>${missing.join('、')}</strong> 欄位未設為下拉式選單，或選項清單為空。<br>` +
        `請至 kintone 後台確認欄位類型為「下拉式選單」並維護選項後重試。`,
      );
      throw new Error(`欄位 ${missing.join('、')} 未設定下拉選項`);
    }

    _titleLevelOptions = titleOptions;
    _unitNameOptions   = unitOptions;
  }

  const showStatus = (id, type, message) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `status-box status-${type}`;
    el.textContent = message;
    el.style.display = 'block';
  };

  const hideStatus = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = 'none';
    el.textContent = '';
  };

  const injectCSS = () => {
    if (document.getElementById('batch-role-css')) return;
    const style = document.createElement('style');
    style.id = 'batch-role-css';
    style.textContent = `
      /* ── 基礎字型 ── */
      #batch-role-modal,
      #batch-role-modal * {
        font-family: "Microsoft JhengHei", "微軟正黑體", "PingFang TC", sans-serif;
        box-sizing: border-box;
      }

      /* ── 遮罩 ── */
      #batch-role-modal {
        display: none;
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,.55);
        z-index: 1000;
        overflow-y: auto;
        padding: 32px 20px;
      }

      /* ── 主容器 ── */
      #batch-role-modal-inner {
        width: min(1320px, 96%);
        margin: 0 auto;
        background: #fff;
        border-radius: 12px;
        box-shadow: 0 16px 48px rgba(0,0,0,.22);
        padding: 32px 36px;
      }

      /* ── 標題 ── */
      #batch-role-modal h2 {
        margin: 0 0 26px;
        padding-bottom: 14px;
        border-bottom: 3px solid #2980b9;
        color: #1a2b3c;
        font-size: 22px;
        font-weight: 800;
        letter-spacing: .02em;
      }

      /* ── 區塊 ── */
      #batch-role-modal .section { margin-bottom: 30px; }
      #batch-role-modal .section h3 {
        margin: 0 0 12px;
        color: #2c3e50;
        font-size: 17px;
        font-weight: 700;
      }

      /* ── Textarea ── */
      #batch-role-modal textarea {
        width: 100%;
        min-height: 130px;
        padding: 12px 14px;
        border: 1.5px solid #b2bec3;
        border-radius: 6px;
        resize: vertical;
        font-size: 15px;
        line-height: 1.7;
        transition: border-color .2s, box-shadow .2s;
      }
      #batch-role-modal textarea:focus {
        border-color: #3498db;
        outline: none;
        box-shadow: 0 0 0 3px rgba(52,152,219,.18);
      }

      /* ── 輸入框 / 下拉 ── */
      #batch-role-modal input[type="text"],
      #batch-role-modal select {
        width: 100%;
        min-width: 0;
        padding: 10px 12px;
        border: 1.5px solid #b2bec3;
        border-radius: 6px;
        font-size: 14px;
        line-height: 1.5;
        color: #2d3748;
        background: #fff;
        transition: border-color .2s, box-shadow .2s;
      }
      #batch-role-modal input[type="text"]:focus,
      #batch-role-modal select:focus {
        border-color: #3498db;
        outline: none;
        box-shadow: 0 0 0 3px rgba(52,152,219,.18);
      }

      /* ── 按鈕 ── */
      #batch-role-modal .btn {
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 15px;
        font-weight: 700;
        padding: 10px 22px;
        line-height: 1.3;
        transition: filter .15s, transform .1s;
        letter-spacing: .01em;
      }
      #batch-role-modal .btn:hover  { filter: brightness(1.08); }
      #batch-role-modal .btn:active { transform: scale(.97); }
      #batch-role-modal .btn:disabled { opacity: .5; cursor: not-allowed; transform: none; filter: none; }
      #batch-role-modal .btn-sm { padding: 7px 14px; font-size: 13px; }
      #batch-role-modal .btn-primary   { background: #2980b9; color: #fff; }
      #batch-role-modal .btn-success   { background: #27ae60; color: #fff; }
      #batch-role-modal .btn-secondary { background: #dfe6e9; color: #2d3436; border: 1px solid #b2bec3; }
      #batch-role-modal .btn-danger    { background: #e74c3c; color: #fff; }

      /* ── 說明文字 ── */
      #batch-role-modal .helper-text {
        color: #4a5568;
        font-size: 14px;
        line-height: 1.75;
        margin: 0 0 12px;
      }
      #batch-role-modal .toolbar {
        display: flex;
        align-items: center;
        gap: 14px;
        flex-wrap: wrap;
      }

      /* ── 組織卡片 ── */
      .org-card {
        border: 1px solid #d0d7de;
        border-left: 5px solid #2980b9;
        border-radius: 10px;
        overflow: hidden;
        margin-bottom: 22px;
        background: #fff;
        box-shadow: 0 3px 10px rgba(0,0,0,.07);
      }
      .org-header {
        padding: 18px 22px;
        background: linear-gradient(135deg, #f8fafc 0%, #eef2f7 100%);
        border-bottom: 1px solid #d0d7de;
      }
      .org-header-top {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        margin-bottom: 16px;
        flex-wrap: wrap;
      }
      .org-header-title {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 18px;
        font-weight: 800;
        color: #1a2b3c;
        letter-spacing: .01em;
      }
      .badge {
        border-radius: 999px;
        background: #2980b9;
        color: #fff;
        padding: 3px 11px;
        font-size: 12px;
        font-weight: 600;
      }
      .org-bulk-controls {
        display: grid;
        grid-template-columns: minmax(240px, 1.2fr) minmax(200px, 1fr) auto;
        gap: 14px;
        align-items: end;
      }
      .field-label {
        display: block;
        margin-bottom: 5px;
        color: #4a5568;
        font-size: 13px;
        font-weight: 700;
      }

      /* ── 表格 ── */
      .org-table { width: 100%; border-collapse: collapse; }
      .org-table th {
        padding: 13px 16px;
        border-bottom: 2px solid #d0d7de;
        color: #4a5568;
        font-size: 13px;
        font-weight: 700;
        background: #f7f9fc;
        white-space: nowrap;
        text-align: left;
        letter-spacing: .02em;
      }
      .org-table td {
        padding: 13px 16px;
        border-bottom: 1px solid #edf0f4;
        vertical-align: middle;
        text-align: left;
      }
      .org-table tr:last-child td { border-bottom: none; }
      .org-table tbody tr:hover td { background: #f0f6ff; }

      /* ── 人員欄 ── */
      .person-name {
        color: #1a2b3c;
        font-weight: 800;
        font-size: 15px;
      }
      .person-meta {
        color: #6b7280;
        font-size: 13px;
        margin-top: 5px;
        line-height: 1.65;
      }

      /* ── role_name 預覽 ── */
      .row-preview {
        display: inline-block;
        background: #fffbeb;
        border: 1.5px solid #f0c040;
        border-radius: 5px;
        padding: 5px 10px;
        color: #7b4f00;
        font-family: Consolas, "Courier New", monospace;
        font-size: 13px;
        font-weight: 700;
        white-space: nowrap;
        max-width: 220px;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* ── Holder 欄 ── */
      .holder-target   { display: flex; flex-direction: column; gap: 6px; }
      .holder-person {
        padding: 9px 12px;
        border: 1.5px solid #e5e7eb;
        border-radius: 6px;
        background: #f9fafb;
        line-height: 1;
      }
      .hp-name {
        font-size: 14px;
        font-weight: 700;
        color: #1a2b3c;
        line-height: 1.4;
        word-break: break-word;
      }
      .hp-code {
        font-size: 12px;
        color: #6b7280;
        margin-top: 4px;
        font-weight: 400;
      }
      .hp-placeholder {
        font-size: 13px;
        color: #9ca3af;
        font-weight: 400;
      }
      .holder-group-filter,
      .holder-group-select { width: 100%; }
      .holder-hint  { color: #9ca3af; font-size: 12px; line-height: 1.5; }
      .holder-lock  { display: inline-flex; align-items: center; gap: 6px; color: #374151; font-size: 13px; font-weight: 600; }

      /* ── 狀態提示條 ── */
      .status-box {
        margin-top: 14px;
        padding: 14px 18px;
        border-radius: 8px;
        display: none;
        font-size: 15px;
        line-height: 1.65;
        font-weight: 500;
      }
      .status-success { display: block !important; background: #d1fae5; border: 1.5px solid #6ee7b7; color: #064e3b; }
      .status-error   { display: block !important; background: #fee2e2; border: 1.5px solid #fca5a5; color: #7f1d1d; }
      .status-info    { display: block !important; background: #e0f2fe; border: 1.5px solid #7dd3fc; color: #0c4a6e; }

      /* ── 新增人員列資訊 ── */
      .new-row-person-info {
        font-size: 13px;
        margin-top: 5px;
        line-height: 1.5;
        font-weight: 600;
      }

      /* ── 列儲存狀態圖示 ── */
      .row-save-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        font-size: 12px;
        font-weight: 700;
        vertical-align: middle;
        margin-right: 4px;
        transition: background .25s;
      }
      .row-save-icon.rsi-saved { background: #10b981; color: #fff; }
      .row-save-icon.rsi-dirty { background: #f59e0b; color: #fff; }

      /* ── 卡片儲存狀態文字 ── */
      .card-save-status { font-size: 13px; font-weight: 600; }

      /* ── 索引頁入口按鈕 ── */
      #btn-open-batch-role {
        margin-left: 16px;
        background: #2980b9;
        color: #fff;
        border: none;
        border-radius: 6px;
        padding: 0 22px;
        height: 48px;
        cursor: pointer;
        font-size: 15px;
        font-weight: 700;
        letter-spacing: .02em;
      }
      #btn-open-batch-role:hover { background: #1e6fa5; }

      /* ── 手機版收合 ── */
      @media (max-width: 960px) {
        #batch-role-modal-inner { padding: 20px 16px; }
        .org-bulk-controls { grid-template-columns: 1fr; }
        .org-table th:nth-child(n+4),
        .org-table td:nth-child(n+4) { display: none; }
      }
    `;
    document.head.appendChild(style);
  };

  const injectModal = () => {
    if (document.getElementById('batch-role-modal')) return;

    const modalHTML = `
      <div id="batch-role-modal">
        <div id="batch-role-modal-inner">
          <h2>批次角色建立（依組織卡片帶入）</h2>

          <div class="section">
            <h3>1. 匯入 CSV</h3>
            <p class="helper-text">
              支援欄位：<code>登入帳號</code>、<code>使用者名稱</code>、<code>title_level</code>，
              也相容舊版 <code>code,title</code>。程式會用「登入帳號 -> 後台登入名稱」、
              「使用者名稱 -> 後台顯示名稱」做比對，解析成真正的使用者資料。
            </p>
            <textarea id="br-csvInput" placeholder="登入帳號,使用者名稱,title_level&#10;wangdm,王大明,課長&#10;linamy,林小美,次長"></textarea>
            <div class="toolbar" style="margin-top:12px;">
              <button class="btn btn-primary" id="br-btn-parse">解析 CSV 並載入組織</button>
              <span style="color:#999;">或直接選擇檔案</span>
              <input type="file" id="br-csvFile" accept=".csv,.txt" />
            </div>
            <div id="br-parse-status" class="status-box status-info"></div>
          </div>

          <div class="section" id="br-sec-table" style="display:none;">
            <h3>2. 卡片分組與批次帶入</h3>
            <p class="helper-text">
              每張卡片代表一個部門。同仁兼任 N 個部門 → 出現在 N 張卡片各一列，可分別設定不同的
              <code>unit_name</code> 與 <code>title_level</code>；卡片上方可批次帶入，底下仍可逐列微調。
            </p>
            <div id="br-groups-container"></div>

            <div style="margin-top:24px; padding-top:16px; border-top:1px solid #eee; text-align:right;">
              <button class="btn btn-secondary" id="br-btn-close">關閉</button>
              <button class="btn btn-success" id="br-btn-submit">建立角色記錄</button>
            </div>
            <div id="br-submit-status" class="status-box"></div>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);
    bindEvents();
  };

  async function fetchAllUsers() {
    if (_userDirectory) return _userDirectory;

    const users = [];
    let offset = 0;

    while (true) {
      const resp = await kintone.api(kintone.api.url('/v1/users.json', true), 'GET', {
        offset,
        size: API_PAGE_SIZE,
      });

      const batch = Array.isArray(resp.users) ? resp.users : [];
      users.push(...batch);
      if (batch.length < API_PAGE_SIZE) break;
      offset += API_PAGE_SIZE;
    }

    const byCode = new Map();
    const byName = new Map();

    users.forEach((user) => {
      const codeKey = normalize(user.code);
      const nameKey = normalize(user.name);
      if (codeKey && !byCode.has(codeKey)) byCode.set(codeKey, user);
      if (nameKey && !byName.has(nameKey)) byName.set(nameKey, user);
    });

    _userDirectory = { users, byCode, byName };
    return _userDirectory;
  }

  async function fetchAllGroups() {
    if (_allGroups.length) return _allGroups;

    const groups = [];
    let offset = 0;

    while (true) {
      const resp = await kintone.api(kintone.api.url('/v1/groups.json', true), 'GET', {
        offset,
        size: API_PAGE_SIZE,
      });

      const batch = Array.isArray(resp.groups) ? resp.groups : [];
      groups.push(
        ...batch.map((group) => ({
          code: String(group.code || '').trim(),
          name: String(group.name || '').trim(),
          id: String(group.id || '').trim(),
        })),
      );

      if (batch.length < API_PAGE_SIZE) break;
      offset += API_PAGE_SIZE;
    }

    _allGroups = groups
      .filter((group) => group.code && group.name)
      .sort((a, b) => {
        const nameCompare = a.name.localeCompare(b.name, 'zh-Hant');
        if (nameCompare !== 0) return nameCompare;
        return a.code.localeCompare(b.code);
      });

    return _allGroups;
  }

  async function fetchUserOrgs(code) {
    try {
      const resp = await kintone.api(
        kintone.api.url('/v1/user/organizations.json', true),
        'GET',
        { code },
      );

      const names = (resp.organizationTitles || [])
        .map((item) => item && item.organization && item.organization.name)
        .filter(Boolean);

      return names.length ? Array.from(new Set(names)).sort() : [FALLBACK_ORG_NAME];
    } catch (error) {
      console.warn(`[batch-role-creator] fetchUserOrgs failed for ${code}`, error);
      return [FALLBACK_ORG_NAME];
    }
  }

  function parseCSVRows(raw) {
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (!lines.length) return [];

    const headerCells = csvSplit(lines[0]).map(normalize);
    const hasHeader = headerCells.some((cell) =>
      [
        '登入帳號',
        '登录帐号',
        '登入名稱',
        '登录名称',
        '使用者名稱',
        '使用者名称',
        '显示名称',
        '顯示名稱',
        'code',
        'title',
        'title_level',
      ].includes(cell),
    );

    const indexOfAny = (names) =>
      headerCells.findIndex((cell) => names.includes(cell));

    const accountIndex = hasHeader
      ? indexOfAny(['登入帳號', '登录帐号', '登入名稱', '登录名称', 'code'])
      : 0;
    const nameIndex = hasHeader
      ? indexOfAny(['使用者名稱', '使用者名称', '顯示名稱', '显示名称', 'name'])
      : -1;
    const titleIndex = hasHeader
      ? indexOfAny(['title_level', 'title', '職稱', '职称'])
      : 1;

    const dataLines = hasHeader ? lines.slice(1) : lines;

    return dataLines
      .map((line) => {
        const cells = csvSplit(line);
        const loginAccount =
          accountIndex >= 0 ? normalize(cells[accountIndex] || '') : '';
        const displayName = nameIndex >= 0 ? String(cells[nameIndex] || '').trim() : '';
        const titleLevel = titleIndex >= 0 ? String(cells[titleIndex] || '').trim() : '';

        return {
          loginAccount,
          displayName,
          titleLevel,
          rawLine: line,
        };
      })
      .filter((row) => row.loginAccount || row.displayName);
  }

  function resolveCsvUser(row, directory) {
    const byCodeUser = row.loginAccount
      ? directory.byCode.get(normalize(row.loginAccount))
      : null;
    const byNameUser = row.displayName
      ? directory.byName.get(normalize(row.displayName))
      : null;

    if (byCodeUser && byNameUser) {
      if (normalize(byCodeUser.code) === normalize(byNameUser.code)) return byCodeUser;
      throw new Error(
        `CSV 資料不一致：登入帳號「${row.loginAccount}」對到 ${byCodeUser.name}，但使用者名稱「${row.displayName}」對到 ${byNameUser.code}。`,
      );
    }

    if (byCodeUser) return byCodeUser;
    if (byNameUser) return byNameUser;

    const accountText = row.loginAccount || '空白';
    const nameText = row.displayName || '空白';
    throw new Error(
      `找不到使用者：登入帳號「${accountText}」、使用者名稱「${nameText}」都無法對應到後台使用者。`,
    );
  }

  async function parseCSVAndFetchOrgs() {
    const raw = document.getElementById('br-csvInput').value.trim().replace(/^\uFEFF/, '');
    if (!raw) {
      alert('請先貼上 CSV 內容。');
      return;
    }

    const rows = parseCSVRows(raw);
    if (!rows.length) {
      alert('CSV 沒有可解析的資料列。');
      return;
    }

    const statusEl = document.getElementById('br-parse-status');
    const parseBtn = document.getElementById('br-btn-parse');
    const submitStatusId = 'br-submit-status';
    parseBtn.disabled = true;
    showStatus('br-parse-status', 'info', '開始解析 CSV...');
    hideStatus(submitStatusId);

    try {
      await loadFieldOptions();
      const directory = await fetchAllUsers();
      await fetchAllGroups();
      const resolvedUsers = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        statusEl.textContent = `解析使用者與組織中... (${i + 1}/${rows.length})`;

        const user = resolveCsvUser(row, directory);
        const allOrgs = await fetchUserOrgs(user.code);

        // 每個所屬組織建立獨立一列，兼任 N 個單位 → N 行可分別設定
        for (const singleOrg of allOrgs) {
          resolvedUsers.push({
            code: user.code,
            loginAccount: user.code,
            displayName: user.name || row.displayName || user.code,
            titleLevel: row.titleLevel,
            allOrgs,
            groupKey: singleOrg,
          });
        }
      }

      const dedupedMap = new Map();
      resolvedUsers.forEach((user) => {
        const key = `${normalize(user.code)}|${normalize(user.groupKey)}`;
        if (!dedupedMap.has(key)) dedupedMap.set(key, user);
      });

      const groupMap = new Map();
      dedupedMap.forEach((user) => {
        if (!groupMap.has(user.groupKey)) {
          groupMap.set(user.groupKey, {
            orgName: user.groupKey,
            users: [],
          });
        }
        groupMap.get(user.groupKey).users.push(user);
      });

      _parsedGroups = Array.from(groupMap.values())
        .map((group) => ({
          orgName: group.orgName,
          users: group.users.sort((a, b) => {
            const nameCompare = a.displayName.localeCompare(b.displayName, 'zh-Hant');
            if (nameCompare !== 0) return nameCompare;
            return a.code.localeCompare(b.code);
          }),
        }))
        .sort((a, b) => a.orgName.localeCompare(b.orgName, 'zh-Hant'));

      renderGroupsUI();
      hideStatus('br-parse-status');
    } catch (error) {
      console.error('[batch-role-creator] parseCSVAndFetchOrgs error', error);
      showStatus('br-parse-status', 'error', error.message || 'CSV 解析失敗。');
      document.getElementById('br-sec-table').style.display = 'none';
      _parsedGroups = [];
    } finally {
      parseBtn.disabled = false;
    }
  }

  function renderGroupsUI() {
    const container = document.getElementById('br-groups-container');
    container.innerHTML = '';

    // 注入共用 datalist（unit_name / 人員搜尋用，選項於 loadFieldOptions / fetchAllUsers 完成後可用）
    container.insertAdjacentHTML('beforeend', buildUnitDatalist());
    container.insertAdjacentHTML('beforeend', buildPersonDatalist());

    _parsedGroups.forEach((group, gIdx) => {
      const rowsHtml = group.users
        .map(
          (user, rIdx) => `
            <tr class="br-data-row" data-gidx="${gIdx}" data-ridx="${rIdx}" data-code="${_esc(user.code)}">
              <td>
                <div class="person-name">${_esc(user.displayName)}</div>
                <div class="person-meta">
                  登入帳號：${_esc(user.loginAccount)}<br>
                  組織：${_esc(user.groupKey)}${user.allOrgs.length > 1 ? `<br><span style="opacity:.65;">（兼任 ${user.allOrgs.length} 個單位）</span>` : ''}
                </div>
              </td>
              <td>
                <input
                  type="text"
                  list="br-unit-datalist"
                  class="row-unit-select"
                  data-gidx="${gIdx}"
                  data-ridx="${rIdx}"
                  placeholder="輸入搜尋…"
                  autocomplete="off"
                >
              </td>
              <td>
                <select class="row-title-select" data-gidx="${gIdx}" data-ridx="${rIdx}">
                  ${buildTitleOptionsHtml(user.titleLevel)}
                </select>
              </td>
              <td>
                <select class="row-holder-type-select" data-gidx="${gIdx}" data-ridx="${rIdx}">
                  <option value="${_esc(HOLDER_TYPE_USER)}" selected>${_esc(HOLDER_TYPE_USER)}</option>
                  <option value="${_esc(HOLDER_TYPE_GROUP)}">${_esc(HOLDER_TYPE_GROUP)}</option>
                </select>
              </td>
              <td>
                <div class="holder-target">
                  <div
                    class="holder-person"
                    data-role="holder-person"
                    data-gidx="${gIdx}"
                    data-ridx="${rIdx}"
                  >
                    <div class="hp-name">${_esc(user.displayName)}</div>
                    <div class="hp-code">${_esc(user.loginAccount)}</div>
                  </div>
                  <div
                    class="holder-group-wrapper"
                    data-role="holder-group-wrapper"
                    data-gidx="${gIdx}"
                    data-ridx="${rIdx}"
                    style="display:none;"
                  >
                    <input
                      type="text"
                      class="holder-group-filter"
                      data-gidx="${gIdx}"
                      data-ridx="${rIdx}"
                      placeholder="輸入幾個字搜尋群組"
                    >
                    <select
                      class="holder-group-select"
                      data-gidx="${gIdx}"
                      data-ridx="${rIdx}"
                    >
                      <option value="">請選擇群組</option>
                    </select>
                    <div class="holder-hint">搜尋只用來篩選；實際 holder 必須從下拉選單選取，不能手寫。</div>
                  </div>
                </div>
              </td>
              <td>
                <code class="row-preview" id="preview-${gIdx}-${rIdx}">_</code>
              </td>
              <td style="white-space:nowrap;">
                <span class="row-save-icon" title="未儲存"></span>
                <button class="btn btn-danger btn-sm row-delete-btn" type="button" title="刪除此列">✕</button>
              </td>
            </tr>
          `,
        )
        .join('');

      const cardHtml = `
        <div class="org-card" id="org-card-${gIdx}">
          <div class="org-header">
            <div class="org-header-top">
              <div class="org-header-title">
                ${_esc(group.orgName)}
                <span class="badge">${group.users.length} 人</span>
              </div>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <span class="card-save-status" id="card-status-${gIdx}" style="font-size:12px;"></span>
                <button class="btn btn-success btn-sm br-save-card" data-gidx="${gIdx}" type="button">✓ 建立此組</button>
                <button class="btn btn-primary btn-sm br-add-person" data-gidx="${gIdx}" type="button">＋ 新增人員</button>
              </div>
            </div>
            <div class="org-bulk-controls">
              <div>
                <label class="field-label" for="bulk-unit-${gIdx}">unit_name</label>
                <input
                  type="text"
                  id="bulk-unit-${gIdx}"
                  list="br-unit-datalist"
                  class="bulk-unit-select"
                  data-gidx="${gIdx}"
                  placeholder="輸入搜尋…"
                  autocomplete="off"
                >
              </div>
              <div>
                <label class="field-label" for="bulk-title-${gIdx}">title_level</label>
                <select id="bulk-title-${gIdx}" class="bulk-title-select" data-gidx="${gIdx}">
                  ${buildTitleOptionsHtml('')}
                </select>
              </div>
              <div>
                <label class="field-label" for="bulk-signing-${gIdx}">signing_mode</label>
                <select id="bulk-signing-${gIdx}" class="bulk-signing-select" data-gidx="${gIdx}">
                  <option value="任一人簽" selected>任一人簽</option>
                  <option value="全員會簽">全員會簽</option>
                </select>
              </div>
              <div>
                <button class="btn btn-primary br-apply-group" data-gidx="${gIdx}">套用全組</button>
              </div>
            </div>
          </div>
          <table class="org-table">
            <thead>
              <tr>
                <th style="width:30%;">人員</th>
                <th style="width:13%;">unit_name</th>
                <th style="width:11%;">title_level</th>
                <th style="width:11%;">holder_type</th>
                <th style="width:17%;">holder</th>
                <th style="width:10%;">role_name 預覽</th>
                <th style="width:5%;"></th>
              </tr>
            </thead>
            <tbody id="org-tbody-${gIdx}">
              ${rowsHtml}
            </tbody>
          </table>
        </div>
      `;

      container.insertAdjacentHTML('beforeend', cardHtml);
    });

    document.getElementById('br-sec-table').style.display = _parsedGroups.length
      ? 'block'
      : 'none';

    bindGroupRowEvents();
    _parsedGroups.forEach((_, gIdx) => updateOrgPreview(gIdx));
  }

  /** 建立「新增人員」空白列 HTML（人員欄為搜尋輸入框） */
  function buildNewPersonRowHtml(gIdx) {
    const rId = _rowUniqueId++;
    return `
      <tr class="br-data-row" data-gidx="${gIdx}" data-ridx="${rId}" data-code="">
        <td>
          <input
            type="text"
            list="br-person-datalist"
            class="row-person-search"
            data-gidx="${gIdx}"
            data-ridx="${rId}"
            placeholder="輸入姓名或登入帳號搜尋"
            autocomplete="off"
          >
          <div class="new-row-person-info" data-gidx="${gIdx}" data-ridx="${rId}"></div>
        </td>
        <td>
          <input
            type="text"
            list="br-unit-datalist"
            class="row-unit-select"
            data-gidx="${gIdx}"
            data-ridx="${rId}"
            placeholder="輸入搜尋…"
            autocomplete="off"
          >
        </td>
        <td>
          <select class="row-title-select" data-gidx="${gIdx}" data-ridx="${rId}">
            ${buildTitleOptionsHtml('')}
          </select>
        </td>
        <td>
          <select class="row-holder-type-select" data-gidx="${gIdx}" data-ridx="${rId}">
            <option value="${_esc(HOLDER_TYPE_USER)}" selected>${_esc(HOLDER_TYPE_USER)}</option>
            <option value="${_esc(HOLDER_TYPE_GROUP)}">${_esc(HOLDER_TYPE_GROUP)}</option>
          </select>
        </td>
        <td>
          <div class="holder-target">
            <div class="holder-person" data-role="holder-person" data-gidx="${gIdx}" data-ridx="${rId}">
              <div class="hp-placeholder">（選人後自動填入）</div>
            </div>
            <div class="holder-group-wrapper" data-role="holder-group-wrapper" data-gidx="${gIdx}" data-ridx="${rId}" style="display:none;">
              <input type="text" class="holder-group-filter" data-gidx="${gIdx}" data-ridx="${rId}" placeholder="輸入幾個字搜尋群組">
              <select class="holder-group-select" data-gidx="${gIdx}" data-ridx="${rId}">
                <option value="">請選擇群組</option>
              </select>
              <div class="holder-hint">搜尋只用來篩選；實際 holder 必須從下拉選單選取，不能手寫。</div>
            </div>
          </div>
        </td>
        <td>
          <code class="row-preview" id="preview-${gIdx}-${rId}">_</code>
        </td>
        <td style="white-space:nowrap;">
          <span class="row-save-icon" title="未儲存"></span>
          <button class="btn btn-danger btn-sm row-delete-btn" type="button" title="刪除此列">✕</button>
        </td>
      </tr>
    `;
  }

  /** 處理人員搜尋輸入：比對 _userDirectory，更新 data-code 及顯示確認/錯誤訊息 */
  function handlePersonSearch(gIdx, rIdx, value) {
    const tr = document.querySelector(`tr.br-data-row[data-gidx="${gIdx}"][data-ridx="${rIdx}"]`);
    const infoDiv = document.querySelector(`.new-row-person-info[data-gidx="${gIdx}"][data-ridx="${rIdx}"]`);
    const holderPersonEl = document.querySelector(`[data-role="holder-person"][data-gidx="${gIdx}"][data-ridx="${rIdx}"]`);

    if (!_userDirectory) return;

    const term = normalize(value);
    if (!term) {
      if (tr) tr.dataset.code = '';
      if (infoDiv) { infoDiv.textContent = ''; infoDiv.style.color = ''; }
      if (holderPersonEl) holderPersonEl.innerHTML = '<div class="hp-placeholder">（選人後自動填入）</div>';
      return;
    }

    const user = _userDirectory.byCode.get(term) || _userDirectory.byName.get(term);
    if (user) {
      if (tr) tr.dataset.code = user.code;
      if (infoDiv) {
        infoDiv.style.color = '#27ae60';
        infoDiv.textContent = `✓ ${user.name}（${user.code}）`;
      }
      if (holderPersonEl) {
        holderPersonEl.innerHTML =
          `<div class="hp-name">${_esc(user.name)}</div><div class="hp-code">${_esc(user.code)}</div>`;
      }
    } else {
      if (tr) tr.dataset.code = '';
      if (infoDiv) {
        infoDiv.style.color = '#e74c3c';
        infoDiv.textContent = '找不到使用者，請從建議清單選取';
      }
      if (holderPersonEl) holderPersonEl.innerHTML = '<div class="hp-placeholder">（選人後自動填入）</div>';
    }
  }

  /** 綁定單一列的所有事件（初始列 & 動態新增列共用） */
  function bindSingleRowEvents(tr) {
    const gIdx = tr.dataset.gidx;
    const rIdx = tr.dataset.ridx;

    const unitInput = tr.querySelector('.row-unit-select');
    if (unitInput) {
      unitInput.addEventListener('input', () => {
        markRowDirty(tr);
        updateSinglePreview(gIdx, rIdx);
      });
    }

    const titleSelect = tr.querySelector('.row-title-select');
    if (titleSelect) {
      titleSelect.addEventListener('change', () => {
        markRowDirty(tr);
        updateSinglePreview(gIdx, rIdx);
      });
    }

    const holderTypeSelect = tr.querySelector('.row-holder-type-select');
    if (holderTypeSelect) {
      holderTypeSelect.addEventListener('change', () => {
        markRowDirty(tr);
        toggleHolderTarget(gIdx, rIdx);
      });
    }

    const groupFilter = tr.querySelector('.holder-group-filter');
    if (groupFilter) {
      const refresh = () => refreshGroupOptions(gIdx, rIdx, groupFilter.value);
      groupFilter.addEventListener('focus', refresh);
      groupFilter.addEventListener('input', refresh);
    }

    const groupSelect = tr.querySelector('.holder-group-select');
    if (groupSelect) {
      groupSelect.addEventListener('focus', () => {
        const filter = tr.querySelector('.holder-group-filter');
        refreshGroupOptions(gIdx, rIdx, filter ? filter.value : '');
      });
    }

    const personSearch = tr.querySelector('.row-person-search');
    if (personSearch) {
      personSearch.addEventListener('input', (e) => handlePersonSearch(gIdx, rIdx, e.target.value));
    }

    const deleteBtn = tr.querySelector('.row-delete-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => tr.remove());
    }

    toggleHolderTarget(gIdx, rIdx);
  }

  /** 向指定 gIdx 卡片的 tbody 末端插入一列空白人員列，並綁定事件 */
  function addPersonRow(gIdx) {
    const tbody = document.getElementById(`org-tbody-${gIdx}`);
    if (!tbody) return;
    tbody.insertAdjacentHTML('beforeend', buildNewPersonRowHtml(gIdx));
    const lastTr = tbody.querySelector('tr.br-data-row:last-child');
    if (lastTr) {
      bindSingleRowEvents(lastTr);
      const searchInput = lastTr.querySelector('.row-person-search');
      if (searchInput) searchInput.focus();
    }
  }

  function bindGroupRowEvents() {
    // 列級事件統一由 bindSingleRowEvents 處理（初始列 & 動態新增列共用邏輯）
    document.querySelectorAll('tr.br-data-row').forEach(bindSingleRowEvents);

    // 卡片級：批次帶入 unit_name 輸入時重置按鈕文字
    document.querySelectorAll('.bulk-unit-select').forEach((input) => {
      input.addEventListener('input', (event) => {
        const gIdx = event.target.dataset.gidx;
        const button = document.querySelector(`.br-apply-group[data-gidx="${gIdx}"]`);
        if (button) button.textContent = '套用全組';
      });
    });

    // 卡片級：批次帶入 title_level 切換時重置按鈕文字
    document.querySelectorAll('.bulk-title-select').forEach((select) => {
      select.addEventListener('change', (event) => {
        const gIdx = event.target.dataset.gidx;
        const button = document.querySelector(`.br-apply-group[data-gidx="${gIdx}"]`);
        if (button) button.textContent = '套用全組';
      });
    });

    // 卡片級：套用全組
    document.querySelectorAll('.br-apply-group').forEach((button) => {
      button.addEventListener('click', (event) => applyBulkToGroup(event.currentTarget.dataset.gidx));
    });

    // 卡片級：新增人員列
    document.querySelectorAll('.br-add-person').forEach((btn) => {
      btn.addEventListener('click', (event) => addPersonRow(event.currentTarget.dataset.gidx));
    });

    // 卡片級：建立/更新此組
    document.querySelectorAll('.br-save-card').forEach((btn) => {
      btn.addEventListener('click', (event) => saveCard(event.currentTarget.dataset.gidx));
    });
  }

  function getGroupOptionLabel(group) {
    return group.name;
  }

  function findGroupByLabelOrCode(value) {
    const normalizedValue = normalize(value);
    if (!normalizedValue) return null;

    return (
      _allGroups.find((group) => normalize(group.code) === normalizedValue) ||
      _allGroups.find((group) => normalize(getGroupOptionLabel(group)) === normalizedValue) ||
      _allGroups.find((group) => normalize(group.name) === normalizedValue) ||
      null
    );
  }

  function refreshGroupOptions(gIdx, rIdx, keyword) {
    const select = document.querySelector(
      `.holder-group-select[data-gidx="${gIdx}"][data-ridx="${rIdx}"]`,
    );
    if (!select) return;

    const term = normalize(keyword);
    const matchedGroups = _allGroups
      .filter((group) => {
        if (!term) return true;
        return (
          normalize(group.name).includes(term) || normalize(group.code).includes(term)
        );
      })
      .slice(0, 30);

    const currentValue = select.value;
    select.innerHTML = [
      '<option value="">請選擇群組</option>',
      ...matchedGroups.map(
        (group) =>
          `<option value="${_esc(group.code)}"${group.code === currentValue ? ' selected' : ''}>${_esc(getGroupOptionLabel(group))}</option>`,
      ),
    ].join('');

    if (currentValue && !matchedGroups.some((group) => group.code === currentValue)) {
      const selectedGroup = _allGroups.find((group) => group.code === currentValue);
      if (selectedGroup) {
        select.innerHTML += `<option value="${_esc(selectedGroup.code)}" selected>${_esc(getGroupOptionLabel(selectedGroup))}</option>`;
      } else {
        select.value = '';
      }
    }
  }

  function toggleHolderTarget(gIdx, rIdx) {
    const holderTypeSelect = document.querySelector(
      `.row-holder-type-select[data-gidx="${gIdx}"][data-ridx="${rIdx}"]`,
    );
    const personEl = document.querySelector(
      `[data-role="holder-person"][data-gidx="${gIdx}"][data-ridx="${rIdx}"]`,
    );
    const groupWrapper = document.querySelector(
      `[data-role="holder-group-wrapper"][data-gidx="${gIdx}"][data-ridx="${rIdx}"]`,
    );
    const groupFilterInput = document.querySelector(
      `.holder-group-filter[data-gidx="${gIdx}"][data-ridx="${rIdx}"]`,
    );
    const groupSelect = document.querySelector(
      `.holder-group-select[data-gidx="${gIdx}"][data-ridx="${rIdx}"]`,
    );

    if (!holderTypeSelect || !personEl || !groupWrapper) return;

    const isGroup = holderTypeSelect.value === HOLDER_TYPE_GROUP;
    personEl.style.display = isGroup ? 'none' : 'block';
    groupWrapper.style.display = isGroup ? 'block' : 'none';

    if (isGroup) {
      refreshGroupOptions(gIdx, rIdx, groupFilterInput ? groupFilterInput.value : '');
    }

    if (!isGroup) {
      if (groupFilterInput) groupFilterInput.value = '';
      if (groupSelect) groupSelect.value = '';
    }
  }

  function applyBulkToGroup(gIdx) {
    const bulkUnit = document.getElementById(`bulk-unit-${gIdx}`);
    const bulkTitle = document.getElementById(`bulk-title-${gIdx}`);
    const rows = document.querySelectorAll(`tr.br-data-row[data-gidx="${gIdx}"]`);

    rows.forEach((row) => {
      const unitSelect = row.querySelector('.row-unit-select');
      const titleSelect = row.querySelector('.row-title-select');
      if (unitSelect && bulkUnit.value) unitSelect.value = bulkUnit.value;
      if (titleSelect && bulkTitle.value) titleSelect.value = bulkTitle.value;
    });

    updateOrgPreview(gIdx);
    const button = document.querySelector(`.br-apply-group[data-gidx="${gIdx}"]`);
    if (button) button.textContent = '已套用';
  }

  function updateOrgPreview(gIdx) {
    const rows = document.querySelectorAll(`tr.br-data-row[data-gidx="${gIdx}"]`);
    rows.forEach((row) => {
      updateSinglePreview(gIdx, row.dataset.ridx);
    });
  }

  function updateSinglePreview(gIdx, rIdx) {
    const unitSelect = document.querySelector(
      `.row-unit-select[data-gidx="${gIdx}"][data-ridx="${rIdx}"]`,
    );
    const titleSelect = document.querySelector(
      `.row-title-select[data-gidx="${gIdx}"][data-ridx="${rIdx}"]`,
    );
    const previewCode = document.getElementById(`preview-${gIdx}-${rIdx}`);

    if (!unitSelect || !titleSelect || !previewCode) return;

    const unitValue = unitSelect.value.trim();
    const titleValue = titleSelect.value.trim();
    const roleName =
      unitValue && titleValue
        ? `${unitValue}_${titleValue}`
        : unitValue || titleValue || '(尚未填寫)';

    previewCode.textContent = roleName;
  }

  /**
   * 查出 App 685 現有 role_id 裡最大的流水號（符合 ROLE_\d+ 格式）。
   * 只計純數字後綴；舊格式（含時間戳）一律忽略，不影響序號。
   */
  async function fetchMaxRoleNum() {
    const appId = kintone.app.getId();
    console.log('[batch-role-creator] fetchMaxRoleNum appId:', appId);
    if (!appId) throw new Error('kintone.app.getId() 回傳 null，請確認此 JS 已上傳至 App 685 的「自訂設定」');
    let maxNum = 0;
    const params = {
      app: appId,
      fields: ['role_id'],
      query: 'order by role_id desc limit 500',
    };
    let resp;
    try {
      resp = await kintone.api(kintone.api.url('/k/v1/records', true), 'GET', params);
    } catch (error) {
      console.error('[batch-role-creator] fetchMaxRoleNum records API error', { params, error });
      throw new Error(`讀取既有 role_id 失敗：${formatKintoneError(error)}。已改用與 01-role-form-init.js 相同的查詢格式，若仍失敗，請檢查 App 685 是否有「未套用表單變更」或 role_id 是否可用於排序。`);
    }
    const batch = Array.isArray(resp.records) ? resp.records : [];
    batch.forEach((r) => {
      const val = (r.role_id && r.role_id.value) || '';
      if (/^ROLE_\d+$/.test(val)) {
        const num = parseInt(val.slice(5), 10);
        if (num > maxNum) maxNum = num;
      }
    });
    return maxNum;
  }

  /** 從 startNum 開始產生 count 個流水號，格式 ROLE_0001 / ROLE_0002 … */
  function generateRoleIds(count, startNum) {
    return Array.from(
      { length: count },
      (_, i) => `ROLE_${String(startNum + i).padStart(4, '0')}`,
    );
  }

  /** 驗證單一列的欄位完整性，不合法時 throw Error */
  function validateRow(row) {
    const code = row.dataset.code;
    const nameEl = row.querySelector('.person-name');
    const unitSelect = row.querySelector('.row-unit-select');
    const titleSelect = row.querySelector('.row-title-select');
    const holderTypeSelect = row.querySelector('.row-holder-type-select');
    const unitName = unitSelect ? unitSelect.value.trim() : '';
    const titleLevel = titleSelect ? titleSelect.value.trim() : '';
    const holderType = holderTypeSelect ? holderTypeSelect.value : HOLDER_TYPE_USER;
    const nameDisplay = nameEl ? nameEl.textContent.trim() : code || '新增人員';

    if (holderType === HOLDER_TYPE_USER && !code) {
      throw new Error(`「${nameDisplay}」尚未完成人員選取，請從搜尋清單選取使用者。`);
    }
    if (!unitName) {
      throw new Error(`「${nameDisplay}」的 unit_name 尚未填寫。`);
    }
    if (!_unitNameOptions.includes(unitName)) {
      throw new Error(`「${nameDisplay}」的 unit_name「${unitName}」不在選項清單中，請從建議清單選取。`);
    }
    if (!titleLevel) {
      throw new Error(`「${nameDisplay}」的 title_level 尚未選擇。`);
    }
  }

  /** 從單一列 DOM 建構 kintone record 物件（不含 role_id，由呼叫方決定）*/
  function buildRowRecord(row) {
    const code = row.dataset.code;
    const nameEl = row.querySelector('.person-name');
    const unitSelect = row.querySelector('.row-unit-select');
    const titleSelect = row.querySelector('.row-title-select');
    const holderTypeSelect = row.querySelector('.row-holder-type-select');
    const groupSelect = row.querySelector('.holder-group-select');
    const holderType = holderTypeSelect ? holderTypeSelect.value : HOLDER_TYPE_USER;

    const gIdx = row.dataset.gidx;
    const unitName   = unitSelect  ? unitSelect.value.trim()  : '';
    const titleLevel = titleSelect ? titleSelect.value.trim() : '';

    // signing_mode 從卡片批控下拉讀取，預設「任一人簽」
    const signingSelect = gIdx
      ? document.querySelector(`.bulk-signing-select[data-gidx="${gIdx}"]`)
      : null;
    const signingMode = signingSelect ? signingSelect.value : '任一人簽';

    // role_name = unit_name_title_level（與預覽欄一致）
    const roleName =
      unitName && titleLevel ? `${unitName}_${titleLevel}` : unitName || titleLevel || '';

    const record = {
      role_name:    { value: roleName },
      unit_name:    { value: unitName },
      title_level:  { value: titleLevel },
      holder_type:  { value: holderType },
      signing_mode: { value: signingMode },
      is_active:    { value: [ACTIVE_VALUE] },
    };

    if (holderType === HOLDER_TYPE_GROUP) {
      const groupCode = groupSelect ? groupSelect.value.trim() : '';
      const matchedGroup = _allGroups.find(
        (g) => normalize(g.code) === normalize(groupCode),
      );
      if (!matchedGroup) {
        const nameDisplay = nameEl ? nameEl.textContent.trim() : code || '此列';
        throw new Error(`「${nameDisplay}」的指定群組尚未正確選取。`);
      }
      record.holder_group = { value: [{ code: matchedGroup.code }] };
      record.holder_user  = { value: [] };
    } else {
      const matchedUser = _userDirectory && _userDirectory.byCode
        ? _userDirectory.byCode.get(normalize(code))
        : null;
      record.holder_user  = {
        value: [matchedUser ? { code: matchedUser.code, name: matchedUser.name } : { code }],
      };
      record.holder_group = { value: [] };
    }

    return record;
  }

  /**
   * 全部列驗證 + 建構（整批送出用）。
   *
   * 永遠回傳 { records, skipped }：
   *   records  — 通過驗證且成功建構的 kintone record 物件陣列（含 role_id）
   *   skipped  — 被略過的列，格式 [{ name, reason }]
   *
   * 驗證或建構任一失敗時：
   *   - 略過該列，繼續處理其餘列（不中斷整批）
   *   - role_id 流水號只計入成功的列，不留空缺
   */
  function buildRecords(startNum = 1) {
    const rows = [...document.querySelectorAll('tr.br-data-row')];
    const skipped = [];
    const records  = [];
    let seqNum = startNum;

    rows.forEach((row) => {
      const nameEl = row.querySelector('.person-name');
      const nameDisplay = nameEl ? nameEl.textContent.trim() : (row.dataset.code || '未知人員');

      // 步驟 1：欄位驗證
      try {
        validateRow(row);
      } catch (err) {
        skipped.push({ name: nameDisplay, reason: err.message });
        return;
      }

      // 步驟 2：建構 record 物件（可能因群組未選等原因拋錯）
      try {
        const rec = buildRowRecord(row);
        rec.role_id = { value: `ROLE_${String(seqNum++).padStart(4, '0')}` };
        records.push(rec);
      } catch (err) {
        skipped.push({ name: nameDisplay, reason: err.message });
      }
    });

    return { records, skipped };
  }

  /** 更新單列的儲存狀態圖示：'saved' | 'dirty' | '' */
  function updateRowStatus(tr, state) {
    const icon = tr.querySelector('.row-save-icon');
    if (!icon) return;
    icon.className = `row-save-icon${state ? ` rsi-${state}` : ''}`;
    if (state === 'saved') { icon.textContent = '✓'; icon.title = '已儲存'; }
    else if (state === 'dirty') { icon.textContent = '●'; icon.title = '有未儲存的修改'; }
    else { icon.textContent = ''; icon.title = '未儲存'; }
  }

  /** 根據卡片內各列狀態，更新卡片右上角按鈕與提示文字 */
  function updateCardStatus(gIdx) {
    const allRows = [...document.querySelectorAll(`tr.br-data-row[data-gidx="${gIdx}"]`)];
    const total = allRows.length;
    const savedCount = allRows.filter((tr) => tr.dataset.recordId).length;
    const dirtyCount = allRows.filter((tr) => tr.dataset.dirty === 'true').length;
    const newCount   = total - savedCount;

    const statusEl = document.getElementById(`card-status-${gIdx}`);
    const saveBtn  = document.querySelector(`.br-save-card[data-gidx="${gIdx}"]`);

    if (statusEl) {
      if (savedCount === total && total > 0 && dirtyCount === 0) {
        statusEl.textContent = `✓ ${total}/${total} 已建立`;
        statusEl.style.color = '#27ae60';
      } else if (savedCount > 0) {
        const parts = [];
        if (savedCount > 0) parts.push(`${savedCount} 筆已建立`);
        if (dirtyCount > 0) parts.push(`${dirtyCount} 筆待更新`);
        if (newCount > 0)   parts.push(`${newCount} 筆未建立`);
        statusEl.textContent = parts.join('・');
        statusEl.style.color = '#e67e22';
      } else {
        statusEl.textContent = '';
      }
    }

    if (saveBtn) {
      if (savedCount === total && total > 0 && dirtyCount === 0) {
        saveBtn.textContent = '✓ 已完成';
        saveBtn.className = 'btn btn-secondary btn-sm br-save-card';
      } else if (dirtyCount > 0 && newCount === 0) {
        saveBtn.textContent = '↑ 更新此組';
        saveBtn.className = 'btn btn-primary btn-sm br-save-card';
      } else {
        saveBtn.textContent = dirtyCount > 0 ? '✓ 建立並更新' : '✓ 建立此組';
        saveBtn.className = 'btn btn-success btn-sm br-save-card';
      }
    }
  }

  /** 若列已儲存過，標記為 dirty 並更新 UI */
  function markRowDirty(tr) {
    if (tr.dataset.recordId) {
      tr.dataset.dirty = 'true';
      updateRowStatus(tr, 'dirty');
      updateCardStatus(tr.dataset.gidx);
    }
  }

  /** 儲存單張卡片：POST 新列、PUT dirty 列 */
  async function saveCard(gIdx) {
    const saveBtn  = document.querySelector(`.br-save-card[data-gidx="${gIdx}"]`);
    const statusEl = document.getElementById(`card-status-${gIdx}`);
    const allRows  = [...document.querySelectorAll(`tr.br-data-row[data-gidx="${gIdx}"]`)];
    const newRows   = allRows.filter((tr) => !tr.dataset.recordId);
    const dirtyRows = allRows.filter((tr) => tr.dataset.recordId && tr.dataset.dirty === 'true');

    if (!newRows.length && !dirtyRows.length) {
      if (statusEl) { statusEl.textContent = '無變更'; statusEl.style.color = '#999'; }
      return;
    }

    // 驗證（在 disable 按鈕前做，失敗直接 return，按鈕不卡）
    try {
      [...newRows, ...dirtyRows].forEach(validateRow);
    } catch (err) {
      alert(err.message);
      return;
    }

    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '處理中…'; }

    // 一律用 finally 恢復按鈕，確保任何例外都不會卡住
    try {
      const appId = kintone.app.getId();
      console.log('[saveCard] appId:', appId);
      if (!appId) {
        throw new Error('kintone.app.getId() 回傳 null。請確認此 JS 已上傳至 App 685 的「自訂設定」，而非其他 App。');
      }

      const apiUrl = kintone.api.url('/k/v1/records', true);

      // POST 新列
      if (newRows.length) {
        let startNum = 1;
        try { startNum = (await fetchMaxRoleNum()) + 1; } catch (e) {
          console.warn('[saveCard] fetchMaxRoleNum failed, starting from 1:', e.message);
        }

        const roleIds = generateRoleIds(newRows.length, startNum);
        // buildRowRecord 可能 throw，統一由外層 catch 接
        const postRecords = newRows.map((tr, i) => {
          const rec = buildRowRecord(tr);
          rec.role_id = { value: roleIds[i] };
          return rec;
        });
        console.log('[saveCard] POST records[0]:', JSON.stringify(postRecords[0], null, 2));

        const resp = await kintone.api(apiUrl, 'POST', { app: appId, records: postRecords });
        (resp.ids || []).forEach((id, i) => {
          newRows[i].dataset.recordId = id;
          newRows[i].dataset.dirty = '';
          updateRowStatus(newRows[i], 'saved');
        });
      }

      // PUT dirty 列
      if (dirtyRows.length) {
        const putRecords = dirtyRows.map((tr) => ({
          id: tr.dataset.recordId,
          record: buildRowRecord(tr),
        }));

        await kintone.api(apiUrl, 'PUT', { app: appId, records: putRecords });
        dirtyRows.forEach((tr) => {
          tr.dataset.dirty = '';
          updateRowStatus(tr, 'saved');
        });
      }

    } catch (err) {
      console.error('[saveCard] error:', err);
      alert(`儲存失敗：${err.message || JSON.stringify(err)}`);
    } finally {
      if (saveBtn) saveBtn.disabled = false;
      updateCardStatus(gIdx);
    }
  }

  async function submitBatch() {
    const btn = document.getElementById('br-btn-submit');
    if (btn.disabled) return;

    // ① 先做快速驗證（暫用序號 1），確認是否有可送資料
    const { records: preCheck, skipped: preSkipped } = buildRecords(1);

    if (!preCheck.length) {
      const msg = preSkipped.length
        ? `所有 ${preSkipped.length} 列資料驗證失敗，無可送出的資料。`
        : '目前沒有可送出的資料。';
      alert(msg);
      return;
    }

    const skipNote = preSkipped.length ? `\n（${preSkipped.length} 列驗證失敗，將略過）` : '';
    if (!confirm(`確定要建立 ${preCheck.length} 筆角色記錄嗎？${skipNote}`)) return;

    const statusId = 'br-submit-status';
    btn.disabled = true;
    btn.textContent = '建立中...';
    showStatus(statusId, 'info', '查詢現有角色編號中...');

    // ② 查出現有最大流水號，重建帶正確序號的記錄
    let maxNum;
    try {
      maxNum = await fetchMaxRoleNum();
    } catch (err) {
      console.error('[batch-role-creator] fetchMaxRoleNum error', err);
      showStatus(statusId, 'error', err.message || '讀取既有 role_id 失敗，已停止建立，避免產生重複角色代碼。');
      btn.disabled = false;
      btn.textContent = '建立角色記錄';
      return;
    }

    const { records, skipped: validationSkipped } = buildRecords(maxNum + 1);

    if (!records.length) {
      showStatus(statusId, 'error', '重建記錄時所有列均驗證失敗，無可建立的資料。');
      btn.disabled = false;
      btn.textContent = '建立角色記錄';
      return;
    }

    const appId = kintone.app.getId();
    console.log('[batch-role-creator] submitBatch appId:', appId);
    if (!appId) {
      showStatus(statusId, 'error', '錯誤：kintone.app.getId() 回傳 null。請確認此 JS 已上傳至 App 685 的「自訂設定」。');
      btn.disabled = false;
      btn.textContent = '建立角色記錄';
      return;
    }

    const chunkSize = 100;
    let created = 0;
    /** @type {{ name: string; reason: string }[]} */
    const apiFailed = [];

    console.log('[batch-role-creator] submitBatch appId:', appId, '| startNum:', maxNum + 1);
    console.log('[batch-role-creator] records[0]:', JSON.stringify(records[0], null, 2));
    showStatus(
      statusId,
      'info',
      `準備建立 ${records.length} 筆（從 ROLE_${String(maxNum + 1).padStart(4, '0')} 起）${validationSkipped.length ? `，略過 ${validationSkipped.length} 筆驗證失敗` : ''}...`,
    );

    for (let i = 0; i < records.length; i += chunkSize) {
      const chunk = records.slice(i, i + chunkSize);
      showStatus(statusId, 'info', `建立中... ${created} / ${records.length}`);

      try {
        await kintone.api(kintone.api.url('/k/v1/records', true), 'POST', {
          app: appId,
          records: chunk,
        });
        created += chunk.length;
      } catch (chunkErr) {
        // chunk 整批失敗 → 逐筆重試，把能過的記錄建起來
        console.warn('[submitBatch] chunk failed, retrying one by one:', formatKintoneError(chunkErr));
        for (const rec of chunk) {
          try {
            await kintone.api(kintone.api.url('/k/v1/records', true), 'POST', {
              app: appId,
              records: [rec],
            });
            created++;
          } catch (rowErr) {
            const roleName = (rec.role_name && rec.role_name.value) || (rec.role_id && rec.role_id.value) || '未知';
            apiFailed.push({ name: roleName, reason: formatKintoneError(rowErr) });
          }
        }
      }
    }

    // ③ 彙整所有跳過清單
    const allSkipped = [
      ...validationSkipped.map((s) => ({ ...s, type: '驗證失敗' })),
      ...apiFailed.map((s) => ({ ...s, type: 'API 失敗' })),
    ];

    if (allSkipped.length) {
      // 有跳過 → 顯示 SweetAlert 跳過清單，不自動重整
      const tableRows = allSkipped
        .map(
          (s) =>
            `<tr>
              <td style="padding:5px 8px;border:1px solid #ddd;text-align:left">${s.name}</td>
              <td style="padding:5px 8px;border:1px solid #ddd;text-align:left">${s.type}</td>
              <td style="padding:5px 8px;border:1px solid #ddd;text-align:left">${s.reason}</td>
            </tr>`,
        )
        .join('');

      showStatus(
        statusId,
        'info',
        `完成：${created} 筆建立成功，${allSkipped.length} 筆略過（見下方彈窗）。`,
      );

      const showSkipped = typeof Swal !== 'undefined' && typeof Swal.fire === 'function'
        ? Swal.fire({
            title: `略過清單（共 ${allSkipped.length} 筆）`,
            html: `
              <p style="margin-bottom:8px">以下資料已略過，請人工確認並處理：</p>
              <div style="max-height:320px;overflow-y:auto">
                <table style="width:100%;border-collapse:collapse;font-size:13px">
                  <thead>
                    <tr style="background:#f5f5f5">
                      <th style="padding:6px 8px;border:1px solid #ddd;text-align:left">角色名稱</th>
                      <th style="padding:6px 8px;border:1px solid #ddd;text-align:left">類型</th>
                      <th style="padding:6px 8px;border:1px solid #ddd;text-align:left">原因</th>
                    </tr>
                  </thead>
                  <tbody>${tableRows}</tbody>
                </table>
              </div>`,
            icon: 'warning',
            width: '680px',
            confirmButtonText: '我知道了',
          })
        : Promise.resolve(alert(
            `略過 ${allSkipped.length} 筆：\n` +
            allSkipped.map((s) => `・${s.name}（${s.type}）：${s.reason}`).join('\n'),
          ));

      await showSkipped;
      btn.disabled = false;
      btn.textContent = '建立角色記錄';
    } else {
      // 全部成功 → 自動重整
      showStatus(statusId, 'success', `建立完成，共新增 ${created} 筆角色記錄。畫面即將重新整理。`);
      btn.textContent = '建立完成';
      setTimeout(() => location.reload(), 1500);
    }
  }

  function bindEvents() {
    document.getElementById('br-btn-close').onclick = () => {
      document.getElementById('batch-role-modal').style.display = 'none';
    };

    document.getElementById('br-btn-parse').onclick = parseCSVAndFetchOrgs;

    document.getElementById('br-csvFile').onchange = (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (ev) => {
        document.getElementById('br-csvInput').value = ev.target.result;
        parseCSVAndFetchOrgs();
      };
      reader.readAsText(file, 'UTF-8');
    };

    document.getElementById('br-btn-submit').onclick = submitBatch;
  }

  kintone.events.on('app.record.index.show', function (event) {
    injectCSS();
    injectModal();

    if (document.getElementById('btn-open-batch-role')) return event;

    const headerMenu = kintone.app.getHeaderMenuSpaceElement();
    if (!headerMenu) return event;

    const btn = document.createElement('button');
    btn.id = 'btn-open-batch-role';
    btn.textContent = '批次角色建立';
    btn.onclick = () => {
      document.getElementById('batch-role-modal').style.display = 'block';
    };

    headerMenu.appendChild(btn);
    return event;
  });
})();
