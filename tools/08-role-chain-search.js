/**
 * 角色簽核鏈快搜（kintone App 685 列表頁）
 *
 * 在角色定義表列表頁的「查詢」選單提供「查簽核鏈」：輸入角色名稱即時過濾，
 * 選一個關卡就看到它完整的上下游簽核鏈（沿用詳情頁那張預覽圖）。
 *
 * 【同名多筆的處理】
 *   一筆記錄只掛一個人（見 docs/對話脈絡.md §9.5），所以同一關有 N 個人
 *   就是 N 筆同名記錄。清單以 role_name 分組（一組＝一個關卡），
 *   右側可切換要看哪一筆的鏈；若同組記錄的 next_role_id 不一致會標紅示警
 *   （那是資料問題，可用 tools/07-batch-next-role.js 批次修正）。
 *
 * 【影響的欄位】
 *   無（唯讀工具，只查詢不寫入）
 *
 * 【依賴】
 *   - core/01-config.js（Config）
 *   - core/04-utils.js（Utils）
 *   - apps/role-definition/04-chain-preview.js
 *     （ChainPreview.loadRoles / renderInto，須在本檔之前載入）
 *
 * 【變更履歷】
 *   2026-08-27  Jimmy/Claude  初版建立
 */
(() => {
  'use strict';

  const { APP_ID, ROLE_FIELDS: RF, CHECKBOX } = window.ApprovalRouting.Config;
  const { safeHandler, kintoneApi, showWarning } = window.ApprovalRouting.Utils;

  const CONFIG = Object.freeze({
    BTN_ID:      'ar-chain-search-btn',
    OVERLAY_ID:  'ar-chain-search-overlay',
    RECORD_PAGE: 500,   // records API 單次上限
    MAX_RESULTS: 200,   // 清單一次最多畫幾組，避免關鍵字空白時畫上千列
  });

  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const recordUrl = (recordId) =>
    `${location.origin}/k/${APP_ID.ROLE_DEFINITION}/show#record=${recordId}`;

  // ═══════════════════════════════════════════════════════════════════
  // 資料
  // ═══════════════════════════════════════════════════════════════════

  /**
   * role_id → 記錄編號。
   * ChainPreview 的角色表沒有 $id，補這一份才能從搜尋結果直接開那筆記錄。
   */
  const fetchRecordIdByRoleId = async () => {
    const map = new Map();
    let offset = 0;
    for (;;) {
      const resp = await kintoneApi('/k/v1/records.json', 'GET', {
        app: APP_ID.ROLE_DEFINITION,
        fields: ['$id', RF.ROLE_ID],
        query: `${RF.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}") limit ${CONFIG.RECORD_PAGE} offset ${offset}`,
      });
      for (const rec of resp.records) {
        const roleId = rec[RF.ROLE_ID]?.value || '';
        if (roleId) map.set(roleId, rec.$id.value);
      }
      if (resp.records.length < CONFIG.RECORD_PAGE) break;
      offset += CONFIG.RECORD_PAGE;
    }
    return map;
  };

  /**
   * 依 role_name 分組成「關卡」清單。
   * @returns {Array<{roleName, roles: Array, holders: string[], inconsistent: boolean}>}
   */
  const groupByRoleName = (roleMap) => {
    const groups = new Map();
    for (const role of roleMap.values()) {
      if (!groups.has(role.roleName)) groups.set(role.roleName, []);
      groups.get(role.roleName).push(role);
    }

    return [...groups.entries()]
      .map(([roleName, roles]) => {
        // 同名記錄的下一關應該一致，不一致代表資料有問題，值得標出來
        const nextIds = new Set(roles.map((r) => r.nextRoleId || ''));
        return {
          roleName,
          roles: [...roles].sort((a, b) => a.roleId.localeCompare(b.roleId)),
          holders: [...new Set(roles.flatMap((r) => r.holderNames))],
          inconsistent: nextIds.size > 1,
        };
      })
      .sort((a, b) => a.roleName.localeCompare(b.roleName, 'zh-Hant'));
  };

  // ═══════════════════════════════════════════════════════════════════
  // UI
  // ═══════════════════════════════════════════════════════════════════

  const PANEL_STYLES = `
    <style>
      .ar-cs-item {
        padding: 8px 12px; border-bottom: 1px solid #f1f5f9; cursor: pointer;
        font-size: 14px; color: #334155;
      }
      .ar-cs-item:hover { background: #f8fafc; }
      .ar-cs-item.is-active { background: #e0e7ff; }
      .ar-cs-sub { font-size: 12px; color: #94a3b8; margin-top: 2px; }
      .ar-cs-warn { color: #c0392b; font-weight: 700; }
      .ar-cs-chip {
        font-size: 13px; padding: 4px 12px; margin: 0 6px 6px 0;
        background: #fff; border: 1px solid #cbd5e1; border-radius: 16px;
        color: #475569; cursor: pointer; font-family: inherit;
      }
      .ar-cs-chip.is-active { background: #3b82f6; border-color: #2563eb; color: #fff; }
      .ar-cs-link { color: #2980b9; text-decoration: none; }
    </style>
  `;

  const showPanel = (roleMap, recordIdByRoleId) => {
    document.getElementById(CONFIG.OVERLAY_ID)?.remove();

    const groups = groupByRoleName(roleMap);
    const groupByName = new Map(groups.map((g) => [g.roleName, g]));

    const overlay = document.createElement('div');
    overlay.id = CONFIG.OVERLAY_ID;
    overlay.style.cssText =
      // 低於 SweetAlert2 的 1060，錯誤視窗才疊得上來
      'position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:1050; display:flex; align-items:center; justify-content:center;';

    const panel = document.createElement('div');
    panel.style.cssText =
      'background:#fff; border-radius:10px; width:min(1180px, 96vw); height:min(760px, 92vh); ' +
      'display:flex; flex-direction:column; padding:18px 22px; box-shadow:0 8px 40px rgba(0,0,0,.25);';

    panel.innerHTML = `
      ${PANEL_STYLES}
      <div style="display:flex; align-items:center; margin-bottom:12px;">
        <h2 style="font-size:18px; margin:0;">查簽核鏈</h2>
        <span style="font-size:13px; color:#666; margin-left:12px;">
          共 ${groups.length} 個關卡（啟用中角色 ${roleMap.size} 筆）
        </span>
        <button data-role="close" style="margin-left:auto; font-size:20px; border:none; background:none; cursor:pointer;">✕</button>
      </div>

      <div style="flex:1; min-height:0; display:flex; gap:16px;">
        <div style="width:320px; flex-shrink:0; display:flex; flex-direction:column; border:1px solid #e5e7eb; border-radius:8px; overflow:hidden;">
          <div style="padding:10px; border-bottom:1px solid #e5e7eb;">
            <input data-role="search" type="text" placeholder="輸入角色名稱或 role_id…"
              style="width:100%; box-sizing:border-box; padding:8px 10px; font-size:14px; font-family:inherit; border:1px solid #cbd5e1; border-radius:6px;">
            <div data-role="count" style="font-size:12px; color:#94a3b8; margin-top:6px;"></div>
          </div>
          <div data-role="list" style="flex:1; overflow-y:auto;"></div>
        </div>

        <div data-role="detail" style="flex:1; min-width:0; overflow:auto; border:1px solid #e5e7eb; border-radius:8px; padding:14px 16px;">
          <div style="color:#94a3b8; font-size:14px; padding:24px 0; text-align:center;">
            從左邊選一個關卡，這裡會顯示它完整的上下游簽核鏈
          </div>
        </div>
      </div>
    `;

    const input   = panel.querySelector('[data-role="search"]');
    const listEl  = panel.querySelector('[data-role="list"]');
    const countEl = panel.querySelector('[data-role="count"]');
    const detail  = panel.querySelector('[data-role="detail"]');

    let shown = [];        // 目前清單上的關卡
    let activeIdx = -1;    // 鍵盤選取位置
    let activeName = '';   // 已選定的關卡

    // ── 清單 ──
    const renderList = () => {
      const kw = input.value.trim().toLowerCase();
      const matched = kw
        ? groups.filter((g) =>
            g.roleName.toLowerCase().includes(kw) ||
            g.roles.some((r) => r.roleId.toLowerCase().includes(kw)))
        : groups;

      shown = matched.slice(0, CONFIG.MAX_RESULTS);
      activeIdx = shown.findIndex((g) => g.roleName === activeName);

      countEl.textContent = matched.length > shown.length
        ? `符合 ${matched.length} 個關卡，先顯示前 ${shown.length} 個`
        : `符合 ${matched.length} 個關卡`;

      listEl.innerHTML = shown.length
        ? shown.map((g) => {
            const holders = g.holders.length
              ? g.holders.slice(0, 3).join('、') + (g.holders.length > 3 ? `…等 ${g.holders.length} 人` : '')
              : '（群組或未設定簽核者）';
            return `
              <div class="ar-cs-item ${g.roleName === activeName ? 'is-active' : ''}" data-name="${esc(g.roleName)}">
                <div>${esc(g.roleName)}${g.inconsistent ? ' <span class="ar-cs-warn">下一關不一致</span>' : ''}</div>
                <div class="ar-cs-sub">${g.roles.length} 筆記錄 · ${esc(holders)}</div>
              </div>`;
          }).join('')
        : '<div style="padding:20px; text-align:center; color:#94a3b8; font-size:14px;">找不到符合的角色</div>';
    };

    // ── 右側：某個關卡的鏈 ──
    const renderDetail = async (group, roleId) => {
      const role = group.roles.find((r) => r.roleId === roleId) ?? group.roles[0];
      const recordId = recordIdByRoleId.get(role.roleId);

      const chips = group.roles.length > 1
        ? `<div style="margin:8px 0 4px;">
             <span style="font-size:12px; color:#94a3b8; margin-right:6px;">這一關的記錄（一人一筆）：</span><br>
             ${group.roles.map((r) => `
               <button type="button" class="ar-cs-chip ${r.roleId === role.roleId ? 'is-active' : ''}"
                 data-roleid="${esc(r.roleId)}">${esc(r.holderNames[0] || r.roleId)}</button>`).join('')}
           </div>`
        : '';

      detail.innerHTML = `
        <div style="border-bottom:1px solid #eee; padding-bottom:10px; margin-bottom:12px;">
          <div style="font-size:16px; font-weight:700; color:#1e293b;">${esc(group.roleName)}</div>
          <div style="font-size:13px; color:#666; margin-top:4px;">
            共 ${group.roles.length} 筆記錄　目前顯示
            <code style="font-size:12px;">${esc(role.roleId)}</code>
            ${recordId ? `　<a class="ar-cs-link" href="${recordUrl(recordId)}" target="_blank">開啟記錄 ${esc(recordId)}</a>` : ''}
          </div>
          ${group.inconsistent ? `
            <div style="margin-top:8px; padding:8px 10px; background:#fdecea; border-radius:6px; font-size:13px; color:#7f1d1d;">
              這一關的記錄「下一關」設定不一致，代表同一關的人會走到不同的下一關。
              可用「批次設定下一關」統一。
            </div>` : ''}
          ${chips}
        </div>
        <div data-role="chain">
          <div style="color:#94a3b8; font-size:14px; padding:12px;">載入中…</div>
        </div>
      `;

      await window.ApprovalRouting.ChainPreview.renderInto(
        detail.querySelector('[data-role="chain"]'), role.roleId, roleMap,
      );
    };

    const select = (roleName, roleId) => {
      const group = groupByName.get(roleName);
      if (!group) return;
      activeName = roleName;
      renderList();
      renderDetail(group, roleId).catch((err) => {
        console.error('[ApprovalRouting] 簽核鏈渲染失敗', err);
        detail.querySelector('[data-role="chain"]').innerHTML =
          '<div style="color:#c0392b; padding:12px;">簽核鏈載入失敗，請重新選一次</div>';
      });
    };

    // ── 事件 ──
    panel.querySelector('[data-role="close"]').addEventListener('click', () => close());

    input.addEventListener('input', () => renderList());

    // ↑↓ 移動、Enter 選取；清單很長時自動捲到可視範圍
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!shown.length) return;
        activeIdx = e.key === 'ArrowDown'
          ? Math.min(activeIdx + 1, shown.length - 1)
          : Math.max(activeIdx - 1, 0);
        select(shown[activeIdx].roleName);
        listEl.children[activeIdx]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && activeIdx >= 0) {
        e.preventDefault();
        select(shown[activeIdx].roleName);
      }
    });

    listEl.addEventListener('click', (e) => {
      const item = e.target.closest('[data-name]');
      if (item) select(item.dataset.name);
    });

    // 切換要看哪一筆記錄的鏈
    detail.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-roleid]');
      if (chip) select(activeName, chip.dataset.roleid);
    });

    const onKeydown = (e) => { if (e.key === 'Escape') close(); };
    const close = () => {
      document.removeEventListener('keydown', onKeydown);
      overlay.remove();
    };
    document.addEventListener('keydown', onKeydown);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    renderList();
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    input.focus();
  };

  // ═══════════════════════════════════════════════════════════════════
  // 進入點
  // ═══════════════════════════════════════════════════════════════════

  const runTool = async () => {
    const preview = window.ApprovalRouting?.ChainPreview;
    if (!preview?.renderInto) {
      await showWarning('缺少相依模組', '請確認 04-chain-preview.js 已上傳到本 App，且排在本檔之前載入。');
      return;
    }

    Swal.fire({
      title: '載入角色資料…',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading(),
    });
    const [roleMap, recordIdByRoleId] = await Promise.all([
      preview.loadRoles(),
      fetchRecordIdByRoleId(),
    ]);
    Swal.close();

    showPanel(roleMap, recordIdByRoleId);
  };

  // 掛在共用工具列（core/09-tool-registry.js）的「query」群組，不再自己長一顆按鈕
  window.ApprovalRouting.ToolRegistry.register({
    id:    'role-chain-search',
    group: 'query',
    label: '查簽核鏈',
    hint:  '輸入角色名稱，看它完整的上下游簽核鏈',
    apps:  [APP_ID.ROLE_DEFINITION],
    run:   runTool,
  });
})();
