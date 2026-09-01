/**
 * 員工起點對照表 — 表單初始化：起點角色下拉選單 + 驗證
 *
 * 原生 entry_role_id 是文字欄位（對 HR 隱藏），
 * 本檔動態產生下拉選單讓 HR 用點的選擇起點角色。
 *
 * 【影響的欄位】
 *   - entry_role_id: 由下拉選單寫入值（HR 不直接操作）
 *
 * 【依賴】
 *   - core/01-config.js（Config）
 *   - core/04-utils.js（Utils）
 *
 * 【變更履歷】
 *   2026-04-18  Jimmy/Claude  初版建立
 *   2026-06-02  Jimmy/Claude  與 role-definition 下一關下拉同步：選項依 role_name 開頭
 *                              （unit_name 單位）分組排序；下拉識別改以 role_name 為準
 *                              （role_id 僅作寫入用），同名角色不論存哪個 role_id 都能正確顯示
 */
(() => {
  'use strict';

  const {
    APP_ID,
    ROLE_FIELDS: RF,
    ENTRY_FIELDS: F,
    CHECKBOX,
  } = window.ApprovalRouting.Config;
  const { safeHandler, kintoneApi } = window.ApprovalRouting.Utils;

  const DROPDOWN_ID = 'ar-entry-role-dropdown';
  const CONTAINER_ID = 'ar-entry-role-container';

  const UNGROUPED_LABEL = '（未分類）';

  /** 隱藏代碼欄位 */
  const hideCodeFields = () => {
    kintone.app.record.setFieldShown(F.ENTRY_ROLE_ID, false);
  };

  /**
   * 取得所有啟用中的角色清單
   *
   * 依 role_name 開頭（unit_name 單位）→ role_name 排序，並對「完整 role_name」去重
   * （同名視為同一角色）。起點角色無「排除自己」的概念，故不接受 excludeRoleId。
   *
   * @returns {Promise<{roles: Array<{roleId: string, roleName: string, unitName: string}>, nameById: Map<string, string>}>}
   *          roles：已依 unitName 分群、排序且去重的下拉選項；
   *          nameById：所有啟用角色（去重前）的 role_id → role_name 對照，供初始值顯示用
   */
  const fetchActiveRoles = async () => {
    const resp = await kintoneApi('/k/v1/records.json', 'GET', {
      app: APP_ID.ROLE_DEFINITION,
      fields: [RF.ROLE_ID, RF.ROLE_NAME, RF.UNIT_NAME],
      query:
        `${RF.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}") ` +
        `order by ${RF.UNIT_NAME} asc, ${RF.ROLE_NAME} asc limit 500`,
    });

    const nameById = new Map();    // 去重前先建立完整對照，確保初始值（任一 role_id）都查得到名稱
    const seenRoleName = new Set();
    const roles = [];

    for (const r of resp.records) {
      const roleId = r[RF.ROLE_ID].value;
      const roleName = r[RF.ROLE_NAME].value;

      nameById.set(roleId, roleName);

      if (seenRoleName.has(roleName)) continue;  // 完整 role_name 去重（同名視為同一角色）
      seenRoleName.add(roleName);

      roles.push({
        roleId,
        roleName,
        unitName: r[RF.UNIT_NAME]?.value || UNGROUPED_LABEL,
      });
    }

    return { roles, nameById };
  };

  /**
   * 建立可搜尋下拉元件 DOM
   * 以 input + 浮動清單取代原生 select，支援打字過濾
   */
  const buildDropdownUI = (roles, nameById, currentValue) => {
    const container = document.createElement('div');
    container.id = CONTAINER_ID;
    container.style.cssText = 'padding: 8px 0;';

    const label = document.createElement('label');
    label.textContent = '起點角色：';
    label.style.cssText = 'font-weight: bold; font-size: 14px; display: block; margin-bottom: 6px;';

    // input + 浮動清單的外層（position:relative 讓清單能絕對定位）
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position: relative; display: inline-block;';

    // 搜尋輸入框
    const input = document.createElement('input');
    input.type = 'text';
    input.id = DROPDOWN_ID;
    input.placeholder = '輸入角色名稱搜尋…';
    input.autocomplete = 'off';
    input.style.cssText =
      'font-size: 14px; padding: 6px 12px; min-width: 280px; ' +
      'border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;';

    // 初始顯示目前選中的角色名稱（以 role_name 為準，即使存的 role_id 已被去重也找得到）
    const currentName = nameById.get(currentValue) || '';
    if (currentName) input.value = currentName;

    // 浮動選項清單
    const panel = document.createElement('div');
    panel.style.cssText =
      'position: absolute; top: calc(100% + 2px); left: 0; min-width: 280px; ' +
      'max-height: 240px; overflow-y: auto; background: #fff; ' +
      'border: 1px solid #ccc; border-radius: 4px; ' +
      'box-shadow: 0 4px 12px rgba(0,0,0,.12); z-index: 9999; display: none;';

    // 以 role_name 為選取識別（role_id 僅在寫入 entry_role_id 時使用）
    let selectedName = currentName;

    /** 依關鍵字重繪清單（依 unitName 分組，組與組之間加單位標題） */
    const renderItems = (keyword) => {
      const filtered = keyword
        ? roles.filter((r) => r.roleName.includes(keyword))
        : roles;

      panel.innerHTML = '';

      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.textContent = '找不到符合的角色';
        empty.style.cssText = 'padding: 10px 12px; color: #999; font-size: 14px;';
        panel.appendChild(empty);
        return;
      }

      // roles 已依 unitName 排序，同單位連續，遇到單位切換就插入分組標題
      let currentUnit = null;

      for (const role of filtered) {
        if (role.unitName !== currentUnit) {
          currentUnit = role.unitName;
          const header = document.createElement('div');
          header.textContent = currentUnit;
          header.style.cssText =
            'padding: 6px 12px; font-size: 12px; font-weight: 700; color: #555; ' +
            'background: #f5f5f5; position: sticky; top: 0; z-index: 1;';
          panel.appendChild(header);
        }

        const item = document.createElement('div');
        item.textContent = role.roleName;
        item.style.cssText =
          'padding: 8px 12px 8px 20px; font-size: 14px; cursor: pointer; ' +
          (role.roleName === selectedName ? 'background:#e0e7ff; font-weight:600;' : '');

        item.addEventListener('mouseenter', () => { item.style.background = '#f0f4ff'; });
        item.addEventListener('mouseleave', () => {
          item.style.background = role.roleName === selectedName ? '#e0e7ff' : '';
        });

        // mousedown 優先於 blur，用 preventDefault 確保 blur 之前完成選取
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          selectedName = role.roleName;
          input.value = role.roleName;
          panel.style.display = 'none';

          // 同步寫入 kintone 欄位
          const rec = kintone.app.record.get();
          rec.record[F.ENTRY_ROLE_ID].value = role.roleId;
          kintone.app.record.set(rec);
        });

        panel.appendChild(item);
      }
    };

    input.addEventListener('focus', () => {
      renderItems(input.value);
      panel.style.display = 'block';
    });

    input.addEventListener('input', () => {
      renderItems(input.value);
      panel.style.display = 'block';
    });

    input.addEventListener('blur', () => {
      // 延遲讓 mousedown 先執行完
      setTimeout(() => {
        panel.style.display = 'none';
        // 若輸入的文字不符合任何角色，還原成最後一次有效選取
        const matched = roles.find((r) => r.roleName === input.value);
        if (!matched) {
          input.value = selectedName || '';
        }
      }, 200);
    });

    wrapper.appendChild(input);
    wrapper.appendChild(panel);
    container.appendChild(label);
    container.appendChild(wrapper);
    return container;
  };

  /** 插入下拉選單到表單 */
  const mountDropdown = (container) => {
    const old = document.getElementById(CONTAINER_ID);
    if (old) old.remove();

    const fieldEl = document.querySelector(`.field-${F.ENTRY_ROLE_ID}`);
    if (fieldEl) {
      fieldEl.parentNode.insertBefore(container, fieldEl.nextSibling);
      return;
    }

    const formEl = document.querySelector('.gaia-argoui-app-edit-record') ||
                   document.querySelector('#record-gaia');
    if (formEl) formEl.prepend(container);
  };


  // --- 事件綁定 ---

  // 新增 / 編輯頁載入
  kintone.events.on(
    ['app.record.create.show', 'app.record.edit.show'],
    safeHandler(async (event) => {
      const currentValue = event.record[F.ENTRY_ROLE_ID].value || '';
      const { roles, nameById } = await fetchActiveRoles();
      const container = buildDropdownUI(roles, nameById, currentValue);

      setTimeout(() => {
        hideCodeFields();
        mountDropdown(container);
      }, 0);

      return event;
    })
  );

  // 索引頁 inline edit：entry_role_id 反灰，不支援下拉 UI
  kintone.events.on(
    ['app.record.index.edit.show'],
    safeHandler(async (event) => {
      event.record[F.ENTRY_ROLE_ID].disabled = true;
      return event;
    })
  );

  // 詳情頁：隱藏代碼欄位 + 移除殘留的下拉 DOM（從 edit 頁轉過來時可能殘留）
  kintone.events.on(
    ['app.record.detail.show'],
    safeHandler(async (event) => {
      hideCodeFields();
      document.getElementById(CONTAINER_ID)?.remove();
      return event;
    })
  );

  // 儲存前驗證：必須選擇起點角色
  kintone.events.on(
    ['app.record.create.submit', 'app.record.edit.submit'],
    safeHandler(async (event) => {
      if (!event.record[F.ENTRY_ROLE_ID].value) {
        event.error = '請選擇起點角色';
        await Swal.fire({
          icon: 'warning',
          title: '欄位未填寫',
          text: '請為該員工選擇起點角色。',
          confirmButtonText: '確定',
        });
      }
      return event;
    })
  );
})();
