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
   * 取得目前最大 role_id 序號
   * 查詢所有 role_id，擷取數字部分取最大值
   * @returns {Promise<number>}
   */
  const getMaxSequence = async () => {
    const resp = await kintoneApi('/k/v1/records', 'GET', {
      app: APP_ID.ROLE_DEFINITION,
      fields: [F.ROLE_ID],
      query: `order by ${F.ROLE_ID} desc limit 500`,
    });

    let max = 0;
    for (const rec of resp.records) {
      const val = rec[F.ROLE_ID].value || '';
      const num = parseInt(val.replace(ROLE_ID_PREFIX, ''), 10);
      if (num > max) max = num;
    }
    return max;
  };

  /**
   * 產生下一個 role_id
   * 格式：ROLE_001, ROLE_002, ...
   * @param {number} seq
   * @returns {string}
   */
  const generateRoleId = (seq) =>
    ROLE_ID_PREFIX + String(seq).padStart(3, '0');

  // --- 事件綁定 ---

  // 新增記錄：載入時自動產生 role_id
  kintone.events.on(
    ['app.record.create.show'],
    safeHandler(async (event) => {
      const seq = await getMaxSequence();
      event.record[F.ROLE_ID].value = generateRoleId(seq + 1);

      // role_id 設為不可編輯（程式產生，HR 不該改）
      event.record[F.ROLE_ID].disabled = true;

      // 先 return event 再隱藏欄位（kintone 規則：set 之後才 setFieldShown）
      // 但 show 事件中 return event 等同 set，所以用 setTimeout 確保順序
      setTimeout(hideCodeFields, 0);

      return event;
    })
  );

  // 編輯記錄：role_id 鎖定不可改 + 隱藏代碼欄位
  kintone.events.on(
    ['app.record.edit.show', 'app.record.index.edit.show'],
    safeHandler(async (event) => {
      event.record[F.ROLE_ID].disabled = true;
      setTimeout(hideCodeFields, 0);
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
