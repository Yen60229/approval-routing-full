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
 *   2026-04-18  Jimmy/Claude  初版建立
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
   * @param {string} path - API 路徑，如 '/k/v1/records'
   * @param {string} method - GET / POST / PUT / DELETE
   * @param {Object} body - 請求參數
   * @returns {Promise<Object>}
   */
  const kintoneApi = (path, method, body) =>
    kintone.api(kintone.api.url(path, true), method, body);

  // 掛到全域
  window.ApprovalRouting = window.ApprovalRouting || {};
  window.ApprovalRouting.Utils = Object.freeze({
    safeHandler,
    showSuccess,
    showWarning,
    showConfirm,
    kintoneApi,
  });
})();
