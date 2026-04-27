/**
 * 角色定義表 — 簽核鏈視覺化預覽 (支援多方匯流 Tree 結構)
 *
 * 在詳情頁 / 編輯頁的空白欄位（chain_preview）中，
 * 從當前角色沿著 next_role_id 走到終點，繪製視覺化卡片。
 *
 * 【影響的欄位】
 * - chain_preview（空白欄位）：插入視覺化 DOM
 *
 * 【依賴】
 * - core/01-config.js（Config）
 * - core/04-utils.js（Utils）
 *
 * 【變更履歷】
 * 2026-04-18  Jimmy/Claude  初版建立
 * 2026-04-19  Jimmy/Claude  支援顯示「所有上游路徑」與「下游路徑」，解決多對一匯流顯示問題
 * 2026-04-19  Jimmy/Claude  UI 全面升級：改版為輕量化 Timeline (圓點閃爍 + 連線) 風格
 */
(() => {
  'use strict';

  const { APP_ID, ROLE_FIELDS: F, CHECKBOX } = window.ApprovalRouting.Config;
  const { safeHandler, kintoneApi } = window.ApprovalRouting.Utils;

  const PREVIEW_CONTAINER_ID = 'ar-chain-preview-content';
  const MAX_DEPTH = 20; // 防無限迴圈

  /**
   * 取得所有啟用角色，建成雙向綁定的 Map (roleId → record)
   * @returns {Promise<Map>}
   */
  const fetchRoleMap = async () => {
    const resp = await kintoneApi('/k/v1/records', 'GET', {
      app: APP_ID.ROLE_DEFINITION,
      fields: [F.ROLE_ID, F.ROLE_NAME, F.NEXT_ROLE_ID, F.IS_CHAIN_END],
      query: `${F.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}") limit 500`,
    });

    const map = new Map();

    // 第一層迴圈：建立基礎節點，並多準備一個 prevRoleIds 陣列來裝「誰指向我」
    for (const rec of resp.records) {
      const isEnd =
        Array.isArray(rec[F.IS_CHAIN_END].value) &&
        rec[F.IS_CHAIN_END].value.includes(CHECKBOX.CHAIN_END);
      map.set(rec[F.ROLE_ID].value, {
        roleId: rec[F.ROLE_ID].value,
        roleName: rec[F.ROLE_NAME].value,
        nextRoleId: rec[F.NEXT_ROLE_ID].value || '',
        prevRoleIds: [], // 關鍵新增：用來記錄上游節點
        isChainEnd: isEnd,
      });
    }

    // 第二層迴圈：建立反向關聯 (把上游 ID 塞入下游的 prevRoleIds 裡)
    // 時間複雜度 O(N)，極速完成
    for (const [id, role] of map.entries()) {
      if (role.nextRoleId && map.has(role.nextRoleId)) {
        map.get(role.nextRoleId).prevRoleIds.push(id);
      }
    }

    return map;
  };

  // --- 全新的 Timeline 渲染引擎 ---

  // 1. 注入動畫與連線的 CSS
  const timelineStyles = `
    <style>
      /* 定義閃爍呼吸燈動畫 */
      @keyframes ar-pulse-anim {
        0% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.6); }
        70% { box-shadow: 0 0 0 8px rgba(59, 130, 246, 0); }
        100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0); }
      }
      .ar-pulse {
        animation: ar-pulse-anim 2s infinite;
      }
      /* 水平連接線 */
      .ar-line {
        width: 32px; height: 2px; background: #cbd5e1; margin: 0 8px; flex-shrink: 0;
      }
      /* 多方匯流時的垂直分組線 */
      .ar-tree-border {
        border-right: 2px solid #cbd5e1; padding-right: 16px; margin-right: 4px;
      }
    </style>
  `;

  /**
   * 繪製單一節點 (圓點 + 文字)
   */
  const renderNodeHtml = (role, state = 'normal') => {
    let dotBg = '#e2e8f0';
    let dotBorder = '#94a3b8';
    let titleColor = '#64748b';
    let pulseClass = '';
    let badge = '';

    if (state === 'current') {
      dotBg = '#3b82f6';
      dotBorder = '#2563eb';
      titleColor = '#1d4ed8';
      pulseClass = 'ar-pulse'; // 掛載閃爍動畫
      badge =
        '<span style="background:#e0e7ff; color:#4f46e5; font-size:11px; padding:2px 8px; border-radius:12px; margin-left:8px; font-weight:600; border:1px solid #c7d2fe;">目前</span>';
    } else if (state === 'end') {
      dotBg = '#22c55e';
      dotBorder = '#16a34a';
      titleColor = '#15803d';
      badge =
        '<span style="background:#dcfce7; color:#16a34a; font-size:11px; padding:2px 8px; border-radius:12px; margin-left:8px; font-weight:600; border:1px solid #bbf7d0;">終點</span>';
    } else if (state === 'broken') {
      dotBg = '#ef4444';
      dotBorder = '#dc2626';
      titleColor = '#b91c1c';
      badge =
        '<span style="background:#fee2e2; color:#b91c1c; font-size:11px; padding:2px 8px; border-radius:12px; margin-left:8px; font-weight:600;">斷鏈</span>';
    }

    return `
      <div title="角色代碼: ${role.roleId}" style="display: flex; align-items: center; padding: 8px 0; cursor: help;">
        <div class="${pulseClass}" style="width: 14px; height: 14px; border-radius: 50%; background: ${dotBg}; border: 2px solid ${dotBorder}; flex-shrink: 0; z-index: 2; position: relative;"></div>

        <div style="margin-left: 10px; min-width: max-content;">
          <div style="font-size: 15px; font-weight: 700; color: ${titleColor}; display: flex; align-items: center; letter-spacing: 0.5px;">
            ${role.roleName}${badge}
          </div>
        </div>
      </div>
    `;
  };

  /**
   * [遞迴] 繪製上游 (多源頭樹狀結構)
   */
  const buildUpstreamHtml = (roleId, roleMap, visited) => {
    const role = roleMap.get(roleId);
    if (!role || role.prevRoleIds.length === 0) return '';

    // 防無限循環
    if (visited.has(roleId))
      return `<div style="color:red;font-size:12px;">(循環錯誤)</div>`;
    visited.add(roleId);

    // 遞迴組合所有的「父母」節點
    const parentsHtml = role.prevRoleIds
      .map((pId) => {
        const pRole = roleMap.get(pId);
        if (!pRole) return '';

        const grandParentsHtml = buildUpstreamHtml(
          pId,
          roleMap,
          new Set(visited),
        );
        const nodeHtml = renderNodeHtml(pRole, 'normal');

        return `
        <div style="display: flex; align-items: center;">
          ${grandParentsHtml}
          ${nodeHtml}
        </div>
      `;
      })
      .join('');

    // 智慧判斷：如果是單一來源，就不畫垂直分組線；多來源才畫
    const treeClass = role.prevRoleIds.length > 1 ? 'ar-tree-border' : '';

    return `
      <div style="display: flex; align-items: center;">
        <div class="${treeClass}" style="display: flex; flex-direction: column; gap: 8px;">
          ${parentsHtml}
        </div>
        <div class="ar-line"></div>
      </div>
    `;
  };

  /**
   * [迴圈] 繪製下游 (一直線到終點)
   */
  const buildDownstreamHtml = (startRoleId, roleMap) => {
    let html = '';
    let currentId = startRoleId;
    const visited = new Set();

    for (let i = 0; i < MAX_DEPTH; i++) {
      const role = roleMap.get(currentId);
      if (!role) break;

      currentId = role.nextRoleId; // 往下走
      if (!currentId) break;

      if (visited.has(currentId)) {
        html += `<div class="ar-line"></div>${renderNodeHtml({ roleName: '錯誤', roleId: '偵測到循環' }, 'broken')}`;
        break;
      }
      visited.add(currentId);

      const nextRole = roleMap.get(currentId);
      if (!nextRole) {
        html += `<div class="ar-line"></div>${renderNodeHtml({ roleName: '遺失節點', roleId: currentId }, 'broken')}`;
        break;
      }

      const state = nextRole.isChainEnd ? 'end' : 'normal';
      html += `<div class="ar-line"></div>${renderNodeHtml(nextRole, state)}`;

      if (nextRole.isChainEnd) break;
    }
    return html;
  };

  /**
   * 組合完整畫面： 上游(Tree) ➔ 目前節點 ➔ 下游(Linear)
   */
  const renderFullChainHtml = (currentRoleId, roleMap) => {
    const currentRole = roleMap.get(currentRoleId);
    if (!currentRole) {
      return '<div style="color: #999; padding: 12px;">找不到此角色的資料，請確認是否已啟用。</div>';
    }

    // 注意這裡傳入空的 new Set()，修正稍早的循環報錯問題
    const upstreamHtml = buildUpstreamHtml(currentRoleId, roleMap, new Set());
    const currentHtml = renderNodeHtml(currentRole, 'current');
    const downstreamHtml = buildDownstreamHtml(currentRoleId, roleMap);

    return `
      ${timelineStyles}
      <div style="padding: 16px 24px; overflow-x: auto; background: #fafafa; border-radius: 8px; border: 1px solid #f0f0f0;">
        <div style="display: inline-flex; align-items: center;">
          ${upstreamHtml}
          ${currentHtml}
          ${downstreamHtml}
        </div>
      </div>
    `;
  };

  /**
   * 將預覽插入空白欄位或指定 Slot
   */
  const mountPreview = (html) => {
    const old = document.getElementById(PREVIEW_CONTAINER_ID);
    if (old) old.remove();

    const container = document.createElement('div');
    container.id = PREVIEW_CONTAINER_ID;
    container.innerHTML = html;

    // 1. 詳情頁卡片（05-detail-card.js）內的預留 slot 優先
    const slotEl = document.getElementById('ar-chain-preview-slot');
    if (slotEl) {
      slotEl.innerHTML = '';
      slotEl.appendChild(container);
      return;
    }

    // 2. 編輯/新增頁：用 kintone API 取得 space 欄位
    //    不清空整個 spaceEl（03-next-role-dropdown.js 的自訂下拉也住在這裡）
    //    只替換舊的 preview container，新的插到最前面（下拉保持在下方）
    const spaceEl = kintone.app.record.getSpaceElement('chain_preview');
    if (spaceEl) {
      spaceEl.insertBefore(container, spaceEl.firstChild);
      return;
    }

    // 3. Fallback: 表單底部 (若前兩者都失敗，掛載於畫面下方)
    const formEl =
      document.querySelector('.gaia-argoui-app-edit-record') ||
      document.querySelector('.gaia-argoui-app-show-detail') ||
      document.querySelector('#record-gaia');
    if (formEl) {
      formEl.appendChild(container);
    }
  };

  const renderChainPreview = async (currentRoleId) => {
    if (!currentRoleId) {
      mountPreview(
        '<div style="color:#999; padding:12px;">儲存後即可預覽簽核鏈</div>',
      );
      return;
    }

    // ① 立刻顯示 Loading（同步，不等 API）
    mountPreview(`
    <div style="padding:16px 24px;display:flex;align-items:center;gap:10px;color:#888;font-size:14px;">
      <span style="display:inline-block;width:16px;height:16px;border:2px solid #1a73e8;
                   border-top-color:transparent;border-radius:50%;
                   animation:ar-spin 0.7s linear infinite;flex-shrink:0;"></span>
      更新預覽，請稍後…
    </div>
    <style>
      @keyframes ar-spin { to { transform: rotate(360deg); } }
    </style>
  `);

    // ② API 回來後，以記憶體值覆寫當前角色（編輯中尚未儲存的欄位）
    const roleMap = await fetchRoleMap();
    const liveEntry = roleMap.get(currentRoleId);
    if (liveEntry) {
      try {
        // kintone.app.record.get() 在 edit/detail/create 頁均可用
        const rec = kintone.app.record.get().record;
        liveEntry.nextRoleId  = rec[F.NEXT_ROLE_ID].value || '';
        liveEntry.isChainEnd  = (rec[F.IS_CHAIN_END].value ?? []).includes(CHECKBOX.CHAIN_END);
      } catch { /* detail 頁 or 無 record context → 跳過，使用 DB 值 */ }
    }

    const html = renderFullChainHtml(currentRoleId, roleMap);
    mountPreview(html);
  };

  // --- 事件綁定 ---
  kintone.events.on(
    ['app.record.detail.show'],
    safeHandler(async (event) => {
      const roleId = event.record[F.ROLE_ID].value;
      setTimeout(() => renderChainPreview(roleId), 50);
      return event;
    }),
  );

  kintone.events.on(
    ['app.record.edit.show'],
    safeHandler(async (event) => {
      const roleId = event.record[F.ROLE_ID].value;
      await renderChainPreview(roleId);
      return event;
    }),
  );

  kintone.events.on(
    ['app.record.create.show'],
    safeHandler(async (event) => {
      setTimeout(() => {
        mountPreview(
          '<div style="color:#999; padding:12px;">儲存後即可預覽簽核鏈</div>',
        );
      }, 0);
      return event;
    }),
  );

  // change 事件規定：不可回傳 Thenable，必須同步 return event
  // → 以 fire-and-forget 呼叫非同步的 renderChainPreview
  kintone.events.on(
    [`app.record.edit.change.${F.IS_CHAIN_END}`],
    (event) => {
      renderChainPreview(event.record[F.ROLE_ID].value).catch(console.error);
      return event;
    },
  );

  // 對外暴露，供 03-next-role-dropdown.js 在 dropdown change 後手動呼叫
  window.ApprovalRouting = window.ApprovalRouting || {};
  window.ApprovalRouting.ChainPreview = Object.freeze({
    refresh: renderChainPreview,
  });
})();
