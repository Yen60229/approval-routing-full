/**
 * 角色定義表 — 表單初始化：自動產生 role_id + 隱藏代碼欄位
 *
 * 【影響的欄位】
 *   - role_id: 新增時自動產生 ROLE_xxx 格式代碼（HR 不可見）
 *   - next_role_id: 對 HR 隱藏（由 03-next-role-dropdown.js 提供下拉 UI）
 *
 * 【依賴】
 *   - core/01-config.js（Config.ROLE_FIELDS, Config.ROLE_ID_PREFIX）
 *   - core/04-utils.js（Utils.safeHandler, Utils.kintoneApi）
 *
 * 【變更履歷】
 *   2026-04-18  Jimmy/Claude  初版建立
 *   2026-08-27  Jimmy/Claude  role_id 補零由 3 碼改為 4 碼（與規格書及 tools/04・05・06 一致，
 *                             這是 ROLE_599／ROLE_0598 混用的來源）；取最大號改為全量掃描，
 *                             不再依賴會被字串排序誤導的 order by role_id desc
 */
(() => {
  'use strict';

  const { ROLE_FIELDS: F, ROLE_ID_PREFIX, APP_ID } = window.ApprovalRouting.Config;
  const { safeHandler, kintoneApi } = window.ApprovalRouting.Utils;

  /** 隱藏純代碼欄位（role_id 保留顯示但鎖定，next_role_id 由下拉 UI 取代） */
  const hideCodeFields = () => {
    kintone.app.record.setFieldShown(F.NEXT_ROLE_ID, false);
  };

  /**
   * 取得目前最大 role_id 序號（全量掃描，取數字部分的最大值）
   *
   * ⚠️ 不可用 `order by role_id desc limit 500` 取第一筆：
   *    role_id 是文字欄位，kintone 依字串排序。位數一旦混用，
   *    字串序的 "ROLE_599" 會排在 "ROLE_0598" 前面，超過一頁時
   *    真正的最大號可能被切在 500 筆之外 → 產生重複代碼。
   *
   * @returns {Promise<number>}
   */
  const getMaxSequence = async () => {
    const LIMIT = 500;
    let offset = 0;
    let max = 0;

    for (;;) {
      const resp = await kintoneApi('/k/v1/records', 'GET', {
        app: APP_ID.ROLE_DEFINITION,
        fields: [F.ROLE_ID],
        query: `order by $id asc limit ${LIMIT} offset ${offset}`,
      });

      for (const rec of resp.records) {
        const val = rec[F.ROLE_ID].value || '';
        if (!val.startsWith(ROLE_ID_PREFIX)) continue;
        // 位數不論 3 碼或 4 碼，parseInt 後都是同一條號碼線
        const num = parseInt(val.slice(ROLE_ID_PREFIX.length), 10);
        if (Number.isInteger(num) && num > max) max = num;
      }

      if (resp.records.length < LIMIT) break;
      offset += LIMIT;
    }
    return max;
  };

  /**
   * 產生下一個 role_id
   * 格式：ROLE_0001, ROLE_0002, …（4 碼，與 docs/02-欄位代碼對照表.md
   * 及 tools/04・05・06 一致；原本這裡是 3 碼，才會出現 ROLE_599／ROLE_0598 混用）
   * @param {number} seq
   * @returns {string}
   */
  const generateRoleId = (seq) =>
    ROLE_ID_PREFIX + String(seq).padStart(4, '0');

  // --- 事件綁定 ---

  // 新增記錄：載入時自動產生 role_id，並隱藏所有代碼欄位
  kintone.events.on(
    ['app.record.create.show'],
    safeHandler(async (event) => {
      const seq = await getMaxSequence();
      event.record[F.ROLE_ID].value = generateRoleId(seq + 1);
      event.record[F.ROLE_ID].disabled = true;

      setTimeout(() => {
        hideCodeFields();
        kintone.app.record.setFieldShown(F.ROLE_ID, false); // HR 不需要看到技術代碼
      }, 0);

      return event;
    })
  );

  // 編輯記錄：role_id 鎖定不可改 + 隱藏所有代碼欄位（HR 不需看到技術代碼）
  kintone.events.on(
    ['app.record.edit.show', 'app.record.index.edit.show'],
    safeHandler(async (event) => {
      event.record[F.ROLE_ID].disabled = true;
      setTimeout(() => {
        hideCodeFields();
        kintone.app.record.setFieldShown(F.ROLE_ID, false); // 編輯頁不顯示角色代碼
      }, 0);
      return event;
    })
  );

  // 詳情頁：隱藏代碼欄位
  kintone.events.on(
    ['app.record.detail.show'],
    safeHandler(async (event) => {
      hideCodeFields();
      return event;
    })
  );
})();
