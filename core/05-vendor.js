/**
 * 第三方函式庫檢查 — 確認 SweetAlert2 已載入
 *
 * 【影響的欄位】
 *   - 無
 *
 * 【依賴】
 *   - SweetAlert2（由 kintone 全域載入）
 *
 * 【變更履歷】
 *   2026-04-18  Jimmy/Claude  初版建立
 */
(() => {
  'use strict';

  if (typeof Swal === 'undefined') {
    console.error(
      '[ApprovalRouting] SweetAlert2 未載入！請在 kintone App 設定中加入 SweetAlert2 CDN。'
    );

    // 提供最低限度 fallback，避免其他模組呼叫 Swal 直接炸掉
    window.Swal = {
      fire: (opts) => {
        const msg = typeof opts === 'string' ? opts : opts.title || opts.text || '系統提示';
        window.alert(msg);
        return Promise.resolve({ isConfirmed: true });
      },
    };
  }
})();
