/**
 * 員工起點對照表 — CSV 批量匯入 + dry-run 模式
 *
 * 在列表頁加入「批量匯入」按鈕，HR 可上傳 CSV 一次建立多筆員工起點。
 * CSV 格式：employee_code,entry_role_id（第一列為標題列）
 *
 * 【影響的欄位】
 *   - employee: 由 CSV 的 employee_code 對應
 *   - entry_role_id: 由 CSV 的 entry_role_id 對應
 *   - is_active: 預設勾選「啟用中」
 *
 * 【依賴】
 *   - core/01-config.js（Config）
 *   - core/04-utils.js（Utils）
 *
 * 【變更履歷】
 *   2026-04-14  Jimmy/Claude  初版建立
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
   * @returns {Array<{employeeCode: string, entryRoleId: string}>}
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
        entryRoleId: cols[1] || '',
      };
    });
  };

  /**
   * 驗證匯入資料（dry-run）
   * @param {Array} rows
   * @returns {Promise<{valid: Array, errors: Array<string>}>}
   */
  const validateRows = async (rows) => {
    const errors = [];
    const valid = [];

    // 取得所有啟用角色 ID 做比對
    const resp = await kintoneApi('/k/v1/records', 'GET', {
      app: APP_ID.ROLE_DEFINITION,
      fields: [RF.ROLE_ID],
      query: `${RF.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}") limit 500`,
    });
    const activeRoleIds = new Set(resp.records.map((r) => r[RF.ROLE_ID].value));

    // 檢查重複的 employee_code
    const seen = new Map();

    for (const row of rows) {
      // 空值檢查
      if (!row.employeeCode) {
        errors.push(`第 ${row.row} 行：員工代碼為空`);
        continue;
      }
      if (!row.entryRoleId) {
        errors.push(`第 ${row.row} 行：起點角色為空`);
        continue;
      }

      // 角色是否存在
      if (!activeRoleIds.has(row.entryRoleId)) {
        errors.push(`第 ${row.row} 行：角色 ${row.entryRoleId} 不存在或未啟用`);
        continue;
      }

      // CSV 內重複檢查
      if (seen.has(row.employeeCode)) {
        errors.push(`第 ${row.row} 行：員工 ${row.employeeCode} 在 CSV 中重複（首次出現在第 ${seen.get(row.employeeCode)} 行）`);
        continue;
      }
      seen.set(row.employeeCode, row.row);

      valid.push(row);
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
        [F.ENTRY_ROLE_ID]: { value: row.entryRoleId },
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
    hint.textContent = 'CSV 格式：employee_code, entry_role_id（第一列為標題）';
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
