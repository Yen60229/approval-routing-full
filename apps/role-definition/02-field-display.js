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
 *   2026-07-12  Jimmy/Claude  submit 驗證改為累積錯誤（pushSubmitError），彈窗交由
 *                             最後執行的 07 統一彙整；index.edit.submit 自行彙整
 */
(() => {
  'use strict';

  const { ROLE_FIELDS: F, HOLDER_TYPE_OPTIONS: HT } =
    window.ApprovalRouting.Config;
  const { safeHandler, pushSubmitError, flushSubmitErrors } = window.ApprovalRouting.Utils;

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

    // 1. 標題改名：只動文字節點，不碰 kintone 注入的 resize handle 等子元素
    //    （innerHTML 整個替換會讓 resize handle 失去事件監聽器，導致欄寬鎖死）
    document.querySelectorAll('th').forEach((th) => {
      if (!th.innerText.includes('簽核者（個人）')) return;
      const walker = document.createTreeWalker(th, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue.includes('簽核者（個人）')) {
          node.nodeValue = node.nodeValue.replace('簽核者（個人）', '簽核者');
          break; // 只改第一個符合的文字節點即可
        }
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

  /**
   * holder_type 對應的必填檢查，回傳缺失時的錯誤訊息（無缺失回傳 null）。
   * 供 create/edit（累積錯誤）與 index.edit（單一事件，立即彙整）共用。
   * @param {Object} rec - event.record
   * @returns {string|null}
   */
  const checkHolderRequired = (rec) => {
    const holderType = rec[F.HOLDER_TYPE].value;
    clearInactiveHolder(rec, holderType); // 儲存前強制清除非使用中的 holder 欄位，防止殘留舊資料寫入 DB

    if (holderType === HT.GROUP && (!rec[F.HOLDER_GROUP].value || rec[F.HOLDER_GROUP].value.length === 0)) {
      return '簽核者類型為「指定群組」時，請選擇簽核者群組。';
    }
    if (holderType === HT.USER && (!rec[F.HOLDER_USER].value || rec[F.HOLDER_USER].value.length === 0)) {
      return '簽核者類型為「指定個人」時，請選擇簽核者。';
    }
    return null;
  };

  // 儲存前驗證（新增/編輯）：只累積錯誤，不在此彈窗——由最後執行的驗證 handler
  // （07-role-name-selector.js，依上傳順序最後載入）統一彙整顯示一次 SweetAlert。
  kintone.events.on(
    ['app.record.create.submit', 'app.record.edit.submit'],
    safeHandler(async (event) => {
      const message = checkHolderRequired(event.record);
      if (message) pushSubmitError(event, message);
      return event;
    }),
  );

  // 清單頁行內編輯：本檔是唯一掛在此事件的驗證來源，驗證完立即彙整顯示（無需等其他 handler）
  kintone.events.on(
    ['app.record.index.edit.submit'],
    safeHandler(async (event) => {
      const message = checkHolderRequired(event.record);
      if (message) pushSubmitError(event, message);
      return flushSubmitErrors(event);
    }),
  );
})();
