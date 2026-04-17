/**
 * 測試模擬器 — 任選員工模擬簽核鏈（不寫入資料）
 *
 * 在角色定義表或員工起點對照表列表頁加入「模擬器」按鈕，
 * HR / IT 可輸入員工代碼，立即預覽該員工送單後的完整簽核鏈。
 *
 * 【依賴】
 *   - core/01-config.js（Config）
 *   - core/02-api-client.js（ApiClient）
 *   - core/03-chain-builder.js（Engine.simulateChain）
 *   - core/04-utils.js（Utils）
 *
 * 【變更履歷】
 *   2026-04-18  Jimmy/Claude  初版建立
 */
(() => {
  'use strict';

  const { ROLE_FIELDS: RF, CHAIN_FIELDS: CF } = window.ApprovalRouting.Config;
  const { simulateChain } = window.ApprovalRouting.Engine;
  const { safeHandler, clearRoleCache } = {
    ...window.ApprovalRouting.Utils,
    clearRoleCache: window.ApprovalRouting.ApiClient.clearRoleCache,
  };

  const BTN_ID = 'ar-simulator-btn';

  // -------------------------------------------------------------------
  // 模擬結果渲染
  // -------------------------------------------------------------------

  const renderChainResult = (chain) => {
    if (chain.length === 0) return '<div style="color:#999;">（空鏈）</div>';

    return chain.map((step) => {
      const stepNo   = step[CF.STEP_NO].value;
      const roleName = step[CF.STEP_NAME].value;
      const roleId   = step[CF.ROLE_ID].value;
      const signers  = step[CF.EXPECTED_SIGNERS].value.map((u) => u.code).join('、') || '（未設定）';

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
    // Step 1：輸入員工代碼
    const { value: employeeCode, isConfirmed } = await Swal.fire({
      title: '簽核鏈模擬器',
      html: `
        <div style="text-align:left; margin-bottom:8px; font-size:14px; color:#555;">
          輸入員工的 kintone 使用者代碼（登入帳號），模擬其送單後的簽核鏈。
        </div>
        <input id="ar-sim-input" class="swal2-input" placeholder="例：yamada.taro"
               style="font-size:15px;" />
      `,
      showCancelButton: true,
      confirmButtonText: '模擬',
      cancelButtonText: '取消',
      preConfirm: () => {
        const val = document.getElementById('ar-sim-input').value.trim();
        if (!val) Swal.showValidationMessage('請輸入員工代碼');
        return val;
      },
    });

    if (!isConfirmed || !employeeCode) return;

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
      title: `${employeeCode} 的簽核鏈（共 ${chain.length} 關）`,
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

  const mountButton = () => {
    if (document.getElementById(BTN_ID)) return;

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.textContent = '模擬器';
    btn.style.cssText = 'font-size:14px; padding:8px 20px; background:#7b1fa2; color:#fff; border:none; border-radius:4px; cursor:pointer; margin-left:8px;';
    btn.addEventListener('click', async () => {
      try {
        await runSimulator();
      } catch (err) {
        console.error('[ApprovalRouting] 模擬器錯誤', err);
        await Swal.fire({ icon: 'error', title: '模擬器錯誤', text: err.message });
      }
    });

    const toolbar = document.querySelector('.gaia-argoui-app-index-toolbar') ||
                    document.querySelector('.contents-actionmenu-gaia');
    if (toolbar) toolbar.appendChild(btn);
  };

  // --- 事件綁定 ---
  kintone.events.on(
    ['app.record.index.show'],
    window.ApprovalRouting.Utils.safeHandler(async (event) => {
      mountButton();
      return event;
    })
  );
})();
