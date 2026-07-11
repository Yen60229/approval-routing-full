/**
 * 角色定義表 — unit_name / title_level 詳情頁隱藏 + 送出驗證
 *
 * 【影響的欄位】
 *   - unit_name:   詳情頁隱藏（由 role_name 計算欄位呈現即可）
 *   - title_level: 詳情頁隱藏（同上）
 *   - role_name:   計算欄位，JS 不碰
 *
 * 【依賴】
 *   - core/01-config.js（Config.ROLE_FIELDS）
 *   - core/04-utils.js（Utils.safeHandler）
 *
 * 【變更履歷】
 *   2026-04-27  Jimmy/Claude  初版建立
 *   2026-04-27  Jimmy/Claude  改回原生下拉，移除自訂 UI
 *   2026-07-12  Jimmy/Claude  作為最後執行的驗證 handler，統一彙整 02/03/07 的錯誤
 *                             一次顯示；並修正 return null 擋不住儲存的潛在問題
 */
(() => {
  'use strict';

  const { ROLE_FIELDS: F } = window.ApprovalRouting.Config;
  const { safeHandler, pushSubmitError, flushSubmitErrors } = window.ApprovalRouting.Utils;

  // 詳情頁：unit_name / title_level 隱藏，role_name 計算結果已足夠呈現
  kintone.events.on(
    'app.record.detail.show',
    safeHandler(async (event) => {
      kintone.app.record.setFieldShown(F.UNIT_NAME,   false);
      kintone.app.record.setFieldShown(F.TITLE_LEVEL, false);
      return event;
    }),
  );

  // 送出前驗證：unit_name + title_level 均不可為空。
  // 本檔依上傳順序最後載入，是最後一個執行的驗證 handler：先檢查自己的條件、
  // push 進共用錯誤清單，再呼叫 flushSubmitErrors 彙整「本檔 + 02 + 03」全部的
  // 錯誤，一次 SweetAlert 顯示，取代過去每支各自跳窗、連續彈出的問題。
  kintone.events.on(
    ['app.record.create.submit', 'app.record.edit.submit'],
    safeHandler(async (event) => {
      const record   = event.record;
      const unitVal  = record[F.UNIT_NAME]?.value  || '';
      const titleVal = record[F.TITLE_LEVEL]?.value || '';

      if (!unitVal)  pushSubmitError(event, '請填寫單位。');
      if (!titleVal) pushSubmitError(event, '請填寫職稱。');

      return flushSubmitErrors(event);
    }),
  );
})();
