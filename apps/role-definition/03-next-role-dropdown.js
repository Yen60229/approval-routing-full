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
 *
 * 【變更履歷】
 *   2026-04-18  Jimmy/Claude  初版建立
 *   2026-06-02  Jimmy/Claude  下拉選項依 role_name 開頭（unit_name 單位）分組排序，
 *                              並對完整 role_name 去重，方便 HR 在大量角色中定位。
 *                              下拉識別一律以 role_name 為準（role_id 僅作寫入用），
 *                              同名角色不論存哪個 role_id，開啟記錄都能正確顯示。
 */
(() => {
  'use strict';

  const { APP_ID, ROLE_FIELDS: F, CHECKBOX } = window.ApprovalRouting.Config;
  const { safeHandler, kintoneApi } = window.ApprovalRouting.Utils;

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
   * 建立可搜尋下拉元件 DOM
   * 以 input + 浮動清單取代原生 select，支援打字過濾
   * @param {Array} roles
   * @param {Map<string, string>} nameById - 所有啟用角色的 role_id → role_name 對照
   * @param {string} currentRoleId - 當前記錄的 role_id（用來同步 kintone 欄位與刷新預覽）
   * @param {string} currentValue  - 目前的 next_role_id
   * @returns {HTMLElement} container
   */
  const buildDropdownUI = (roles, nameById, currentRoleId, currentValue) => {
    const container = document.createElement('div');
    container.id = CONTAINER_ID;
    container.style.cssText = 'padding: 8px 0;';

    const label = document.createElement('label');
    label.textContent = '下一關角色：';
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

    // 以 role_name 為選取識別（role_id 僅在寫入 next_role_id 時使用）
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
        item.addEventListener('mousedown', async (e) => {
          e.preventDefault();
          selectedName = role.roleName;
          input.value = role.roleName;
          panel.style.display = 'none';

          // 同步寫入 kintone 欄位
          const rec = kintone.app.record.get();
          rec.record[F.NEXT_ROLE_ID].value = role.roleId;
          kintone.app.record.set(rec);

          // 通知 chain-preview 刷新（kintone.app.record.set 不觸發 change 事件）
          await window.ApprovalRouting.ChainPreview?.refresh(currentRoleId);
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

  // 儲存前驗證：非終點角色必須選擇下一關
  kintone.events.on(
    [
      'app.record.create.submit',
      'app.record.edit.submit',
    ],
    safeHandler(async (event) => {
      const rec = event.record;

      if (!isChainEnd(rec) && !rec[F.NEXT_ROLE_ID].value) {
        event.error = '請選擇下一關角色，或勾選「是終點」';
        await Swal.fire({
          icon: 'warning',
          title: '缺少下一關',
          text: '非終點角色必須指定下一關角色，或勾選「是終點」。',
          confirmButtonText: '確定',
        });
      }

      return event;
    })
  );
})();
