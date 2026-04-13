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
 *   2026-04-14  Jimmy/Claude  初版建立
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

  /** 隱藏代碼欄位 */
  const hideCodeFields = () => {
    kintone.app.record.setFieldShown(F.ENTRY_ROLE_ID, false);
  };

  /**
   * 取得所有啟用中的角色清單
   * @returns {Promise<Array<{roleId: string, roleName: string}>>}
   */
  const fetchActiveRoles = async () => {
    const resp = await kintoneApi('/k/v1/records', 'GET', {
      app: APP_ID.ROLE_DEFINITION,
      fields: [RF.ROLE_ID, RF.ROLE_NAME],
      query: `${RF.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}") order by ${RF.ROLE_NAME} asc limit 500`,
    });

    return resp.records.map((r) => ({
      roleId: r[RF.ROLE_ID].value,
      roleName: r[RF.ROLE_NAME].value,
    }));
  };

  /**
   * 建立下拉選單 DOM
   */
  const buildDropdownUI = (roles, currentValue) => {
    const container = document.createElement('div');
    container.id = CONTAINER_ID;
    container.style.cssText = 'padding: 8px 0;';

    const label = document.createElement('label');
    label.textContent = '起點角色：';
    label.style.cssText = 'font-weight: bold; font-size: 14px; margin-right: 8px;';
    label.setAttribute('for', DROPDOWN_ID);

    const select = document.createElement('select');
    select.id = DROPDOWN_ID;
    select.style.cssText = 'font-size: 14px; padding: 6px 12px; min-width: 250px; border: 1px solid #ccc; border-radius: 4px;';

    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = '— 請選擇起點角色 —';
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

  /** 綁定 change 事件同步到 entry_role_id */
  const bindDropdownChange = () => {
    const select = document.getElementById(DROPDOWN_ID);
    if (!select) return;

    select.addEventListener('change', () => {
      const rec = kintone.app.record.get();
      rec.record[F.ENTRY_ROLE_ID].value = select.value;
      kintone.app.record.set(rec);
    });
  };

  // --- 事件綁定 ---

  // 新增 / 編輯頁載入
  kintone.events.on(
    ['app.record.create.show', 'app.record.edit.show'],
    safeHandler(async (event) => {
      const currentValue = event.record[F.ENTRY_ROLE_ID].value || '';
      const roles = await fetchActiveRoles();
      const container = buildDropdownUI(roles, currentValue);

      setTimeout(() => {
        hideCodeFields();
        mountDropdown(container);
        bindDropdownChange();
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
