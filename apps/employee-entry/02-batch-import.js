/**
 * 員工起點對照表 — CSV 批量匯入 + dry-run 模式
 *
 * 在列表頁加入「批量匯入」按鈕，HR 可上傳 CSV 一次建立多筆員工起點。
 * CSV 格式：員工帳號,角色名稱（第一列為標題列）
 * 角色欄填 HR 看得懂的角色名稱（如 MIS_課長），程式查角色表轉成 role_id 寫入，
 * 與兩表 UI「代碼對 HR 完全隱藏」的原則一致。
 *
 * 【影響的欄位】
 *   - employee: 由 CSV 的員工帳號對應（dry-run 會驗證帳號存在於 kintone）
 *   - entry_role_id: 由 CSV 的角色名稱查表轉為 role_id 寫入
 *   - is_active: 預設勾選「啟用中」
 *
 * 【依賴】
 *   - core/01-config.js（Config）
 *   - core/04-utils.js（Utils）
 *
 * 【變更履歷】
 *   2026-04-18  Jimmy/Claude  初版建立
 *   2026-07-12  Jimmy/Claude  CSV 第二欄由 role_id 改為角色名稱（同名角色取代表 role_id，
 *                             與下拉去重邏輯一致）；dry-run 加驗員工帳號存在、
 *                             已有起點設定的員工列為跳過——匯入中斷後同一份 CSV
 *                             可直接重傳，不會產生重複記錄
 */
(() => {
  'use strict';

  const {
    APP_ID,
    ROLE_FIELDS: RF,
    ENTRY_FIELDS: F,
    CHECKBOX,
  } = window.ApprovalRouting.Config;
  const { safeHandler, kintoneApi, showSuccess, showWarning } = window.ApprovalRouting.Utils;

  const BTN_ID = 'ar-batch-import-btn';
  const INPUT_ID = 'ar-csv-file-input';

  /**
   * 解析 CSV 文字內容
   * @param {string} text
   * @returns {Array<{row: number, employeeCode: string, roleName: string}>}
   */
  const parseCsv = (text) => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return [];

    // 跳過標題列
    return lines.slice(1).map((line, idx) => {
      const cols = line.split(',').map((c) => c.trim());
      return {
        row: idx + 2, // 人類看的行號（標題是第 1 行）
        employeeCode: cols[0] || '',
        roleName: cols[1] || '',
      };
    });
  };

  /** 將陣列切成固定大小的批次（API 的 codes / in 查詢皆有筆數上限） */
  const chunk = (arr, size) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };

  /**
   * 查詢哪些員工帳號實際存在於 kintone
   * @param {string[]} codes - 去重後的員工帳號清單
   * @returns {Promise<Set<string>>} 存在的帳號集合
   */
  const fetchExistingUserCodes = async (codes) => {
    const found = new Set();
    // User API 路徑不帶 /k、直接傳給 kintone.api（與 04-chain-preview 的
    // /v1/group/users 同一種呼叫方式，已在本專案實測可行）；codes 單次上限 100 筆
    const results = await Promise.all(
      chunk(codes, 100).map((part) =>
        kintone.api('/v1/users', 'GET', { codes: part }),
      ),
    );
    for (const resp of results) {
      for (const u of resp.users || []) found.add(u.code);
    }
    return found;
  };

  /**
   * 查詢哪些員工在本表已有起點設定（避免重複匯入；匯入中斷後可直接重傳同一份 CSV）
   * @param {string[]} codes - 去重後的員工帳號清單
   * @returns {Promise<Set<string>>} 已有記錄的帳號集合
   */
  const fetchAlreadyConfiguredCodes = async (codes) => {
    const found = new Set();
    // in 查詢的值不宜過長，每批 50 個帳號
    const results = await Promise.all(
      chunk(codes, 50).map((part) => {
        const list = part.map((c) => `"${c}"`).join(', ');
        return kintoneApi('/k/v1/records', 'GET', {
          app: APP_ID.EMPLOYEE_ENTRY,
          fields: [F.EMPLOYEE],
          query: `${F.EMPLOYEE} in (${list}) limit 500`,
        });
      }),
    );
    for (const resp of results) {
      for (const r of resp.records) {
        for (const u of r[F.EMPLOYEE]?.value || []) found.add(u.code);
      }
    }
    return found;
  };

  /**
   * 驗證匯入資料（dry-run）
   * 檢查五件事：空值、角色名稱存在、員工帳號存在、本表已有起點（跳過）、CSV 內重複。
   * 角色以「名稱」比對並轉成 role_id（同名角色取第一筆為代表，與下拉去重邏輯一致）。
   * @param {Array} rows
   * @returns {Promise<{valid: Array, errors: Array<string>}>}
   */
  const validateRows = async (rows) => {
    const errors = [];
    const valid = [];

    // 啟用角色的 名稱 → role_id 對照（同名取第一筆為代表）
    const resp = await kintoneApi('/k/v1/records', 'GET', {
      app: APP_ID.ROLE_DEFINITION,
      fields: [RF.ROLE_ID, RF.ROLE_NAME],
      query: `${RF.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}") limit 500`,
    });
    const roleIdByName = new Map();
    for (const r of resp.records) {
      const name = r[RF.ROLE_NAME].value;
      if (!roleIdByName.has(name)) roleIdByName.set(name, r[RF.ROLE_ID].value);
    }

    // 一次撈齊帳號相關資訊：kintone 使用者是否存在、本表是否已有起點
    const allCodes = [...new Set(rows.map((r) => r.employeeCode).filter(Boolean))];
    const [existingUsers, alreadyConfigured] = await Promise.all([
      fetchExistingUserCodes(allCodes),
      fetchAlreadyConfiguredCodes(allCodes),
    ]);

    // 檢查重複的員工帳號
    const seen = new Map();

    for (const row of rows) {
      // 空值檢查
      if (!row.employeeCode) {
        errors.push(`第 ${row.row} 行：員工帳號為空`);
        continue;
      }
      if (!row.roleName) {
        errors.push(`第 ${row.row} 行：角色名稱為空`);
        continue;
      }

      // 角色名稱是否存在（比對啟用中角色）
      const roleId = roleIdByName.get(row.roleName);
      if (!roleId) {
        errors.push(`第 ${row.row} 行：角色「${row.roleName}」不存在或未啟用（請確認與角色表的名稱完全一致）`);
        continue;
      }

      // 員工帳號是否存在於 kintone
      if (!existingUsers.has(row.employeeCode)) {
        errors.push(`第 ${row.row} 行：員工帳號「${row.employeeCode}」在 kintone 中不存在`);
        continue;
      }

      // 本表已有該員工的起點設定 → 跳過（讓中斷後重傳同一份 CSV 成為安全操作）
      if (alreadyConfigured.has(row.employeeCode)) {
        errors.push(`第 ${row.row} 行：員工「${row.employeeCode}」已有起點設定，跳過（如需變更請直接編輯該筆記錄）`);
        continue;
      }

      // CSV 內重複檢查
      if (seen.has(row.employeeCode)) {
        errors.push(`第 ${row.row} 行：員工 ${row.employeeCode} 在 CSV 中重複（首次出現在第 ${seen.get(row.employeeCode)} 行）`);
        continue;
      }
      seen.set(row.employeeCode, row.row);

      valid.push({ ...row, roleId });
    }

    return { valid, errors };
  };

  /**
   * 執行批量新增（每次最多 100 筆，kintone API 限制）
   * @param {Array} rows
   * @returns {Promise<number>} 成功筆數
   */
  const executeBatchInsert = async (rows) => {
    let inserted = 0;
    const BATCH_SIZE = 100;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const records = batch.map((row) => ({
        [F.EMPLOYEE]: { value: [{ code: row.employeeCode }] },
        [F.ENTRY_ROLE_ID]: { value: row.roleId }, // dry-run 已由角色名稱轉出 role_id
        [F.IS_ACTIVE]: { value: [CHECKBOX.ACTIVE] },
      }));

      await kintoneApi('/k/v1/records', 'POST', {
        app: APP_ID.EMPLOYEE_ENTRY,
        records,
      });
      inserted += batch.length;
    }

    return inserted;
  };

  /**
   * 顯示 dry-run 結果，讓 HR 確認後才真正匯入
   * @param {Array} valid
   * @param {Array<string>} errors
   * @returns {Promise<boolean>} HR 是否確認執行
   */
  const showDryRunResult = async (valid, errors) => {
    const errorHtml = errors.length > 0
      ? `<div style="text-align:left; max-height:200px; overflow-y:auto; margin-bottom:12px; padding:8px; background:#fff3cd; border-radius:4px; font-size:13px;">
           <strong>⚠ 以下 ${errors.length} 筆有問題（將跳過）：</strong><br>
           ${errors.map((e) => `・${e}`).join('<br>')}
         </div>`
      : '';

    const result = await Swal.fire({
      icon: errors.length > 0 ? 'warning' : 'info',
      title: '匯入預覽（Dry Run）',
      html: `
        ${errorHtml}
        <div style="font-size:15px;">
          可匯入：<strong>${valid.length} 筆</strong><br>
          ${errors.length > 0 ? `跳過：<strong>${errors.length} 筆</strong>` : ''}
        </div>
        <p style="margin-top:12px; color:#666;">確定要執行匯入嗎？</p>
      `,
      showCancelButton: true,
      confirmButtonText: `確定匯入 ${valid.length} 筆`,
      cancelButtonText: '取消',
      confirmButtonColor: '#3085d6',
    });

    return result.isConfirmed;
  };

  /**
   * 主流程：讀取 CSV → dry-run → 確認 → 匯入
   */
  const handleImport = async () => {
    const input = document.getElementById(INPUT_ID);
    if (!input || !input.files || input.files.length === 0) {
      await showWarning('請選擇檔案', '請先選擇 CSV 檔案再點匯入。');
      return;
    }

    const file = input.files[0];
    if (!file.name.endsWith('.csv')) {
      await showWarning('格式錯誤', '請上傳 .csv 格式的檔案。');
      return;
    }

    const text = await file.text();
    const rows = parseCsv(text);

    if (rows.length === 0) {
      await showWarning('檔案為空', 'CSV 中沒有可匯入的資料（需至少 2 行：標題 + 資料）。');
      return;
    }

    // Dry-run 驗證
    Swal.fire({ title: '驗證中...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    const { valid, errors } = await validateRows(rows);
    Swal.close();

    if (valid.length === 0) {
      await showWarning('無可匯入資料', errors.join('\n'));
      return;
    }

    // 顯示 dry-run 結果
    const confirmed = await showDryRunResult(valid, errors);
    if (!confirmed) return;

    // 執行匯入
    Swal.fire({ title: '匯入中...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    const count = await executeBatchInsert(valid);
    Swal.close();

    await showSuccess(`成功匯入 ${count} 筆！`);

    // 清空檔案選擇 + 重新整理列表
    input.value = '';
    location.reload();
  };

  /**
   * 在列表頁插入匯入 UI
   */
  const mountImportUI = () => {
    if (document.getElementById(BTN_ID)) return;

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 8px 0;';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = INPUT_ID;
    fileInput.accept = '.csv';
    fileInput.style.cssText = 'font-size: 14px;';

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.textContent = '批量匯入';
    btn.style.cssText = 'font-size: 14px; padding: 8px 20px; background: #3498db; color: #fff; border: none; border-radius: 4px; cursor: pointer;';
    btn.addEventListener('click', async () => {
      try {
        await handleImport();
      } catch (err) {
        console.error('[ApprovalRouting] 批量匯入錯誤', err);
        await Swal.fire({
          icon: 'error',
          title: '匯入失敗',
          text: err.message,
          confirmButtonText: '確定',
        });
      }
    });

    const hint = document.createElement('span');
    hint.textContent = 'CSV 格式：員工帳號, 角色名稱（第一列為標題，例：jimmy001, MIS_課長）';
    hint.style.cssText = 'font-size: 12px; color: #999;';

    wrapper.appendChild(fileInput);
    wrapper.appendChild(btn);
    wrapper.appendChild(hint);

    const headerSpace = document.querySelector('.gaia-argoui-app-index-toolbar') ||
                        document.querySelector('.contents-actionmenu-gaia');
    if (headerSpace) {
      headerSpace.appendChild(wrapper);
    }
  };

  // --- 事件綁定 ---

  kintone.events.on(
    ['app.record.index.show'],
    safeHandler(async (event) => {
      mountImportUI();
      return event;
    })
  );
})();
