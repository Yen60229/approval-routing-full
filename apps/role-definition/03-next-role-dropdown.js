/**
 * 角色定義表 — next_role_id 下拉選單 UI
 *
 * 原生 next_role_id 是文字欄位（已由 01-role-form-init 隱藏），
 * 本檔在空白欄位旁動態產生下拉選單，HR 用點的選「下一關角色」。
 *
 * 【影響的欄位】
 *   - next_role_id: 由下拉選單寫入值
 *   - is_chain_end: 勾選時清空 next_role_id 並隱藏下拉
 *
 * 【依賴】
 *   - core/01-config.js（Config）
 *   - core/04-utils.js（Utils）
 *   - core/07-role-picker.js（RolePicker）← 需排在本檔之前載入
 *
 * 【變更履歷】
 *   2026-04-18  Jimmy/Claude  初版建立
 *   2026-06-02  Jimmy/Claude  下拉選項依 role_name 開頭（unit_name 單位）分組排序，
 *                              並對完整 role_name 去重，方便 HR 在大量角色中定位。
 *                              下拉識別一律以 role_name 為準（role_id 僅作寫入用），
 *                              同名角色不論存哪個 role_id，開啟記錄都能正確顯示。
 *   2026-07-12  Jimmy/Claude  submit 驗證改為累積錯誤（pushSubmitError），彈窗交由
 *                              最後執行的 07 統一彙整
 *   2026-09-01  Jimmy/Claude  可搜尋下拉 UI 抽到 core/07-role-picker.js 共用（form-route
 *                              子表格也要用）。本檔只保留「抓角色 + 綁 kintone 欄位 + 事件」，
 *                              UI 交給 RolePicker；順帶多了 ↑↓／Enter／Esc 鍵盤操作
 */
(() => {
  'use strict';

  const { APP_ID, ROLE_FIELDS: F, CHECKBOX } = window.ApprovalRouting.Config;
  const { safeHandler, kintoneApi, pushSubmitError } = window.ApprovalRouting.Utils;

  const DROPDOWN_ID = 'ar-next-role-dropdown';
  const CONTAINER_ID = 'ar-next-role-container';

  const UNGROUPED_LABEL = '（未分類）';

  /**
   * 取得所有啟用中的角色清單（排除自己）
   *
   * 依 role_name 開頭（unit_name 單位）→ role_name 排序，
   * 並對「完整 role_name」去重：同名角色只保留第一筆，
   * 避免重複資料造成下拉出現同名選項。
   *
   * @param {string} [excludeRoleId] - 排除自身的 role_id
   * @returns {Promise<{roles: Array<{roleId: string, roleName: string, unitName: string}>, nameById: Map<string, string>}>}
   *          roles：已依 unitName 分群、排序且對 role_name 去重的下拉選項；
   *          nameById：所有啟用角色（去重前）的 role_id → role_name 對照，供初始值顯示用
   */
  const fetchActiveRoles = async (excludeRoleId) => {
    const resp = await kintoneApi('/k/v1/records', 'GET', {
      app: APP_ID.ROLE_DEFINITION,
      fields: [F.ROLE_ID, F.ROLE_NAME, F.UNIT_NAME],
      query:
        `${F.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}") ` +
        `order by ${F.UNIT_NAME} asc, ${F.ROLE_NAME} asc limit 500`,
    });

    const nameById = new Map();    // 去重前先建立完整對照，確保初始值（任一 role_id）都查得到名稱
    const seenRoleName = new Set();
    const roles = [];

    for (const r of resp.records) {
      const roleId = r[F.ROLE_ID].value;
      const roleName = r[F.ROLE_NAME].value;

      nameById.set(roleId, roleName);

      if (roleId === excludeRoleId) continue;   // 排除自己
      if (seenRoleName.has(roleName)) continue;  // 完整 role_name 去重（同名視為同一關）
      seenRoleName.add(roleName);

      roles.push({
        roleId,
        roleName,
        unitName: r[F.UNIT_NAME]?.value || UNGROUPED_LABEL,
      });
    }

    return { roles, nameById };
  };

  /**
   * 建立「下一關角色」可搜尋下拉（UI 由 core/07-role-picker.js 提供）
   *
   * 本檔只負責：把角色清單餵給 RolePicker、選到之後同步寫入 next_role_id 並刷新預覽。
   * 識別仍以 role_name 為準（role_id 僅在寫入時使用），同名去重見 fetchActiveRoles。
   *
   * @param {Array<{roleId: string, roleName: string, unitName: string}>} roles
   * @param {Map<string, string>} nameById - 所有啟用角色的 role_id → role_name 對照
   * @param {string} currentRoleId - 當前記錄的 role_id（刷新預覽用）
   * @param {string} currentValue  - 目前的 next_role_id
   * @returns {HTMLElement} container（已帶 CONTAINER_ID）
   */
  const buildDropdownUI = (roles, nameById, currentRoleId, currentValue) => {
    const picker = window.ApprovalRouting.RolePicker.create({
      options: roles.map((r) => ({ id: r.roleId, name: r.roleName, group: r.unitName })),
      initialId: currentValue,
      initialName: nameById.get(currentValue) || '',
      labelText: '下一關角色：',
      placeholder: '輸入角色名稱搜尋…',
      emptyText: '找不到符合的角色',
      ungroupedLabel: UNGROUPED_LABEL,
      inputId: DROPDOWN_ID,
      onSelect: async (opt) => {
        // 同步寫入 kintone 欄位
        const rec = kintone.app.record.get();
        rec.record[F.NEXT_ROLE_ID].value = opt.id;
        kintone.app.record.set(rec);

        // 通知 chain-preview 刷新（kintone.app.record.set 不觸發 change 事件）
        await window.ApprovalRouting.ChainPreview?.refresh(currentRoleId);
      },
    });

    picker.el.id = CONTAINER_ID;
    return picker.el;
  };

  /**
   * 將下拉選單掛入 chain_preview 空白欄位（Timeline 下方）
   * 讓「鏈視覺化」與「下一關選擇」在同一區塊，視覺邏輯連貫
   */
  const mountDropdown = (container) => {
    const old = document.getElementById(CONTAINER_ID);
    if (old) old.remove();

    // 掛在 chain_preview space 內部最尾端（Timeline 之後）
    const spaceEl = kintone.app.record.getSpaceElement('chain_preview');
    if (spaceEl) {
      spaceEl.appendChild(container);
      return;
    }

    // fallback
    const formEl = document.querySelector('.gaia-argoui-app-edit-record') ||
                   document.querySelector('#record-gaia');
    if (formEl) formEl.appendChild(container);
  };


  /**
   * 判斷是否為鏈終點
   * @param {Object} record
   * @returns {boolean}
   */
  const isChainEnd = (record) => {
    const val = record[F.IS_CHAIN_END].value;
    return Array.isArray(val) && val.includes(CHECKBOX.CHAIN_END);
  };

  /**
   * 初始化下拉 UI（新增/編輯頁共用）
   */
  const initDropdown = async (event) => {
    const rec = event.record;
    const currentRoleId = rec[F.ROLE_ID].value;
    const currentNext = rec[F.NEXT_ROLE_ID].value || '';

    // 如果是鏈終點，不顯示下拉
    if (isChainEnd(rec)) return;

    const { roles, nameById } = await fetchActiveRoles(currentRoleId);
    const container = buildDropdownUI(roles, nameById, currentRoleId, currentNext);

    // setTimeout 確保 DOM 已渲染
    setTimeout(() => {
      mountDropdown(container);
    }, 0);
  };

  // --- 事件綁定 ---

  // 新增 / 編輯頁載入
  kintone.events.on(
    ['app.record.create.show', 'app.record.edit.show'],
    safeHandler(async (event) => {
      await initDropdown(event);
      return event;
    })
  );

  // is_chain_end 變更時：勾選 → 隱藏下拉 + 清空 next_role_id
  //                      取消 → 顯示下拉
  // change 事件不可回傳 Thenable，同步 return；initDropdown fire-and-forget
  kintone.events.on(
    [
      `app.record.create.change.${F.IS_CHAIN_END}`,
      `app.record.edit.change.${F.IS_CHAIN_END}`,
    ],
    (event) => {
      const container = document.getElementById(CONTAINER_ID);

      if (isChainEnd(event.record)) {
        event.record[F.NEXT_ROLE_ID].value = '';
        if (container) container.style.display = 'none';
      } else {
        if (container) {
          container.style.display = '';
        } else {
          initDropdown(event).catch(console.error);
        }
      }
      return event;
    }
  );

  // 儲存前驗證：非終點角色必須選擇下一關。
  // 只累積錯誤，不在此彈窗——由最後執行的驗證 handler（07-role-name-selector.js，
  // 依上傳順序最後載入）統一彙整顯示一次 SweetAlert。
  kintone.events.on(
    [
      'app.record.create.submit',
      'app.record.edit.submit',
    ],
    safeHandler(async (event) => {
      const rec = event.record;

      if (!isChainEnd(rec) && !rec[F.NEXT_ROLE_ID].value) {
        pushSubmitError(event, '非終點角色必須指定下一關角色，或勾選「是終點」。');
      }

      return event;
    })
  );
})();
