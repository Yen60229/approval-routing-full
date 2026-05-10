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
 */
(() => {
  'use strict';

  const { APP_ID, ROLE_FIELDS: F, CHECKBOX } = window.ApprovalRouting.Config;
  const { safeHandler, kintoneApi } = window.ApprovalRouting.Utils;

  const DROPDOWN_ID = 'ar-next-role-dropdown';
  const CONTAINER_ID = 'ar-next-role-container';

  /**
   * 取得所有啟用中的角色清單（排除自己）
   * @param {string} [excludeRoleId] - 排除自身的 role_id
   * @returns {Promise<Array<{roleId: string, roleName: string}>>}
   */
  const fetchActiveRoles = async (excludeRoleId) => {
    const resp = await kintoneApi('/k/v1/records', 'GET', {
      app: APP_ID.ROLE_DEFINITION,
      fields: [F.ROLE_ID, F.ROLE_NAME],
      query: `${F.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}") order by ${F.ROLE_NAME} asc limit 500`,
    });

    return resp.records
      .map((r) => ({
        roleId: r[F.ROLE_ID].value,
        roleName: r[F.ROLE_NAME].value,
      }))
      .filter((r) => r.roleId !== excludeRoleId);
  };

  /**
   * 建立可搜尋下拉元件 DOM
   * 以 input + 浮動清單取代原生 select，支援打字過濾
   * @param {Array} roles
   * @param {string} currentRoleId - 當前記錄的 role_id（用來同步 kintone 欄位與刷新預覽）
   * @param {string} currentValue  - 目前的 next_role_id
   * @returns {HTMLElement} container
   */
  const buildDropdownUI = (roles, currentRoleId, currentValue) => {
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

    // 初始顯示目前選中的角色名稱
    const currentRole = roles.find((r) => r.roleId === currentValue);
    if (currentRole) input.value = currentRole.roleName;

    // 浮動選項清單
    const panel = document.createElement('div');
    panel.style.cssText =
      'position: absolute; top: calc(100% + 2px); left: 0; min-width: 280px; ' +
      'max-height: 240px; overflow-y: auto; background: #fff; ' +
      'border: 1px solid #ccc; border-radius: 4px; ' +
      'box-shadow: 0 4px 12px rgba(0,0,0,.12); z-index: 9999; display: none;';

    let selectedRoleId = currentValue;

    /** 依關鍵字重繪清單 */
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

      for (const role of filtered) {
        const item = document.createElement('div');
        item.textContent = role.roleName;
        item.style.cssText =
          'padding: 8px 12px; font-size: 14px; cursor: pointer; ' +
          (role.roleId === selectedRoleId ? 'background:#e0e7ff; font-weight:600;' : '');

        item.addEventListener('mouseenter', () => { item.style.background = '#f0f4ff'; });
        item.addEventListener('mouseleave', () => {
          item.style.background = role.roleId === selectedRoleId ? '#e0e7ff' : '';
        });

        // mousedown 優先於 blur，用 preventDefault 確保 blur 之前完成選取
        item.addEventListener('mousedown', async (e) => {
          e.preventDefault();
          selectedRoleId = role.roleId;
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
          const last = roles.find((r) => r.roleId === selectedRoleId);
          input.value = last ? last.roleName : '';
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

    const roles = await fetchActiveRoles(currentRoleId);
    const container = buildDropdownUI(roles, currentRoleId, currentNext);

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
