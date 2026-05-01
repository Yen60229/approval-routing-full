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
      #batch-role-modal {
        display: none;
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        z-index: 1000;
        overflow-y: auto;
        padding: 32px 20px;
        font-family: "Microsoft JhengHei", sans-serif;
      }
      #batch-role-modal-inner {
        width: min(1200px, 96%);
        margin: 0 auto;
        background: #fff;
        border-radius: 8px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
        padding: 24px;
      }
      #batch-role-modal h2 {
        margin: 0 0 20px;
        padding-bottom: 10px;
        border-bottom: 2px solid #3498db;
        color: #333;
        font-size: 20px;
      }
      #batch-role-modal .section {
        margin-bottom: 24px;
      }
      #batch-role-modal .section h3 {
        margin: 0 0 10px;
        color: #444;
        font-size: 16px;
      }
      #batch-role-modal textarea {
        width: 100%;
        min-height: 120px;
        padding: 10px;
        border: 1px solid #ccc;
        border-radius: 4px;
        resize: vertical;
        font-size: 14px;
        box-sizing: border-box;
      }
      #batch-role-modal input[type="text"],
      #batch-role-modal select {
        width: 100%;
        min-width: 0;
        padding: 8px 10px;
        border: 1px solid #ccc;
        border-radius: 4px;
        font-size: 13px;
        box-sizing: border-box;
      }
      #batch-role-modal .btn {
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
        font-weight: 600;
        padding: 8px 16px;
      }
      #batch-role-modal .btn-sm {
        padding: 4px 8px;
        font-size: 12px;
      }
      #batch-role-modal .btn-primary {
        background: #3498db;
        color: #fff;
      }
      #batch-role-modal .btn-primary:hover {
        background: #2980b9;
      }
      #batch-role-modal .btn-success {
        background: #27ae60;
        color: #fff;
      }
      #batch-role-modal .btn-success:hover {
        background: #219a52;
      }
      #batch-role-modal .btn-secondary {
        background: #e0e0e0;
        color: #333;
      }
      #batch-role-modal .btn-danger {
        background: #e74c3c;
        color: #fff;
      }
      #batch-role-modal .helper-text {
        color: #666;
        font-size: 13px;
        line-height: 1.6;
        margin: 0 0 10px;
      }
      #batch-role-modal .toolbar {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
      }
      .org-card {
        border: 1px solid #e1e4e8;
        border-radius: 8px;
        overflow: hidden;
        margin-bottom: 16px;
        background: #fff;
      }
      .org-header {
        padding: 14px 16px;
        background: #f6f8fa;
        border-bottom: 1px solid #e1e4e8;
      }
      .org-header-top {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        margin-bottom: 12px;
      }
      .org-header-title {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 15px;
        font-weight: 700;
        color: #24292e;
      }
      .badge {
        border-radius: 999px;
        background: #e1e4e8;
        padding: 2px 8px;
        font-size: 12px;
        font-weight: 400;
      }
      .org-bulk-controls {
        display: grid;
        grid-template-columns: minmax(220px, 1.2fr) minmax(180px, 1fr) auto;
        gap: 12px;
        align-items: end;
      }
      .field-label {
        display: block;
        margin-bottom: 4px;
        color: #666;
        font-size: 12px;
      }
      .org-table {
        width: 100%;
        border-collapse: collapse;
      }
      .org-table th,
      .org-table td {
        padding: 10px 14px;
        border-bottom: 1px solid #eee;
        vertical-align: top;
        text-align: left;
      }
      .org-table th {
        color: #666;
        font-size: 13px;
        font-weight: 600;
      }
      .org-table tr:last-child td {
        border-bottom: none;
      }
      .person-name {
        color: #222;
        font-weight: 700;
        font-size: 14px;
      }
      .person-meta {
        color: #666;
        font-size: 12px;
        margin-top: 4px;
        line-height: 1.5;
      }
      .row-preview {
        display: inline-block;
        background: #f1f3f5;
        border-radius: 4px;
        padding: 4px 8px;
        color: #8b0000;
        font-family: Consolas, monospace;
        font-size: 13px;
        font-weight: 700;
        white-space: nowrap;
      }
      .holder-target {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .holder-person {
        color: #555;
        font-size: 12px;
        line-height: 1.5;
        padding: 8px 10px;
        border: 1px solid #e5e7eb;
        border-radius: 4px;
        background: #f8fafc;
      }
      .holder-group-filter,
      .holder-group-select {
        width: 100%;
      }
      .holder-hint {
        color: #777;
        font-size: 12px;
        line-height: 1.4;
      }
      .holder-lock {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: #334155;
        font-size: 12px;
        font-weight: 600;
      }
      .status-box {
        margin-top: 12px;
        padding: 12px 14px;
        border-radius: 4px;
        display: none;
        font-size: 14px;
      }
      .status-success {
        display: block !important;
        background: #d4edda;
        border: 1px solid #c3e6cb;
        color: #155724;
      }
      .status-error {
        display: block !important;
        background: #f8d7da;
        border: 1px solid #f5c6cb;
        color: #721c24;
      }
      .status-info {
        display: block !important;
        background: #e2e3e5;
        border: 1px solid #d6d8db;
        color: #383d41;
      }
      #btn-open-batch-role {
        margin-left: 16px;
        background: #3498db;
        color: #fff;
        border: none;
        border-radius: 4px;
        padding: 0 16px;
        height: 48px;
        cursor: pointer;
        font-size: 14px;
        font-weight: 700;
      }
      #btn-open-batch-role:hover {
        background: #2980b9;
      }
      @media (max-width: 900px) {
        .org-bulk-controls {
          grid-template-columns: 1fr;
        }
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

    _parsedGroups.forEach((group, gIdx) => {
      const rowsHtml = group.users
        .map(
          (user, rIdx) => `
            <tr class="br-data-row" data-gidx="${gIdx}" data-ridx="${rIdx}" data-code="${_esc(user.code)}">
              <td>
                <div class="person-name">${_esc(user.displayName)}</div>
                <div class="person-meta">
                  登入帳號：${_esc(user.loginAccount)}<br>
                  組織：${_esc(user.groupKey)}${user.allOrgs.length > 1 ? `（兼任 ${user.allOrgs.length} 個單位）` : ''}
                </div>
              </td>
              <td>
                <select class="row-unit-select" data-gidx="${gIdx}" data-ridx="${rIdx}">
                  ${buildUnitOptionsHtml('')}
                </select>
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
                    ${_esc(user.loginAccount)} / ${_esc(user.displayName)}
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
            </div>
            <div class="org-bulk-controls">
              <div>
                <label class="field-label" for="bulk-unit-${gIdx}">unit_name</label>
                <select id="bulk-unit-${gIdx}" class="bulk-unit-select" data-gidx="${gIdx}">
                  ${buildUnitOptionsHtml('')}
                </select>
              </div>
              <div>
                <label class="field-label" for="bulk-title-${gIdx}">title_level</label>
                <select id="bulk-title-${gIdx}" class="bulk-title-select" data-gidx="${gIdx}">
                  ${buildTitleOptionsHtml('')}
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
                <th style="width:34%;">人員</th>
                <th style="width:14%;">unit_name</th>
                <th style="width:12%;">title_level</th>
                <th style="width:12%;">holder_type</th>
                <th style="width:18%;">holder</th>
                <th style="width:10%;">role_name 預覽</th>
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

  function bindGroupRowEvents() {
    document.querySelectorAll('.row-unit-select').forEach((select) => {
      select.addEventListener('change', (event) => {
        updateSinglePreview(event.target.dataset.gidx, event.target.dataset.ridx);
      });
    });

    document.querySelectorAll('.row-title-select').forEach((select) => {
      select.addEventListener('change', (event) => {
        updateSinglePreview(event.target.dataset.gidx, event.target.dataset.ridx);
      });
    });

    document.querySelectorAll('.row-holder-type-select').forEach((select) => {
      select.addEventListener('change', (event) => {
        toggleHolderTarget(event.target.dataset.gidx, event.target.dataset.ridx);
      });
    });

    document.querySelectorAll('.holder-group-filter').forEach((input) => {
      const updateMatches = () => {
        refreshGroupOptions(input.dataset.gidx, input.dataset.ridx, input.value);
      };

      input.addEventListener('focus', updateMatches);
      input.addEventListener('input', updateMatches);
    });

    document.querySelectorAll('.holder-group-select').forEach((select) => {
      select.addEventListener('focus', (event) => {
        const filterInput = document.querySelector(
          `.holder-group-filter[data-gidx="${event.target.dataset.gidx}"][data-ridx="${event.target.dataset.ridx}"]`,
        );
        refreshGroupOptions(
          event.target.dataset.gidx,
          event.target.dataset.ridx,
          filterInput ? filterInput.value : '',
        );
      });
    });

    document.querySelectorAll('.bulk-unit-select').forEach((select) => {
      select.addEventListener('change', (event) => {
        const gIdx = event.target.dataset.gidx;
        const button = document.querySelector(`.br-apply-group[data-gidx="${gIdx}"]`);
        if (button) {
          button.textContent = '套用全組';
        }
      });
    });

    document.querySelectorAll('.bulk-title-select').forEach((select) => {
      select.addEventListener('change', (event) => {
        const gIdx = event.target.dataset.gidx;
        const button = document.querySelector(`.br-apply-group[data-gidx="${gIdx}"]`);
        if (button) {
          button.textContent = '套用全組';
        }
      });
    });

    document.querySelectorAll('.br-apply-group').forEach((button) => {
      button.addEventListener('click', (event) => {
        const gIdx = event.currentTarget.dataset.gidx;
        applyBulkToGroup(gIdx);
      });
    });

    document.querySelectorAll('tr.br-data-row').forEach((row) => {
      toggleHolderTarget(row.dataset.gidx, row.dataset.ridx);
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

  function generateRoleIds(count) {
    const now = new Date();
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    const ts = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
      String(now.getMilliseconds()).padStart(3, '0'),
      rand,
    ].join('');

    return Array.from(
      { length: count },
      (_, index) => `ROLE_${ts}_${String(index + 1).padStart(3, '0')}`,
    );
  }

  function buildRecords() {
    const rows = [...document.querySelectorAll('tr.br-data-row')];
    const roleIds = generateRoleIds(rows.length);

    return rows.map((row, idx) => {
      const code = row.dataset.code;
      const nameEl = row.querySelector('.person-name');
      const unitSelect = row.querySelector('.row-unit-select');
      const titleSelect = row.querySelector('.row-title-select');
      const holderTypeSelect = row.querySelector('.row-holder-type-select');
      const groupSelect = row.querySelector('.holder-group-select');
      const unitName = unitSelect ? unitSelect.value.trim() : '';
      const titleLevel = titleSelect ? titleSelect.value.trim() : '';
      const holderType = holderTypeSelect ? holderTypeSelect.value : HOLDER_TYPE_USER;

      if (!unitName) {
        throw new Error(`「${nameEl ? nameEl.textContent : code}」的 unit_name 尚未選擇。`);
      }
      if (!titleLevel) {
        throw new Error(`「${nameEl ? nameEl.textContent : code}」的 title_level 尚未選擇。`);
      }

      const record = {
        role_id: { value: roleIds[idx] },
        unit_name: { value: unitName },
        title_level: { value: titleLevel },
        holder_type: { value: holderType },
        is_active: { value: [ACTIVE_VALUE] },
      };

      if (holderType === HOLDER_TYPE_GROUP) {
        const groupCode = groupSelect ? groupSelect.value.trim() : '';
        const matchedGroup = _allGroups.find(
          (group) => normalize(group.code) === normalize(groupCode),
        );

        if (!matchedGroup) {
          throw new Error(`「${nameEl ? nameEl.textContent : code}」的指定群組尚未正確選取。`);
        }

        record.holder_group = {
          value: [{ code: matchedGroup.code }],
        };
        record.holder_user = { value: [] };
      } else {
        const matchedUser =
          _userDirectory && _userDirectory.byCode
            ? _userDirectory.byCode.get(normalize(code))
            : null;

        record.holder_user = {
          value: [
            matchedUser
              ? { code: matchedUser.code, name: matchedUser.name }
              : { code },
          ],
        };
        record.holder_group = { value: [] };
      }

      return record;
    });
  }

  async function submitBatch() {
    const btn = document.getElementById('br-btn-submit');
    if (btn.disabled) return;

    let records;
    try {
      records = buildRecords();
    } catch (error) {
      alert(error.message);
      return;
    }

    if (!records.length) {
      alert('目前沒有可送出的資料。');
      return;
    }

    if (!confirm(`確定要建立 ${records.length} 筆角色記錄嗎？`)) return;

    const statusId = 'br-submit-status';
    btn.disabled = true;
    btn.textContent = '建立中...';
    showStatus(statusId, 'info', `準備建立 0 / ${records.length} 筆...`);

    const appId = kintone.app.getId();
    const chunkSize = 100;
    let created = 0;

    try {
      for (let i = 0; i < records.length; i += chunkSize) {
        const chunk = records.slice(i, i + chunkSize);
        showStatus(statusId, 'info', `建立中... ${created} / ${records.length}`);
        await kintone.api(kintone.api.url('/v1/records.json', true), 'POST', {
          app: appId,
          records: chunk,
        });
        created += chunk.length;
      }

      showStatus(statusId, 'success', `建立完成，共新增 ${created} 筆角色記錄。畫面即將重新整理。`);
      btn.textContent = '建立完成';
      setTimeout(() => location.reload(), 1500);
    } catch (error) {
      console.error('[batch-role-creator] submitBatch error', error);
      showStatus(
        statusId,
        'error',
        `建立失敗，目前已建立 ${created} 筆。錯誤訊息：${error.message || '未知錯誤'}`,
      );
      btn.disabled = false;
      btn.textContent = '建立角色記錄';
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
