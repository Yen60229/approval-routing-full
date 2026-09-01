/**
 * 批次角色建立工具（kintone App 685）
 *
 * 功能：
 * 1. 讀取 CSV，支援「登入帳號 / 使用者名稱 / title_level」或舊版「code / title」欄位。
 * 2. 以 CSV 的登入帳號對應後台登入名稱、使用者名稱對應後台顯示名稱，解析成真正的使用者 code。
 * 3. 依每位同仁每個所屬組織各建一列；兼任 N 個部門者顯示 N 列，每列可獨立設定。
 *    人員欄一併顯示該組織的「職務」（kintone 後台設定），並自動對應成 title_level。
 * 4. 每個組織卡片提供 unit_name 與 title_level 批次帶入，仍可逐列微調；
 *    另有「依職務帶入」可一鍵用職務填滿整組的 title_level。
 * 5. 批次建立角色定義記錄，寫入 unit_name / title_level / holder_user / is_active。
 * 6. 匯入時自動比對 App 685 既有記錄：該人已被設為某角色的簽核者時，整列以
 *    黃底 + 「已建立」徽章醒目標示，並可從下拉挑一筆既有角色接續編輯，
 *    儲存時走 PUT 更新（不會重複建立），也可改選「建立為新角色」照常新增。
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
 *   2026-08-19  Jimmy/Claude  匯入時比對既有角色記錄：已存在者整列醒目標示，
 *                              可挑既有角色接續編輯並以 PUT 更新，避免重複建立
 *   2026-08-19  Jimmy/Claude  人員清單顯示 kintone 後台「職務」，並據以自動帶入
 *                              title_level；卡片新增「依職務帶入」一鍵套用
 *   2026-08-19  Jimmy/Claude  使用者解析改以「登入名稱 + valid」判定使用狀態：同名帳號
 *                              全部保留、姓名比對只認使用中者、停用帳號一律擋下並指出
 *                              同名的在職帳號。修正離職又回鍋同事被誤判為停用的問題
 *   2026-09-01  Jimmy/Claude  視窗加上永遠可見的關閉鈕（×）與 Esc 關閉。原本的「關閉」按鈕在
 *                              「卡片分組」區塊裡，而那一區在匯入 CSV 前是 display:none——
 *                              還沒匯資料時視窗根本關不掉
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
  /** 使用者帳號（normalize 後）→ 該人現有的角色記錄陣列，用於偵測「已建立且存在」 */
  let _existingRolesByUser = new Map();
  /** 使用者帳號（normalize 後）→ [{ name, title }]，避免同一人重複打組織 API */
  const _userOrgCache = new Map();

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

  /**
   * 產生人員搜尋共用 datalist（value = loginCode，文字提示為顯示名稱）
   * 只列使用中的帳號：已停用者（含離職又回鍋者的舊帳號）不該被選為簽核者，
   * 從建議清單就排除掉，比事後報錯更省事。
   */
  const buildPersonDatalist = () => {
    if (!_userDirectory || !_userDirectory.users) {
      return '<datalist id="br-person-datalist"></datalist>';
    }
    const options = _userDirectory.users
      .filter(isActiveUser)
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
      #batch-role-modal .modal-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
      }
      /* 關閉鈕永遠在，不隨「卡片分組」區塊一起被隱藏——
         沒匯入資料前那一區是 display:none，底下的「關閉」按鈕跟著看不見，
         視窗就變成關不掉（實測回報） */
      #batch-role-modal .modal-x {
        flex: none;
        width: 40px;
        height: 40px;
        border: 1px solid #dfe6e9;
        border-radius: 8px;
        background: #fff;
        color: #636e72;
        font-size: 26px;
        line-height: 1;
        cursor: pointer;
        transition: background .15s, color .15s;
      }
      #batch-role-modal .modal-x:hover { background: #ffeaea; color: #e74c3c; border-color: #e74c3c; }
      #batch-role-modal .modal-x:focus-visible { outline: 2px solid #2980b9; outline-offset: 2px; }
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

      /* ── 職務（來自 kintone 組織設定，供對照設 title_level）── */
      .job-title {
        display: inline-block;
        padding: 1px 8px;
        border-radius: 4px;
        background: #eef2ff;
        border: 1px solid #c7d2fe;
        color: #3730a3;
        font-weight: 700;
        font-size: 13px;
      }
      .job-title-empty {
        background: #f3f4f6;
        border-color: #e5e7eb;
        color: #9ca3af;
        font-weight: 400;
      }
      .job-applied {
        display: inline-block;
        margin-left: 6px;
        padding: 1px 7px;
        border-radius: 4px;
        background: #dcfce7;
        color: #166534;
        font-size: 12px;
        font-weight: 700;
      }
      .job-applied-guess { background: #fef3c7; color: #92400e; }

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

      /* ── 已存在於 685 的人員列：黃底 + 左側粗邊，讓 HR 一眼看到「這不是新增」 ── */
      .org-table tr.row-existing td {
        background: #fffbea;
        box-shadow: inset 0 0 0 9999px rgba(245,158,11,.04);
      }
      .org-table tr.row-existing:hover td { background: #fff4d6; }
      .org-table tr.row-existing td:first-child {
        border-left: 5px solid #f59e0b;
        padding-left: 11px;
      }
      /* 已綁定既有記錄（送出時會走更新）再加深一層，與「只是有既有角色」區隔 */
      .org-table tr.row-existing.row-bound td:first-child { border-left-color: #d97706; }

      .badge-exists {
        display: inline-block;
        margin-left: 8px;
        padding: 2px 9px;
        border-radius: 999px;
        background: #f59e0b;
        color: #fff;
        font-size: 12px;
        font-weight: 700;
        vertical-align: middle;
        white-space: nowrap;
      }
      .badge-bound { background: #d97706; }

      .existing-picker { margin-top: 7px; }
      .existing-picker select {
        width: 100%;
        padding: 7px 10px !important;
        border-color: #f0c040 !important;
        background: #fffdf5 !important;
        font-size: 13px !important;
        font-weight: 600;
      }
      .existing-hint {
        margin-top: 4px;
        color: #92400e;
        font-size: 12px;
        line-height: 1.55;
        font-weight: 600;
      }

      /* ── 匯入摘要提示（既有人員數量）── */
      .status-warn {
        display: block !important;
        background: #fef3c7;
        border: 1.5px solid #f0c040;
        color: #7c2d12;
      }

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
          <div class="modal-head">
            <h2>批次角色建立（依組織卡片帶入）</h2>
            <button type="button" class="modal-x" id="br-btn-x" aria-label="關閉" title="關閉（Esc）">&times;</button>
          </div>

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
              <br>
              <span style="display:inline-block;margin-top:6px;padding:4px 10px;background:#fffbea;border:1.5px solid #f0c040;border-radius:5px;">
                <strong style="color:#92400e;">黃色列</strong>＝這個人在角色定義表已經有記錄。
                預設仍是「建立為新角色」；若要改既有的，請在該列下拉選<strong>「更新既有：⋯」</strong>，
                欄位會自動帶入原值供修改，儲存時走更新、不會重複建立。
              </span>
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
    const byName = new Map();   // 姓名 → 同名帳號**清單**

    users.forEach((user) => {
      const codeKey = normalize(user.code);
      const nameKey = normalize(user.name);
      // 登入名稱（code）是唯一鍵，可直接對應
      if (codeKey && !byCode.has(codeKey)) byCode.set(codeKey, user);
      // 姓名不唯一（離職又回鍋者會有舊停用帳號 + 新在職帳號），必須全部留著，
      // 由 resolveUserByName 依「使用狀態」挑，不能取第一筆就算
      if (nameKey) {
        if (!byName.has(nameKey)) byName.set(nameKey, []);
        byName.get(nameKey).push(user);
      }
    });

    _userDirectory = { users, byCode, byName };
    return _userDirectory;
  }

  /** 帳號是否為「使用中」（kintone /v1/users 的 valid；未回傳時視為使用中） */
  const isActiveUser = (user) => !!user && user.valid !== false;

  /** 取同名的在職帳號（供停用帳號的錯誤訊息指路：離職又回鍋者的新帳號） */
  const activeSameName = (directory, displayName, excludeCode) =>
    (directory.byName.get(normalize(displayName)) || [])
      .filter((u) => isActiveUser(u) && normalize(u.code) !== normalize(excludeCode || ''))[0] || null;

  /**
   * 以「姓名」解析使用者 — 只認使用中的帳號
   *
   * 離職又回鍋的同事在 kintone 會留下兩個帳號（舊的已停用、新的使用中），
   * 姓名相同但登入名稱不同。單純用姓名比對可能對到已停用的舊帳號，
   * 因此這裡一律先過濾使用狀態，並在無法判斷時明確要求改用登入帳號。
   *
   * @returns {{user?: Object, error?: string}}
   */
  const resolveUserByName = (directory, displayName) => {
    const list = directory.byName.get(normalize(displayName)) || [];
    if (!list.length) {
      return { error: `找不到使用者：使用者名稱「${displayName}」無法對應到後台使用者。` };
    }

    const actives = list.filter(isActiveUser);
    if (actives.length === 1) return { user: actives[0] };

    if (actives.length > 1) {
      return {
        error: `使用者名稱「${displayName}」有 ${actives.length} 個使用中的帳號（` +
               `${actives.map((u) => u.code).join('、')}），無法判斷是哪一位，` +
               `請在 CSV 改用「登入帳號」欄指定。`,
      };
    }

    return {
      error: `使用者名稱「${displayName}」在後台只找得到已停用的帳號（` +
             `${list.map((u) => u.code).join('、')}），不能設為簽核者。` +
             `若本人已回任，請改用新帳號的登入名稱。`,
    };
  };

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

  /**
   * 撈 App 685 全部角色記錄，建「使用者帳號 → 該人現有角色記錄」對照。
   *
   * 只以 holder_user 建索引（群組型角色的成員由 cybozu 後台維護，本工具不碰）。
   * 一筆記錄若掛多位簽核者，會同時出現在每個人的清單裡——選到同一筆去更新時，
   * buildRowRecord 會把 holder_user 覆寫成該列的人，因此提示文字會標明簽核者人數，
   * 讓 HR 知道這筆是共用關卡、更新前要想清楚。
   */
  async function fetchExistingRoles() {
    const appId = kintone.app.getId();
    if (!appId) throw new Error('kintone.app.getId() 回傳 null，請確認此 JS 已上傳至 App 685 的「自訂設定」');

    const PAGE = 500;
    const records = [];
    let offset = 0;

    while (true) {
      const resp = await kintone.api(kintone.api.url('/k/v1/records.json', true), 'GET', {
        app: appId,
        fields: ['$id', 'role_id', 'role_name', 'unit_name', 'title_level',
                 'holder_type', 'holder_user', 'signing_mode', 'is_active'],
        query: `order by $id asc limit ${PAGE} offset ${offset}`,
      });
      const batch = Array.isArray(resp.records) ? resp.records : [];
      records.push(...batch);
      if (batch.length < PAGE) break;
      offset += PAGE;
    }

    const map = new Map();
    records.forEach((r) => {
      const holders = (r.holder_user && r.holder_user.value) || [];
      if (!holders.length) return;

      const info = {
        recordId:    r.$id.value,
        roleId:      (r.role_id && r.role_id.value) || '',
        roleName:    (r.role_name && r.role_name.value) || '',
        unitName:    (r.unit_name && r.unit_name.value) || '',
        titleLevel:  (r.title_level && r.title_level.value) || '',
        holderType:  (r.holder_type && r.holder_type.value) || HOLDER_TYPE_USER,
        signingMode: (r.signing_mode && r.signing_mode.value) || '',
        holderCount: holders.length,
        isActive:    (((r.is_active && r.is_active.value) || []).indexOf(ACTIVE_VALUE) >= 0),
      };

      holders.forEach((u) => {
        const key = normalize(u.code);
        if (!key) return;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(info);
      });
    });

    // 同一人多筆時，啟用中的排前面，其次依 role_name，方便挑選
    map.forEach((list) => {
      list.sort((a, b) => {
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        return a.roleName.localeCompare(b.roleName, 'zh-Hant');
      });
    });

    _existingRolesByUser = map;
    return map;
  }

  /**
   * 取某人的所屬組織與該組織的「職務」
   *
   * kintone 的職務掛在「人 × 組織」上（organizationTitles[].title），
   * 兼任多單位者每個單位的職務可能不同，因此一併回傳、逐列顯示，
   * 讓 HR 對照著設 title_level 不用再回後台查。
   *
   * @returns {Promise<Array<{name: string, title: string}>>} 依組織名稱排序
   */
  async function fetchUserOrgs(code) {
    const cacheKey = normalize(code);
    if (_userOrgCache.has(cacheKey)) return _userOrgCache.get(cacheKey);

    let result;
    try {
      const resp = await kintone.api(
        kintone.api.url('/v1/user/organizations.json', true),
        'GET',
        { code },
      );

      const seen = new Set();
      const orgs = [];
      (resp.organizationTitles || []).forEach((item) => {
        const name = item && item.organization && item.organization.name;
        if (!name || seen.has(name)) return;
        seen.add(name);
        orgs.push({ name, title: (item.title && item.title.name) || '' });
      });

      orgs.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
      result = orgs.length ? orgs : [{ name: FALLBACK_ORG_NAME, title: '' }];
    } catch (error) {
      console.warn(`[batch-role-creator] fetchUserOrgs failed for ${code}`, error);
      result = [{ name: FALLBACK_ORG_NAME, title: '' }];
    }

    _userOrgCache.set(cacheKey, result);
    return result;
  }

  /**
   * 由 kintone 職務推測對應的 title_level 選項
   *
   * 比對順序（職稱通常落在字串結尾，所以先比結尾）：
   *   1. 完全相同             職務「課長」        → 課長
   *   2. 以選項結尾，取最長     職務「資訊本部長」  → 本部長（不是「部長」）
   *   3. 包含選項，取最靠後者   職務「總經理室 擔當」→ 擔當（不是「總經理」）
   * 都沒中就回空字串，不亂猜，交給 HR 自己選。
   *
   * @returns {{value: string, exact: boolean}} value 為空表示無法對應
   */
  function guessTitleLevel(jobTitle) {
    const raw = String(jobTitle || '').trim();
    if (!raw || !_titleLevelOptions.length) return { value: '', exact: false };

    const exact = _titleLevelOptions.find((opt) => opt === raw);
    if (exact) return { value: exact, exact: true };

    const bySuffix = _titleLevelOptions
      .filter((opt) => opt && raw.endsWith(opt))
      .sort((a, b) => b.length - a.length)[0];
    if (bySuffix) return { value: bySuffix, exact: false };

    const byPosition = _titleLevelOptions
      .filter((opt) => opt && raw.indexOf(opt) >= 0)
      .sort((a, b) => {
        const diff = raw.lastIndexOf(b) - raw.lastIndexOf(a);
        return diff !== 0 ? diff : b.length - a.length;
      })[0];

    return byPosition ? { value: byPosition, exact: false } : { value: '', exact: false };
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

  /**
   * 解析 CSV 一列對應到哪個 kintone 使用者
   *
   * 判定原則：**登入名稱（code）是唯一鍵，只要有給就以它為準**；
   * 沒給才退回姓名，且姓名一律只認使用中的帳號。
   * 使用狀態一律看該 code 的 valid，不看姓名——否則離職又回鍋的同事
   * （舊帳號停用、新帳號使用中、姓名相同）會被誤判成停用。
   */
  function resolveCsvUser(row, directory) {
    if (row.loginAccount) {
      const user = directory.byCode.get(normalize(row.loginAccount));
      if (!user) {
        throw new Error(`找不到使用者：登入帳號「${row.loginAccount}」在後台不存在。`);
      }

      if (!isActiveUser(user)) {
        const alt = activeSameName(directory, user.name, user.code);
        throw new Error(
          `登入帳號「${row.loginAccount}」（${user.name}）已停用，不能設為簽核者。` +
          (alt ? `同名的使用中帳號是「${alt.code}」，請改用它。` : ''),
        );
      }

      // 兩欄都有給時做交叉檢核，但以 code 查到的人為準
      if (row.displayName && normalize(user.name) !== normalize(row.displayName)) {
        throw new Error(
          `CSV 資料不一致：登入帳號「${row.loginAccount}」在後台是「${user.name}」，` +
          `與使用者名稱欄的「${row.displayName}」不符。`,
        );
      }
      return user;
    }

    if (row.displayName) {
      const { user, error } = resolveUserByName(directory, row.displayName);
      if (error) throw new Error(error);
      return user;
    }

    throw new Error('找不到使用者：登入帳號與使用者名稱皆為空白。');
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

      statusEl.textContent = '比對 685 既有角色記錄中...';
      try {
        await fetchExistingRoles();
      } catch (existErr) {
        // 比對失敗不阻斷匯入，但要讓 HR 知道「這次沒有重複偵測」，避免誤以為都是新的
        console.warn('[batch-role-creator] fetchExistingRoles failed', existErr);
        _existingRolesByUser = new Map();
      }

      const resolvedUsers = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        statusEl.textContent = `解析使用者與組織中... (${i + 1}/${rows.length})`;

        const user = resolveCsvUser(row, directory);
        const allOrgs = await fetchUserOrgs(user.code);

        // 每個所屬組織建立獨立一列，兼任 N 個單位 → N 行可分別設定
        // 職務（jobTitle）取該組織的職務；CSV 沒指定 title_level 時用它自動帶入
        for (const singleOrg of allOrgs) {
          const guessed = row.titleLevel ? null : guessTitleLevel(singleOrg.title);
          resolvedUsers.push({
            code: user.code,
            loginAccount: user.code,
            displayName: user.name || row.displayName || user.code,
            titleLevel: row.titleLevel || (guessed ? guessed.value : ''),
            titleFromJob: Boolean(guessed && guessed.value),
            titleGuessExact: Boolean(guessed && guessed.exact),
            jobTitle: singleOrg.title,
            allOrgs,
            groupKey: singleOrg.name,
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

      // 匯入摘要：有多少人在 685 已經有角色，提前用黃色提示條說清楚
      const existingNames = [...new Set(
        [...dedupedMap.values()]
          .filter((u) => (_existingRolesByUser.get(normalize(u.code)) || []).length)
          .map((u) => u.displayName),
      )];

      if (existingNames.length) {
        const preview = existingNames.slice(0, 8).join('、');
        const more = existingNames.length > 8 ? ` 等 ${existingNames.length} 人` : '';
        showStatus(
          'br-parse-status',
          'warn',
          `⚠ 其中 ${existingNames.length} 人在角色定義表已經有記錄（${preview}${more}），` +
          `已用黃色標示。想改既有角色請在該列選一筆「更新既有」，儲存時會更新原記錄；` +
          `維持「建立為新角色」則照常新增一筆。`,
        );
      } else {
        hideStatus('br-parse-status');
      }
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
            <tr class="br-data-row" data-gidx="${gIdx}" data-ridx="${rIdx}" data-code="${_esc(user.code)}" data-jobtitle="${_esc(user.jobTitle || '')}">
              <td>
                <div class="person-name">${_esc(user.displayName)}</div>
                <div class="person-meta">
                  登入帳號：${_esc(user.loginAccount)}<br>
                  組織：${_esc(user.groupKey)}${user.allOrgs.length > 1 ? `<br><span style="opacity:.65;">（兼任 ${user.allOrgs.length} 個單位）</span>` : ''}<br>
                  職務：${user.jobTitle
                    ? `<span class="job-title">${_esc(user.jobTitle)}</span>`
                    : '<span class="job-title job-title-empty">（後台未設定）</span>'}
                  ${user.titleFromJob
                    ? `<span class="job-applied${user.titleGuessExact ? '' : ' job-applied-guess'}">${user.titleGuessExact ? '已帶入 title_level' : '依職務推測，請確認'}</span>`
                    : ''}
                </div>
                <div class="existing-slot" data-gidx="${gIdx}" data-ridx="${rIdx}"></div>
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
              <div style="display:flex; gap:8px; flex-wrap:wrap;">
                <button class="btn btn-primary br-apply-group" data-gidx="${gIdx}">套用全組</button>
                <button class="btn btn-secondary br-apply-job" data-gidx="${gIdx}" type="button"
                        title="依 kintone 後台的職務，自動填每一列的 title_level">依職務帶入</button>
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
    // 標示 685 已有記錄的人員（黃底 + 徽章 + 更新既有下拉）
    document.querySelectorAll('tr.br-data-row').forEach((tr) =>
      updateExistingSlot(tr.dataset.gidx, tr.dataset.ridx));
    _parsedGroups.forEach((_, gIdx) => {
      updateOrgPreview(gIdx);
      updateCardStatus(gIdx);
    });
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
          <div class="new-row-job person-meta" data-gidx="${gIdx}" data-ridx="${rId}"></div>
          <div class="existing-slot" data-gidx="${gIdx}" data-ridx="${rId}"></div>
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

  // ═══════════════════════════════════════════════════════════════════
  // 既有角色偵測（已建立且存在 → 醒目標示 + 可改為更新既有記錄）
  // ═══════════════════════════════════════════════════════════════════

  /** 取某人現有的角色記錄清單（找不到回空陣列） */
  const getExistingRoles = (code) =>
    (code && _existingRolesByUser.get(normalize(code))) || [];

  /**
   * 依 data-code 重繪該列的「既有角色」區塊。
   * 有既有記錄 → 整列加 row-existing（黃底）、人員名稱旁加徽章、下方出現選擇下拉。
   * 沒有 → 清空區塊並移除標示（例如新增列把人改成別人時）。
   */
  function updateExistingSlot(gIdx, rIdx) {
    const tr = document.querySelector(`tr.br-data-row[data-gidx="${gIdx}"][data-ridx="${rIdx}"]`);
    const slot = document.querySelector(`.existing-slot[data-gidx="${gIdx}"][data-ridx="${rIdx}"]`);
    if (!tr || !slot) return;

    const list = getExistingRoles(tr.dataset.code);

    if (!list.length) {
      slot.innerHTML = '';
      tr.classList.remove('row-existing', 'row-bound');
      // 只清掉「既有綁定」，本次剛建立的列（preexisting 非 true）不受影響
      if (tr.dataset.preexisting === 'true') {
        tr.dataset.preexisting = '';
        tr.dataset.recordId = '';
        tr.dataset.signingMode = '';
        tr.dataset.dirty = '';
        updateRowStatus(tr, '');
      }
      return;
    }

    tr.classList.add('row-existing');

    const boundId = tr.dataset.preexisting === 'true' ? tr.dataset.recordId : '';
    const options = [
      `<option value="">＋ 建立為新角色</option>`,
      ...list.map((ex) => {
        const label = `${ex.roleName || ex.roleId || `記錄 ${ex.recordId}`}` +
          (ex.isActive ? '' : '（已停用）') +
          (ex.holderCount > 1 ? `／${ex.holderCount} 人共用` : '');
        return `<option value="${_esc(ex.recordId)}"${ex.recordId === boundId ? ' selected' : ''}>更新既有：${_esc(label)}</option>`;
      }),
    ].join('');

    slot.innerHTML = `
      <div class="existing-picker">
        <select class="row-existing-select" data-gidx="${gIdx}" data-ridx="${rIdx}">${options}</select>
        <div class="existing-hint" data-role="existing-hint"></div>
      </div>
    `;

    // 名稱旁的徽章（重繪時先移除舊的，避免重複附加）
    const nameEl = tr.querySelector('.person-name') || tr.querySelector('.new-row-person-info');
    if (nameEl) {
      const old = nameEl.querySelector('.badge-exists');
      if (old) old.remove();
      nameEl.insertAdjacentHTML(
        'beforeend',
        `<span class="badge-exists">已建立 ${list.length} 筆</span>`,
      );
    }

    const select = slot.querySelector('.row-existing-select');
    select.addEventListener('change', () => applyExistingBinding(gIdx, rIdx, select.value));

    refreshExistingHint(tr, list, boundId);
  }

  /** 更新該列黃字提示與徽章文字，讓「會新增」還是「會更新」一目瞭然 */
  function refreshExistingHint(tr, list, boundId) {
    const hintEl = tr.querySelector('[data-role="existing-hint"]');
    const badge  = tr.querySelector('.badge-exists');
    const bound  = boundId ? list.find((ex) => ex.recordId === boundId) : null;

    if (bound) {
      tr.classList.add('row-bound');
      if (badge) {
        badge.classList.add('badge-bound');
        badge.textContent = '更新既有';
      }
      if (hintEl) {
        hintEl.innerHTML =
          `儲存時會<strong>更新</strong>「${_esc(bound.roleName || bound.roleId)}」這筆記錄，不會新增。` +
          (bound.holderCount > 1
            ? `<br><span style="color:#b91c1c;">注意：這筆原本有 ${bound.holderCount} 位簽核者，更新後只會保留這一位。</span>`
            : '');
      }
    } else {
      tr.classList.remove('row-bound');
      if (badge) {
        badge.classList.remove('badge-bound');
        badge.textContent = `已建立 ${list.length} 筆`;
      }
      if (hintEl) {
        hintEl.innerHTML =
          `此人已是 ${list.length} 個角色的簽核者：${_esc(list.map((ex) => ex.roleName || ex.roleId).join('、'))}。` +
          `<br>維持現狀會<strong>另外新增</strong>一筆角色；要改既有的請於上方選取。`;
      }
    }
  }

  /**
   * 套用/解除「更新既有記錄」的綁定
   * @param {string} recordId - 空字串表示改回「建立為新角色」
   */
  function applyExistingBinding(gIdx, rIdx, recordId) {
    const tr = document.querySelector(`tr.br-data-row[data-gidx="${gIdx}"][data-ridx="${rIdx}"]`);
    if (!tr) return;

    const list = getExistingRoles(tr.dataset.code);
    const ex = recordId ? list.find((item) => item.recordId === recordId) : null;

    if (!ex) {
      tr.dataset.preexisting = '';
      tr.dataset.recordId = '';
      tr.dataset.signingMode = '';
      tr.dataset.dirty = '';
      updateRowStatus(tr, '');
    } else {
      tr.dataset.preexisting = 'true';
      tr.dataset.recordId = ex.recordId;
      tr.dataset.dirty = '';
      // 既有 signing_mode 先記著，避免更新時被卡片預設值默默覆蓋
      tr.dataset.signingMode = ex.signingMode || '';
      updateRowStatus(tr, 'saved');

      // 帶入既有值供 HR 就地修改
      const unitInput = tr.querySelector('.row-unit-select');
      const titleSelect = tr.querySelector('.row-title-select');
      const holderTypeSelect = tr.querySelector('.row-holder-type-select');
      if (unitInput) unitInput.value = ex.unitName;
      if (titleSelect) titleSelect.value = ex.titleLevel;
      if (holderTypeSelect && ex.holderType) holderTypeSelect.value = ex.holderType;
      toggleHolderTarget(gIdx, rIdx);
    }

    refreshExistingHint(tr, list, ex ? ex.recordId : '');
    updateSinglePreview(gIdx, rIdx);
    updateCardStatus(gIdx);
  }

  /**
   * 手動新增列：查出該人的職務並顯示，順便自動帶入 title_level（欄位仍為空時才帶）
   *
   * 這一列屬於哪張卡片就優先取該組織的職務；該人不屬於此組織時退回第一個組織，
   * 並在文字上標明是哪個單位的職務，避免誤會。
   */
  async function showJobTitleForRow(gIdx, rIdx, code) {
    const jobDiv = document.querySelector(`.new-row-job[data-gidx="${gIdx}"][data-ridx="${rIdx}"]`);
    if (!jobDiv) return;

    jobDiv.innerHTML = '<span style="opacity:.6;">職務查詢中…</span>';

    const orgs = await fetchUserOrgs(code);
    // 使用者可能在等待期間又改了人，確認 data-code 仍是同一人才寫入
    const tr = document.querySelector(`tr.br-data-row[data-gidx="${gIdx}"][data-ridx="${rIdx}"]`);
    if (!tr || normalize(tr.dataset.code) !== normalize(code)) return;

    const cardOrg = (_parsedGroups[gIdx] && _parsedGroups[gIdx].orgName) || '';
    const matched = orgs.find((o) => o.name === cardOrg) || orgs[0];
    const fromOtherOrg = matched && matched.name !== cardOrg;

    tr.dataset.jobtitle = (matched && matched.title) || '';

    const titleSelect = tr.querySelector('.row-title-select');
    const guessed = guessTitleLevel(matched ? matched.title : '');
    let appliedHtml = '';

    // 只在 title_level 還沒選時自動帶入，不覆蓋 HR 已經選好的值
    if (guessed.value && titleSelect && !titleSelect.value) {
      titleSelect.value = guessed.value;
      markRowDirty(tr);
      updateSinglePreview(gIdx, rIdx);
      appliedHtml = `<span class="job-applied${guessed.exact ? '' : ' job-applied-guess'}">${
        guessed.exact ? '已帶入 title_level' : '依職務推測，請確認'}</span>`;
    }

    jobDiv.innerHTML =
      `職務：${matched && matched.title
        ? `<span class="job-title">${_esc(matched.title)}</span>`
        : '<span class="job-title job-title-empty">（後台未設定）</span>'}` +
      (fromOtherOrg ? `<span style="opacity:.65;">（${_esc(matched.name)}）</span>` : '') +
      appliedHtml;
  }

  /** 處理人員搜尋輸入：比對 _userDirectory，更新 data-code 及顯示確認/錯誤訊息 */
  function handlePersonSearch(gIdx, rIdx, value) {
    const tr = document.querySelector(`tr.br-data-row[data-gidx="${gIdx}"][data-ridx="${rIdx}"]`);
    const infoDiv = document.querySelector(`.new-row-person-info[data-gidx="${gIdx}"][data-ridx="${rIdx}"]`);
    const holderPersonEl = document.querySelector(`[data-role="holder-person"][data-gidx="${gIdx}"][data-ridx="${rIdx}"]`);

    if (!_userDirectory) return;

    const jobDiv = document.querySelector(`.new-row-job[data-gidx="${gIdx}"][data-ridx="${rIdx}"]`);

    const term = normalize(value);
    if (!term) {
      if (tr) tr.dataset.code = '';
      if (infoDiv) { infoDiv.textContent = ''; infoDiv.style.color = ''; }
      if (jobDiv) jobDiv.innerHTML = '';
      if (holderPersonEl) holderPersonEl.innerHTML = '<div class="hp-placeholder">（選人後自動填入）</div>';
      updateExistingSlot(gIdx, rIdx);
      return;
    }

    // 先用登入名稱（唯一鍵）比對；沒中才用姓名，且姓名只認使用中的帳號
    const byCodeUser = _userDirectory.byCode.get(term);
    const named = byCodeUser ? null : resolveUserByName(_userDirectory, value);
    const user = byCodeUser || named?.user || null;

    // 用登入名稱指定到已停用帳號時，明確擋下並指出同名的在職帳號
    if (byCodeUser && !isActiveUser(byCodeUser)) {
      const alt = activeSameName(_userDirectory, byCodeUser.name, byCodeUser.code);
      if (tr) tr.dataset.code = '';
      if (infoDiv) {
        infoDiv.style.color = '#e74c3c';
        infoDiv.textContent =
          `${byCodeUser.name}（${byCodeUser.code}）已停用，不能設為簽核者` +
          (alt ? `；請改用「${alt.code}」` : '');
      }
      if (jobDiv) jobDiv.innerHTML = '';
      if (holderPersonEl) holderPersonEl.innerHTML = '<div class="hp-placeholder">（選人後自動填入）</div>';
      updateExistingSlot(gIdx, rIdx);
      return;
    }

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
      // 職務要打組織 API，非同步補上（有快取，同一人不會重複打）
      showJobTitleForRow(gIdx, rIdx, user.code).catch((err) =>
        console.warn('[batch-role-creator] showJobTitleForRow failed', err));
    } else {
      if (tr) tr.dataset.code = '';
      if (infoDiv) {
        infoDiv.style.color = '#e74c3c';
        // 同名有多個在職帳號、或只剩停用帳號時，resolveUserByName 會給出具體原因
        infoDiv.textContent = named?.error || '找不到使用者，請從建議清單選取';
      }
      if (jobDiv) jobDiv.innerHTML = '';
      if (holderPersonEl) holderPersonEl.innerHTML = '<div class="hp-placeholder">（選人後自動填入）</div>';
    }

    // 人選定後才知道是否已有角色，重繪該列的既有角色區塊
    updateExistingSlot(gIdx, rIdx);
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

    // 卡片級：依職務一鍵帶入 title_level
    document.querySelectorAll('.br-apply-job').forEach((button) => {
      button.addEventListener('click', (event) => applyJobTitlesToGroup(event.currentTarget.dataset.gidx));
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
      // 明確按下「套用全組」＝ HR 要用卡片的 signing_mode，解除既有值的保護
      row.dataset.signingMode = '';
      // 已綁定既有記錄的列被改動了，標成待更新
      markRowDirty(row);
    });

    updateOrgPreview(gIdx);
    const button = document.querySelector(`.br-apply-group[data-gidx="${gIdx}"]`);
    if (button) button.textContent = '已套用';
  }

  /**
   * 卡片級：依每列的職務一鍵帶入 title_level
   * 這是明確的手動動作，會覆蓋已選的值；對不到選項的列不動，並在按鈕旁回報結果。
   */
  function applyJobTitlesToGroup(gIdx) {
    const rows = [...document.querySelectorAll(`tr.br-data-row[data-gidx="${gIdx}"]`)];
    let applied = 0;
    const unmatched = [];

    rows.forEach((row) => {
      const titleSelect = row.querySelector('.row-title-select');
      if (!titleSelect) return;

      const jobTitle = row.dataset.jobtitle || '';
      const guessed = guessTitleLevel(jobTitle);

      if (guessed.value) {
        titleSelect.value = guessed.value;
        markRowDirty(row);
        applied++;
      } else {
        const nameEl = row.querySelector('.person-name');
        unmatched.push(nameEl ? nameEl.textContent.replace(/已建立.*$|更新既有$/, '').trim()
                              : (row.dataset.code || '未知'));
      }
    });

    updateOrgPreview(gIdx);

    const button = document.querySelector(`.br-apply-job[data-gidx="${gIdx}"]`);
    if (button) {
      button.textContent = unmatched.length
        ? `已帶入 ${applied} 列（${unmatched.length} 列無對應）`
        : `已帶入 ${applied} 列`;
      button.title = unmatched.length
        ? `職務對不到 title_level 選項，請手動選：${unmatched.join('、')}`
        : '依 kintone 後台的職務，自動填每一列的 title_level';
    }
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
      resp = await kintone.api(kintone.api.url('/k/v1/records.json', true), 'GET', params);
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
    // 最後一道保險：寫入 holder_user 前再確認該登入名稱目前是使用中
    // （避免 CSV 解析後帳號才被停用，或前端狀態殘留）
    if (holderType === HOLDER_TYPE_USER && _userDirectory) {
      const user = _userDirectory.byCode.get(normalize(code));
      if (user && !isActiveUser(user)) {
        const alt = activeSameName(_userDirectory, user.name, user.code);
        throw new Error(
          `「${nameDisplay}」的帳號「${code}」已停用，不能設為簽核者。` +
          (alt ? `同名的使用中帳號是「${alt.code}」。` : ''),
        );
      }
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

    // signing_mode：綁定既有記錄的列沿用原值（避免更新時被卡片預設值默默覆蓋），
    // 其餘（或 HR 按過「套用全組」）才用卡片批控下拉的值
    const signingSelect = gIdx
      ? document.querySelector(`.bulk-signing-select[data-gidx="${gIdx}"]`)
      : null;
    const signingMode = row.dataset.signingMode ||
      (signingSelect ? signingSelect.value : '任一人簽');

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
   * 永遠回傳 { records, updates, skipped }：
   *   records  — 要新增的 kintone record 物件陣列（含 role_id）
   *   updates  — 要更新的既有記錄 [{ id, record }]（列上選了「更新既有」且欄位有改動；
   *              選了但沒改任何欄位的列不送出，避免無謂覆蓋）
   *   skipped  — 被略過的列，格式 [{ name, reason }]
   *
   * 驗證或建構任一失敗時：
   *   - 略過該列，繼續處理其餘列（不中斷整批）
   *   - role_id 流水號只計入「新增」且成功的列，不留空缺
   */
  function buildRecords(startNum = 1) {
    const rows = [...document.querySelectorAll('tr.br-data-row')];
    const skipped = [];
    const records = [];
    const updates = [];
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
        if (row.dataset.recordId) {
          // 已存在的記錄：只有真的被改過（dirty）才更新。
          // 沒改就不送 PUT，避免把共用同一筆的其他簽核者洗掉。
          if (row.dataset.dirty === 'true') {
            updates.push({ id: row.dataset.recordId, record: buildRowRecord(row) });
          }
          return;
        }

        const rec = buildRowRecord(row);
        rec.role_id = { value: `ROLE_${String(seqNum++).padStart(4, '0')}` };
        records.push(rec);
      } catch (err) {
        skipped.push({ name: nameDisplay, reason: err.message });
      }
    });

    return { records, updates, skipped };
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
    // 匯入前就存在於 685、且被選為「更新既有」的列
    const boundCount = allRows.filter((tr) => tr.dataset.preexisting === 'true').length;

    const statusEl = document.getElementById(`card-status-${gIdx}`);
    const saveBtn  = document.querySelector(`.br-save-card[data-gidx="${gIdx}"]`);

    if (statusEl) {
      if (savedCount === total && total > 0 && dirtyCount === 0) {
        statusEl.textContent = `✓ ${total}/${total} 已建立`;
        statusEl.style.color = '#27ae60';
      } else if (savedCount > 0) {
        const parts = [];
        if (boundCount > 0)             parts.push(`${boundCount} 筆既有（會更新）`);
        if (savedCount - boundCount > 0) parts.push(`${savedCount - boundCount} 筆已建立`);
        if (dirtyCount > 0)             parts.push(`${dirtyCount} 筆待更新`);
        if (newCount > 0)               parts.push(`${newCount} 筆未建立`);
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

      const apiUrl = kintone.api.url('/k/v1/records.json', true);

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
    const { records: preCheck, updates: preUpdates, skipped: preSkipped } = buildRecords(1);

    if (!preCheck.length && !preUpdates.length) {
      const msg = preSkipped.length
        ? `所有 ${preSkipped.length} 列資料驗證失敗，無可送出的資料。`
        : '目前沒有可送出的資料。';
      alert(msg);
      return;
    }

    const skipNote = preSkipped.length ? `\n（${preSkipped.length} 列驗證失敗，將略過）` : '';
    const actionNote = [
      preCheck.length ? `新增 ${preCheck.length} 筆角色記錄` : '',
      preUpdates.length ? `更新 ${preUpdates.length} 筆既有記錄` : '',
    ].filter(Boolean).join('、');
    if (!confirm(`確定要${actionNote}嗎？${skipNote}`)) return;

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

    const { records, updates, skipped: validationSkipped } = buildRecords(maxNum + 1);

    if (!records.length && !updates.length) {
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
    let updated = 0;
    /** @type {{ name: string; reason: string }[]} */
    const apiFailed = [];

    console.log('[batch-role-creator] submitBatch appId:', appId, '| startNum:', maxNum + 1);
    if (records.length) {
      console.log('[batch-role-creator] records[0]:', JSON.stringify(records[0], null, 2));
    }
    showStatus(
      statusId,
      'info',
      `準備${records.length ? `新增 ${records.length} 筆（從 ROLE_${String(maxNum + 1).padStart(4, '0')} 起）` : ''}` +
      `${records.length && updates.length ? '、' : ''}` +
      `${updates.length ? `更新 ${updates.length} 筆既有記錄` : ''}` +
      `${validationSkipped.length ? `，略過 ${validationSkipped.length} 筆驗證失敗` : ''}...`,
    );

    for (let i = 0; i < records.length; i += chunkSize) {
      const chunk = records.slice(i, i + chunkSize);
      showStatus(statusId, 'info', `建立中... ${created} / ${records.length}`);

      try {
        await kintone.api(kintone.api.url('/k/v1/records.json', true), 'POST', {
          app: appId,
          records: chunk,
        });
        created += chunk.length;
      } catch (chunkErr) {
        // chunk 整批失敗 → 逐筆重試，把能過的記錄建起來
        console.warn('[submitBatch] chunk failed, retrying one by one:', formatKintoneError(chunkErr));
        for (const rec of chunk) {
          try {
            await kintone.api(kintone.api.url('/k/v1/records.json', true), 'POST', {
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

    // ②-2 更新已存在的記錄（列上選了「更新既有」）；同樣 chunk 失敗就逐筆重試
    for (let i = 0; i < updates.length; i += chunkSize) {
      const chunk = updates.slice(i, i + chunkSize);
      showStatus(statusId, 'info', `更新既有記錄中... ${updated} / ${updates.length}`);

      try {
        await kintone.api(kintone.api.url('/k/v1/records.json', true), 'PUT', {
          app: appId,
          records: chunk,
        });
        updated += chunk.length;
      } catch (chunkErr) {
        console.warn('[submitBatch] update chunk failed, retrying one by one:', formatKintoneError(chunkErr));
        for (const item of chunk) {
          try {
            await kintone.api(kintone.api.url('/k/v1/records.json', true), 'PUT', {
              app: appId,
              records: [item],
            });
            updated++;
          } catch (rowErr) {
            const roleName = (item.record.role_name && item.record.role_name.value) || `記錄 ${item.id}`;
            apiFailed.push({ name: roleName, reason: `更新失敗：${formatKintoneError(rowErr)}` });
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
        `完成：新增 ${created} 筆、更新 ${updated} 筆，${allSkipped.length} 筆略過（見下方彈窗）。`,
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
      showStatus(
        statusId,
        'success',
        `完成，共新增 ${created} 筆${updated ? `、更新 ${updated} 筆既有` : ''}角色記錄。畫面即將重新整理。`,
      );
      btn.textContent = '建立完成';
      setTimeout(() => location.reload(), 1500);
    }
  }

  /**
   * 關閉視窗
   *
   * 已經解析過 CSV（卡片區顯示中）就先確認——那代表使用者已經花時間分好組、
   * 設好每一列的單位與職稱，關掉就全沒了。還沒匯入資料時直接關，不囉嗦。
   */
  function closeModal() {
    const modal = document.getElementById('batch-role-modal');
    if (!modal || modal.style.display === 'none') return;

    const hasWork = document.getElementById('br-sec-table')?.style.display !== 'none';
    if (hasWork && !window.confirm('關閉後這次分好的卡片設定會消失，確定要關閉嗎？')) return;

    modal.style.display = 'none';
  }

  function bindEvents() {
    document.getElementById('br-btn-close').onclick = closeModal;
    document.getElementById('br-btn-x').onclick = closeModal;

    // Esc 關閉。掛在 document 上，因為焦點可能在視窗內任何一個輸入框。
    // 只在視窗開著時作用，不干擾 kintone 本身的鍵盤操作。
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const modal = document.getElementById('batch-role-modal');
      if (!modal || modal.style.display === 'none') return;
      closeModal();
    });

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

  // 掛在共用工具列（core/09-tool-registry.js）的「maintain」群組，不再自己長一顆按鈕
  window.ApprovalRouting.ToolRegistry.register({
    id:    'batch-role-creator',
    group: 'maintain',
    label: '批次角色建立',
    hint:  '用 CSV 一次建立或更新多筆角色記錄',
    apps:  [window.ApprovalRouting.Config.APP_ID.ROLE_DEFINITION],
    run:   () => {
      injectCSS();
      injectModal();
      document.getElementById('batch-role-modal').style.display = 'block';
    },
  });
})();
