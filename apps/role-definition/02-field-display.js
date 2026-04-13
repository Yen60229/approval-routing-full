/**
 * 角色定義表 — holder_type 條件顯示 group / user 欄位
 *
 * 【影響的欄位】
 *   - holder_group: holder_type=指定群組 時顯示，否則隱藏
 *   - holder_user:  holder_type=指定個人 時顯示，否則隱藏
 *
 * 【依賴】
 *   - core/01-config.js（Config.ROLE_FIELDS, Config.HOLDER_TYPE_OPTIONS）
 *   - core/04-utils.js（Utils.safeHandler）
 *
 * 【變更履歷】
 *   2026-04-14  Jimmy/Claude  初版建立
 */
(() => {
  'use strict';

  const { ROLE_FIELDS: F, HOLDER_TYPE_OPTIONS: HT } = window.ApprovalRouting.Config;
  const { safeHandler } = window.ApprovalRouting.Utils;

  /**
   * 根據 holder_type 切換欄位顯示
   * @param {string} holderType - 目前的 holder_type 值
   */
  const toggleHolderFields = (holderType) => {
    const isGroup = holderType === HT.GROUP;
    kintone.app.record.setFieldShown(F.HOLDER_GROUP, isGroup);
    kintone.app.record.setFieldShown(F.HOLDER_USER, !isGroup);
  };

  /**
   * 清除非選中類型的欄位值，避免殘留舊資料
   * @param {Object} record
   * @param {string} holderType
   */
  const clearInactiveHolder = (record, holderType) => {
    if (holderType === HT.GROUP) {
      record[F.HOLDER_USER].value = [];
    } else {
      record[F.HOLDER_GROUP].value = [];
    }
  };

  // --- 事件綁定 ---

  // 新增 / 編輯頁載入：根據目前值切換
  kintone.events.on(
    [
      'app.record.create.show',
      'app.record.edit.show',
      'app.record.index.edit.show',
    ],
    safeHandler(async (event) => {
      const holderType = event.record[F.HOLDER_TYPE].value;
      // show 事件中用 setTimeout 確保 setFieldShown 在 return 之後執行
      setTimeout(() => toggleHolderFields(holderType), 0);
      return event;
    })
  );

  // holder_type 變更時即時切換
  kintone.events.on(
    [
      `app.record.create.change.${F.HOLDER_TYPE}`,
      `app.record.edit.change.${F.HOLDER_TYPE}`,
      `app.record.index.edit.change.${F.HOLDER_TYPE}`,
    ],
    safeHandler(async (event) => {
      const holderType = event.record[F.HOLDER_TYPE].value;
      clearInactiveHolder(event.record, holderType);
      toggleHolderFields(holderType);
      return event;
    })
  );

  // 儲存前驗證：選中的類型必須有值
  kintone.events.on(
    [
      'app.record.create.submit',
      'app.record.edit.submit',
      'app.record.index.edit.submit',
    ],
    safeHandler(async (event) => {
      const rec = event.record;
      const holderType = rec[F.HOLDER_TYPE].value;

      if (holderType === HT.GROUP && (!rec[F.HOLDER_GROUP].value || rec[F.HOLDER_GROUP].value.length === 0)) {
        event.error = '請選擇簽核者群組';
        await Swal.fire({
          icon: 'warning',
          title: '欄位未填寫',
          text: '簽核者類型為「指定群組」時，請選擇簽核者群組。',
          confirmButtonText: '確定',
        });
      }

      if (holderType === HT.USER && (!rec[F.HOLDER_USER].value || rec[F.HOLDER_USER].value.length === 0)) {
        event.error = '請選擇簽核者（個人）';
        await Swal.fire({
          icon: 'warning',
          title: '欄位未填寫',
          text: '簽核者類型為「指定個人」時，請選擇簽核者。',
          confirmButtonText: '確定',
        });
      }

      return event;
    })
  );
})();
