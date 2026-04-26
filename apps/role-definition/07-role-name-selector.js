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
 */
(() => {
  'use strict';

  const { ROLE_FIELDS: F } = window.ApprovalRouting.Config;
  const { safeHandler } = window.ApprovalRouting.Utils;

  // 詳情頁：unit_name / title_level 隱藏，role_name 計算結果已足夠呈現
  kintone.events.on(
    'app.record.detail.show',
    safeHandler(async (event) => {
      kintone.app.record.setFieldShown(F.UNIT_NAME,   false);
      kintone.app.record.setFieldShown(F.TITLE_LEVEL, false);
      return event;
    }),
  );

  // 送出前驗證：unit_name + title_level 均不可為空
  kintone.events.on(
    ['app.record.create.submit', 'app.record.edit.submit'],
    safeHandler(async (event) => {
      const record   = event.record;
      const unitVal  = record[F.UNIT_NAME]?.value  || '';
      const titleVal = record[F.TITLE_LEVEL]?.value || '';

      if (unitVal && titleVal) return event;

      const missing = [];
      if (!unitVal)  missing.push('單位');
      if (!titleVal) missing.push('職稱');

      await Swal.fire({
        icon:              'warning',
        title:             '必填欄位未填寫',
        html:              `請填寫：<strong>${missing.join('、')}</strong>`,
        confirmButtonText: '確定',
      });

      return null;
    }),
  );
})();
