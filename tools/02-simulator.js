/**
 * 測試模擬器 — 任選員工模擬簽核鏈（不寫入資料）
 *
 * 在角色定義表或員工起點對照表列表頁的「查詢」選單提供「模擬器」，
 * HR / IT 輸入姓名或帳號的部分字元即可從清單點選，立即預覽該員工送單後的完整簽核鏈。
 *
 * 【依賴】
 *   - core/01-config.js（Config）
 *   - core/02-api-client.js（ApiClient）
 *   - core/03-chain-builder.js（Engine.simulateChain）
 *   - core/04-utils.js（Utils）
 *   - core/07-role-picker.js（RolePicker：可搜尋下拉，這裡拿來搜人不是搜角色，
 *     純 DOM 元件不認欄位，見 core/07 檔頭說明）
 *   - core/08-directory.js（Directory.fetchAllUsers：全公司使用者清單）
 *
 * 【變更履歷】
 *   2026-04-18  Jimmy/Claude  初版建立
 *   2026-09-01  Jimmy/Claude  輸入框改成可搜尋下拉：打姓名或帳號的部分字元就能從清單點選，
 *                              不必自己記住並打對完整的登入帳號
 */
(() => {
  'use strict';

  const { APP_ID, ROLE_FIELDS: RF, CHAIN_FIELDS: CF } = window.ApprovalRouting.Config;
  const { simulateChain } = window.ApprovalRouting.Engine;
  const { safeHandler, clearRoleCache } = {
    ...window.ApprovalRouting.Utils,
    clearRoleCache: window.ApprovalRouting.ApiClient.clearRoleCache,
  };
  const { create: createPicker } = window.ApprovalRouting.RolePicker;
  const { fetchAllUsers } = window.ApprovalRouting.Directory;


  // -------------------------------------------------------------------
  // 模擬結果渲染
  // -------------------------------------------------------------------

  const renderChainResult = (chain) => {
    if (chain.length === 0) return '<div style="color:#999;">（空鏈）</div>';

    return chain.map((step) => {
      // 子表格列格式 { value: { 欄位代碼: { type, value } } }（2026-09-01 assembleChainStep 改版，
      // 見 core/03-chain-builder.js）；adapter 一直是照這個格式讀的，這裡原本沒跟著改
      const row      = step.value;
      const stepNo   = row[CF.STEP_NO].value;
      const roleName = row[CF.STEP_NAME].value;
      const roleId   = row[CF.ROLE_ID].value;
      const signers  = row[CF.EXPECTED_SIGNERS].value.map((u) => u.code).join('、') || '（未設定）';

      return `
        <div style="display:flex; align-items:flex-start; margin-bottom:12px;">
          <div style="min-width:32px; height:32px; background:#2196f3; color:#fff; border-radius:50%;
                      display:flex; align-items:center; justify-content:center; font-weight:bold; font-size:14px; flex-shrink:0;">
            ${stepNo}
          </div>
          <div style="margin-left:12px; background:#f5f5f5; border-radius:6px; padding:8px 14px; flex:1;">
            <div style="font-weight:bold; font-size:15px;">${roleName}</div>
            <div style="font-size:12px; color:#999; margin-top:2px;">${roleId}</div>
            <div style="font-size:13px; color:#555; margin-top:4px;">簽核者：${signers}</div>
          </div>
        </div>
        ${stepNo < chain.length
          ? '<div style="margin-left:15px; color:#bbb; font-size:18px; margin-bottom:4px;">↓</div>'
          : '<div style="margin-left:10px; margin-top:4px; font-size:12px; color:#4caf50; font-weight:bold;">✅ 終點</div>'}
      `;
    }).join('');
  };

  // -------------------------------------------------------------------
  // 模擬器主流程
  // -------------------------------------------------------------------

  const runSimulator = async () => {
    // Step 0：先把全公司使用者清單抓回來，才有得搜尋
    Swal.fire({ title: '讀取人員名單...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    const { actives } = await fetchAllUsers();
    Swal.close();

    // Step 1：搜姓名或帳號、點選一個人
    // 顯示名稱把姓名跟帳號併在同一個字串裡，RolePicker 只認 name 這個欄位做子字串比對，
    // 這樣打「山田」或打「yamada」都篩得到，不必額外改共用元件的搜尋邏輯。
    let picked = null;
    const { isConfirmed } = await Swal.fire({
      title: '簽核鏈模擬器',
      html: `
        <div style="text-align:left; margin-bottom:8px; font-size:14px; color:#555;">
          輸入姓名或帳號的部分字元搜尋，選一個人模擬其送單後的簽核鏈。
        </div>
        <div id="ar-sim-picker-slot"></div>
      `,
      width: 480,
      showCancelButton: true,
      confirmButtonText: '模擬',
      cancelButtonText: '取消',
      didOpen: () => {
        const slot = document.getElementById('ar-sim-picker-slot');
        const picker = createPicker({
          options: actives.map((u) => ({ id: u.code, name: `${u.name}（${u.code}）` })),
          placeholder: '輸入姓名或帳號…',
          emptyText: '找不到符合的人員',
          ungroupedLabel: '在職人員',
          minWidth: 400,
          onSelect: (opt) => { picked = opt; },
        });
        slot.appendChild(picker.el);
        picker.el.querySelector('input')?.focus();
      },
      preConfirm: () => {
        if (!picked) { Swal.showValidationMessage('請從清單選一個人'); return false; }
        return picked;
      },
    });

    if (!isConfirmed || !picked) return;
    const employeeCode = picked.id;

    // Step 2：強制重新載入最新角色資料
    clearRoleCache();

    // Step 3：模擬
    Swal.fire({ title: '模擬中...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    const { ok, chain, error } = await simulateChain(employeeCode);
    Swal.close();

    // Step 4：顯示結果
    if (!ok) {
      await Swal.fire({
        icon: 'error',
        title: '模擬失敗',
        text: error,
        confirmButtonText: '關閉',
      });
      return;
    }

    await Swal.fire({
      title: `${picked.name} 的簽核鏈（共 ${chain.length} 關）`,
      html: `<div style="text-align:left; max-height:420px; overflow-y:auto; padding:8px 4px;">
               ${renderChainResult(chain)}
             </div>`,
      width: 600,
      confirmButtonText: '關閉',
    });
  };

  // -------------------------------------------------------------------
  // 列表頁插入按鈕
  // -------------------------------------------------------------------

  // 掛在共用工具列（core/09-tool-registry.js）的「query」群組，不再自己長一顆按鈕
  window.ApprovalRouting.ToolRegistry.register({
    id:    'simulator',
    group: 'query',
    label: '模擬器',
    hint:  '搜姓名或帳號選一個人，預覽他送單後的完整簽核鏈',
    apps:  [APP_ID.ROLE_DEFINITION, APP_ID.EMPLOYEE_ENTRY],
    run:   runSimulator,
  });
})();
