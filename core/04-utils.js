/**
 * 共用工具 — safeHandler、SweetAlert2 包裝、欄位操作輔助
 *
 * 【影響的欄位】
 *   - 無直接影響，提供其他模組使用的基礎設施
 *
 * 【依賴】
 *   - SweetAlert2（已全域載入）
 *   - core/01-config.js（window.ApprovalRouting.Config）
 *
 * 【變更履歷】
 *   2026-04-14  Jimmy/Claude  初版建立
 *   2026-07-12  Jimmy/Claude  新增 pushSubmitError / flushSubmitErrors：多支 JS 的 submit
 *                             驗證錯誤彙整為單一 SweetAlert，並以 event.error + return event
 *                             確實中止儲存（return null 擋不住儲存）
 */
(() => {
  'use strict';

  /**
   * 事件處理器包裹函式 — 統一 try/catch + SweetAlert 錯誤提示
   * @param {Function} fn - async event handler
   * @returns {Function} 包裹後的 handler
   */
  const safeHandler = (fn) => async (event) => {
    try {
      return await fn(event);
    } catch (err) {
      console.error('[ApprovalRouting]', err);
      await Swal.fire({
        icon: 'error',
        title: '系統錯誤',
        text: `發生非預期錯誤，請聯繫 IT。\n${err.message}`,
        confirmButtonText: '確定',
      });
      return event;
    }
  };

  /**
   * 成功提示
   * @param {string} msg
   */
  const showSuccess = (msg) => Swal.fire({
    icon: 'success',
    title: msg,
    timer: 1500,
    showConfirmButton: false,
  });

  /**
   * 警告提示（需使用者按確定）
   * @param {string} title
   * @param {string} [text]
   */
  const showWarning = (title, text) => Swal.fire({
    icon: 'warning',
    title,
    text,
    confirmButtonText: '確定',
  });

  /**
   * 確認對話框
   * @param {string} title
   * @param {string} [text]
   * @returns {Promise<boolean>}
   */
  const showConfirm = async (title, text) => {
    const result = await Swal.fire({
      icon: 'question',
      title,
      text,
      showCancelButton: true,
      confirmButtonText: '確定',
      cancelButtonText: '取消',
    });
    return result.isConfirmed;
  };

  /**
   * kintone REST API 呼叫封裝（簡易版，P4 會有完整 api-client）
   * @param {string} path - API 路徑，如 '/k/v1/records.json'
   * @param {string} method - GET / POST / PUT / DELETE
   * @param {Object} body - 請求參數
   * @returns {Promise<Object>}
   */
  const kintoneApi = (path, method, body) =>
    kintone.api(kintone.api.url(path, true), method, body);

  /**
   * 累積送出前的驗證錯誤到 event 物件上，供多支 JS 各自檢查同一 submit 事件時
   * 共用一份錯誤清單，避免每支各自跳一次 SweetAlert 造成連續彈窗。
   * 錯誤掛在 event 本身（而非全域變數），天然對應單次 submit 生命週期、無並發汙染風險。
   * @param {Object} event - kintone submit event
   * @param {string} message - 錯誤訊息（一句話，不含標點以外的 HTML）
   */
  const pushSubmitError = (event, message) => {
    event.__arSubmitErrors = event.__arSubmitErrors || [];
    event.__arSubmitErrors.push(message);
  };

  /**
   * 彙整並顯示 pushSubmitError 累積的所有錯誤（一次 SweetAlert），中止儲存。
   * 必須由掛在同一 submit 事件、且**最後執行**的 handler 呼叫（即上傳順序最後一支 JS），
   * 確保先前所有驗證 handler 都已把各自的錯誤 push 進來。
   *
   * 注意：kintone 的 submit 事件回傳 null/undefined 不會中止儲存，只會忽略對 event
   * 的修改（連 event.error 一起丟掉）。中止儲存的唯一方式是 event.error 設值後
   * return event，此時 kintone 會顯示原生錯誤橫幅並取消儲存（與 SweetAlert 雙重提示）。
   * @param {Object} event
   * @returns {Promise<Object>} 一律回傳 event；有錯誤時 event.error 已設值，kintone 據此中止儲存
   */
  const flushSubmitErrors = async (event) => {
    const errors = event.__arSubmitErrors;
    if (!errors || errors.length === 0) return event;

    event.error = '尚有欄位未填寫：' + errors.join('；');

    await Swal.fire({
      icon: 'warning',
      title: '尚有欄位未填寫',
      html: '請修正以下項目：<br><br>' + errors.map((m) => `• ${m}`).join('<br>'),
      confirmButtonText: '確定',
    });

    return event;
  };

  // 掛到全域
  window.ApprovalRouting = window.ApprovalRouting || {};
  window.ApprovalRouting.Utils = Object.freeze({
    safeHandler,
    showSuccess,
    showWarning,
    showConfirm,
    kintoneApi,
    pushSubmitError,
    flushSubmitErrors,
  });
})();
