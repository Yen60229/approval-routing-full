/**
 * 角色定義表 — holder_type 條件顯示 group / user 欄位
 *
 * 【影響的欄位】
 *   - holder_group: holder_type=指定群組 時顯示，否則隱藏
 *   - holder_user:  holder_type=指定個人 時顯示，否則隱藏
 *   - 索引頁 holder_user 欄標題：改為「簽核者」；群組記錄填入群組名稱
 *
 * 【依賴】
 *   - core/01-config.js（Config.ROLE_FIELDS, Config.HOLDER_TYPE_OPTIONS）
 *   - core/04-utils.js（Utils.safeHandler）
 *
 * 【變更履歷】
 *   2026-04-18  Jimmy/Claude  初版建立
 *   2026-04-18  Jimmy/Claude  新增 detail.show 條件顯示；index.show 統一簽核者欄
 */
(() => {
  'use strict';

  const { ROLE_FIELDS: F, HOLDER_TYPE_OPTIONS: HT } =
    window.ApprovalRouting.Config;
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

  // 新增頁載入：清空非使用中欄位 + 切換顯示
  kintone.events.on(
    ['app.record.create.show'],
    safeHandler(async (event) => {
      const holderType = event.record[F.HOLDER_TYPE].value;
      clearInactiveHolder(event.record, holderType);
      setTimeout(() => toggleHolderFields(holderType), 0);
      return event;
    }),
  );

  // 編輯頁載入：只切換顯示，保留既有值
  kintone.events.on(
    ['app.record.edit.show', 'app.record.index.edit.show'],
    safeHandler(async (event) => {
      const holderType = event.record[F.HOLDER_TYPE].value;
      setTimeout(() => toggleHolderFields(holderType), 0);
      return event;
    }),
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
    }),
  );

  // 詳情頁：根據 holder_type 只顯示對應欄位
  kintone.events.on(
    ['app.record.detail.show'],
    safeHandler(async (event) => {
      toggleHolderFields(event.record[F.HOLDER_TYPE].value);
      return event;
    }),
  );

  /**
   * 索引頁「簽核者」欄整理：
   *   1. holder_user 欄標題：「簽核者（個人）」→「簽核者」
   *   2. 群組記錄：將 holder_group 名稱填入 holder_user 欄（原本空白）
   * @param {Object[]} records - event.records
   */
  /** 注入索引頁樣式（只注入一次） */
  const injectIndexStyle = () => {
    if (document.getElementById('ar-index-style')) return;
    const style = document.createElement('style');
    style.id = 'ar-index-style';
    style.textContent =
      '.recordlist-cell-gaia { vertical-align: middle !important; }';
    document.head.appendChild(style);
  };

  const renderIndexHolderColumn = (records) => {
    injectIndexStyle();

    // 1. 標題改名（用 innerText 偵測、innerHTML 替換，保留排序等子元素）
    document.querySelectorAll('th').forEach((th) => {
      if (th.innerText.includes('簽核者（個人）')) {
        th.innerHTML = th.innerHTML.replace('簽核者（個人）', '簽核者');
      }
    });

    // 2. 用 getFieldElements 精準取得 holder_user 各列的 cell
    const userCells = kintone.app.getFieldElements(F.HOLDER_USER);
    if (!userCells) return;

    records.forEach((rec, idx) => {
      if (rec[F.HOLDER_TYPE].value !== HT.GROUP) return;
      const groupVal = rec[F.HOLDER_GROUP].value;
      if (!groupVal || groupVal.length === 0) return;
      const cell = userCells[idx];
      if (!cell) return;
      cell.innerHTML = groupVal
        .map(
          (g) =>
            `<div><div><span class="recordlist-entityname-gaia"><img src="https://static.cybozu.com/contents/k/image/argo/form/userselect/group16.png" width="16" height="16"><span>${g.name}</span></span></div></div>`,
        )
        .join('');
    });
  };

  // 索引頁：統一「簽核者」欄顯示
  kintone.events.on(
    ['app.record.index.show'],
    safeHandler(async (event) => {
      setTimeout(() => renderIndexHolderColumn(event.records), 0);
      return event;
    }),
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

      // 儲存前強制清除非使用中的 holder 欄位，防止殘留舊資料寫入 DB
      clearInactiveHolder(rec, holderType);

      if (
        holderType === HT.GROUP &&
        (!rec[F.HOLDER_GROUP].value || rec[F.HOLDER_GROUP].value.length === 0)
      ) {
        event.error = '請選擇簽核者群組';
        await Swal.fire({
          icon: 'warning',
          title: '欄位未填寫',
          text: '簽核者類型為「指定群組」時，請選擇簽核者群組。',
          confirmButtonText: '確定',
        });
      }

      if (
        holderType === HT.USER &&
        (!rec[F.HOLDER_USER].value || rec[F.HOLDER_USER].value.length === 0)
      ) {
        event.error = '請選擇簽核者（個人）';
        await Swal.fire({
          icon: 'warning',
          title: '欄位未填寫',
          text: '簽核者類型為「指定個人」時，請選擇簽核者。',
          confirmButtonText: '確定',
        });
      }

      return event;
    }),
  );
})();
