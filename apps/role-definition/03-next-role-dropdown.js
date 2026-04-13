/**
 * 角色定義表 — next_role_id 下拉選單 UI
 *
 * 原生 next_role_id 是文字欄位（已由 01-form-init 隱藏），
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
 *   2026-04-14  Jimmy/Claude  初版建立
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
   * 建立下拉選單 DOM
   * @param {Array} roles
   * @param {string} currentValue - 目前的 next_role_id
   * @returns {HTMLElement} container
   */
  const buildDropdownUI = (roles, currentValue) => {
    const container = document.createElement('div');
    container.id = CONTAINER_ID;
    container.style.cssText = 'padding: 8px 0;';

    const label = document.createElement('label');
    label.textContent = '下一關角色：';
    label.style.cssText = 'font-weight: bold; font-size: 14px; margin-right: 8px;';
    label.setAttribute('for', DROPDOWN_ID);

    const select = document.createElement('select');
    select.id = DROPDOWN_ID;
    select.style.cssText = 'font-size: 14px; padding: 6px 12px; min-width: 250px; border: 1px solid #ccc; border-radius: 4px;';

    // 空選項
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = '— 請選擇 —';
    select.appendChild(emptyOpt);

    for (const role of roles) {
      const opt = document.createElement('option');
      opt.value = role.roleId;
      opt.textContent = `${role.roleName}（${role.roleId}）`;
      if (role.roleId === currentValue) opt.selected = true;
      select.appendChild(opt);
    }

    container.appendChild(label);
    container.appendChild(select);
    return container;
  };

  /**
   * 將下拉選單插入空白欄位（chain_preview 區塊上方）
   * 找不到空白欄位時 fallback 到表單最上方
   */
  const mountDropdown = (container) => {
    // 移除舊的（避免重複）
    const old = document.getElementById(CONTAINER_ID);
    if (old) old.remove();

    // 嘗試插入到 next_role_id 欄位的位置
    const fieldEl = document.querySelector(`.field-${F.NEXT_ROLE_ID}`);
    if (fieldEl) {
      fieldEl.parentNode.insertBefore(container, fieldEl.nextSibling);
      return;
    }

    // fallback: 插到 chain_preview 空白欄位上方
    const previewEl = document.getElementById('chain_preview');
    if (previewEl) {
      previewEl.parentNode.insertBefore(container, previewEl);
      return;
    }

    // 最終 fallback
    const formEl = document.querySelector('.gaia-argoui-app-edit-record') ||
                   document.querySelector('#record-gaia');
    if (formEl) formEl.prepend(container);
  };

  /**
   * 綁定下拉選單的 change 事件 → 同步到 next_role_id 欄位
   */
  const bindDropdownChange = () => {
    const select = document.getElementById(DROPDOWN_ID);
    if (!select) return;

    select.addEventListener('change', () => {
      const rec = kintone.app.record.get();
      rec.record[F.NEXT_ROLE_ID].value = select.value;
      kintone.app.record.set(rec);
    });
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
    const container = buildDropdownUI(roles, currentNext);

    // setTimeout 確保 DOM 已渲染
    setTimeout(() => {
      mountDropdown(container);
      bindDropdownChange();
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
  kintone.events.on(
    [
      `app.record.create.change.${F.IS_CHAIN_END}`,
      `app.record.edit.change.${F.IS_CHAIN_END}`,
    ],
    safeHandler(async (event) => {
      const container = document.getElementById(CONTAINER_ID);

      if (isChainEnd(event.record)) {
        event.record[F.NEXT_ROLE_ID].value = '';
        if (container) container.style.display = 'none';
      } else {
        if (container) {
          container.style.display = '';
        } else {
          await initDropdown(event);
        }
      }
      return event;
    })
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
