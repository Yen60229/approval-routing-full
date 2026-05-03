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
 * 2026-05-03  Jimmy/Claude  同名節點合併：上游同 roleName 的節點合為一個，hover tooltip 顯示「同仁（N位）」姓名清單
 */
(() => {
  'use strict';

  const { APP_ID, ROLE_FIELDS: F, CHECKBOX, HOLDER_TYPE_OPTIONS: HT } = window.ApprovalRouting.Config;
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
      fields: [F.ROLE_ID, F.ROLE_NAME, F.NEXT_ROLE_ID, F.IS_CHAIN_END, F.HOLDER_TYPE, F.HOLDER_USER, F.HOLDER_GROUP],
      query: `${F.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}") limit 500`,
    });

    const map = new Map();

    // 第一層迴圈：建立基礎節點
    for (const rec of resp.records) {
      const isEnd =
        Array.isArray(rec[F.IS_CHAIN_END].value) &&
        rec[F.IS_CHAIN_END].value.includes(CHECKBOX.CHAIN_END);

      // 解析持有人姓名
      const holderType = rec[F.HOLDER_TYPE].value;
      let holderNames = [];
      if (holderType === HT.USER) {
        // 個人：直接從欄位值取名稱，零 API 消耗
        const users = rec[F.HOLDER_USER].value;
        if (Array.isArray(users)) {
          holderNames = users.map((u) => u.name).filter(Boolean);
        }
      } else if (holderType === HT.GROUP) {
        // 群組：kintone.getMembersByGroupCode() 為前端 JS API，不消耗 REST API 次數
        const groupCode = rec[F.HOLDER_GROUP]?.value?.[0]?.code ?? null;
        if (groupCode) {
          try {
            const members = kintone.getMembersByGroupCode(groupCode) || [];
            holderNames = members.map((m) => m.name).filter(Boolean);
          } catch {
            // 群組不存在或無權限時靜默略過，tooltip 改顯示角色代碼
          }
        }
      }

      map.set(rec[F.ROLE_ID].value, {
        roleId:      rec[F.ROLE_ID].value,
        roleName:    rec[F.ROLE_NAME].value,
        nextRoleId:  rec[F.NEXT_ROLE_ID].value || '',
        prevRoleIds: [],
        isChainEnd:  isEnd,
        holderNames, // 個人持有人姓名陣列（群組為空陣列）
      });
    }

    // 第二層迴圈：建立反向關聯
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
      @keyframes ar-pulse-anim {
        0%   { box-shadow: 0 0 0 0   rgba(59, 130, 246, 0.6); }
        70%  { box-shadow: 0 0 0 8px rgba(59, 130, 246, 0);   }
        100% { box-shadow: 0 0 0 0   rgba(59, 130, 246, 0);   }
      }
      .ar-pulse { animation: ar-pulse-anim 2s infinite; }

      /* 水平連接線 */
      .ar-line { width: 32px; height: 2px; background: #cbd5e1; margin: 0 8px; flex-shrink: 0; }

      /* 多方匯流時的垂直分組線 */
      .ar-tree-border { border-right: 2px solid #cbd5e1; padding-right: 16px; margin-right: 4px; }

      /* 人數 badge */
      .ar-count-badge {
        display: inline-flex; align-items: center; justify-content: center;
        background: #f1f5f9; color: #64748b; font-size: 10px; font-weight: 700;
        width: 17px; height: 17px; border-radius: 50%;
        margin-left: 5px; border: 1px solid #cbd5e1; flex-shrink: 0;
      }

      /* Trigger：只設游標，tooltip 本身掛在 body（不受 overflow 裁切） */
      .ar-tip { display: inline-flex; align-items: center; cursor: help; }

      /* Floating tooltip（body 層） — 樣式由 JS 建立，這裡放共用子元素樣式 */
      .ar-tt-title  { color: #94a3b8; font-size: 10px; margin-bottom: 4px; }
      .ar-tt-person { display: flex; align-items: center; gap: 5px; padding: 2px 0; }
      .ar-tt-person + .ar-tt-person { border-top: 1px solid #334155; margin-top: 3px; padding-top: 5px; }
    </style>
  `;

  // ─── Floating Tooltip（position:fixed，掛在 body，完全不受容器 overflow 限制）───

  /** 確保 body 上只有一個 floating tooltip div，並回傳它 */
  const ensureFloatingTip = () => {
    let tip = document.getElementById('ar-floating-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'ar-floating-tip';
      tip.style.cssText =
        'position:fixed;display:none;z-index:999999;' +
        'background:#1e293b;color:#f8fafc;font-size:12px;' +
        'border-radius:6px;padding:8px 12px;white-space:nowrap;' +
        'pointer-events:none;box-shadow:0 4px 12px rgba(0,0,0,.28);' +
        'min-width:110px;';
      document.body.appendChild(tip);
    }
    return tip;
  };

  /** 根據 anchor 元素的 viewport 座標，把 tooltip 定位在它上方（空間不足時自動翻轉至下方） */
  const positionTip = (tip, anchorEl) => {
    tip.style.display = 'block';
    const rect = anchorEl.getBoundingClientRect();
    const tw   = tip.offsetWidth;
    const th   = tip.offsetHeight;
    let left = rect.left + rect.width / 2 - tw / 2;
    let top  = rect.top  - th - 8;
    if (left < 8) left = 8;
    if (left + tw > window.innerWidth - 8) left = window.innerWidth - tw - 8;
    if (top  < 8) top  = rect.bottom + 8; // 翻轉至下方
    tip.style.left = `${left}px`;
    tip.style.top  = `${top}px`;
  };

  /**
   * 為 preview 容器綁定 mouseover / mouseout 事件委派（每次 mountPreview 後呼叫）。
   * tooltip 資料從觸發元素的 data-ar-tip（JSON）讀取。
   */
  const bindTooltipEvents = (containerEl) => {
    containerEl.addEventListener('mouseover', (e) => {
      const anchor = e.target.closest('[data-ar-tip]');
      if (!anchor) return;
      const { names, roleId } = JSON.parse(anchor.dataset.arTip);
      const tip = ensureFloatingTip();
      let html = '';
      if (!names || names.length === 0) {
        html = `<div class="ar-tt-title">角色代碼</div><div class="ar-tt-person">${roleId}</div>`;
      } else {
        html =
          `<div class="ar-tt-title">同仁（${names.length} 位）</div>` +
          names.map((n) => `<div class="ar-tt-person">${PERSON_ICON}${n}</div>`).join('');
      }
      tip.innerHTML = html;
      positionTip(tip, anchor);
    });

    containerEl.addEventListener('mouseout', (e) => {
      const anchor = e.target.closest('[data-ar-tip]');
      if (!anchor) return;
      // 移往子元素時不隱藏；真正離開才隱藏
      if (!anchor.contains(e.relatedTarget)) {
        const tip = document.getElementById('ar-floating-tip');
        if (tip) tip.style.display = 'none';
      }
    });
  };

  /** 人頭 SVG icon（tooltip 用） */
  const PERSON_ICON = `<svg width="11" height="11" viewBox="0 0 16 16" fill="#94a3b8" style="flex-shrink:0"><path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 1a7 7 0 0 0-7 7h14a7 7 0 0 0-7-7z"/></svg>`;

  /**
   * 繪製單一節點（圓點 + 文字）。
   * Tooltip 資料存在 data-ar-tip 屬性（JSON），由 bindTooltipEvents 統一處理，
   * 不在 DOM 裡嵌入 tooltip HTML，完全不受容器 overflow 裁切。
   *
   * @param {object}   role         - roleMap 的節點物件
   * @param {'normal'|'current'|'end'|'broken'} state
   * @param {string[]} [holderNames] - 覆寫 role.holderNames（合併節點使用）
   */
  const renderNodeHtml = (role, state = 'normal', holderNames) => {
    let dotBg      = '#e2e8f0';
    let dotBorder  = '#94a3b8';
    let titleColor = '#64748b';
    let pulseClass = '';
    let badge      = '';

    if (state === 'current') {
      dotBg = '#3b82f6'; dotBorder = '#2563eb'; titleColor = '#1d4ed8';
      pulseClass = 'ar-pulse';
      badge = '<span style="background:#e0e7ff;color:#4f46e5;font-size:11px;padding:2px 8px;border-radius:12px;margin-left:8px;font-weight:600;border:1px solid #c7d2fe;">目前</span>';
    } else if (state === 'end') {
      dotBg = '#22c55e'; dotBorder = '#16a34a'; titleColor = '#15803d';
      badge = '<span style="background:#dcfce7;color:#16a34a;font-size:11px;padding:2px 8px;border-radius:12px;margin-left:8px;font-weight:600;border:1px solid #bbf7d0;">終點</span>';
    } else if (state === 'broken') {
      dotBg = '#ef4444'; dotBorder = '#dc2626'; titleColor = '#b91c1c';
      badge = '<span style="background:#fee2e2;color:#b91c1c;font-size:11px;padding:2px 8px;border-radius:12px;margin-left:8px;font-weight:600;">斷鏈</span>';
    }

    const names      = holderNames !== undefined ? holderNames : (role.holderNames || []);
    const countBadge = names.length > 1
      ? `<span class="ar-count-badge">${names.length}</span>`
      : '';

    // tooltip 資料序列化為 JSON 存入 data-ar-tip；雙引號改為 &quot; 避免屬性斷裂
    const tipData = JSON.stringify({ names, roleId: role.roleId }).replace(/"/g, '&quot;');

    return `
      <div style="display:flex; align-items:center; padding:8px 0;">
        <div class="${pulseClass}" style="width:14px; height:14px; border-radius:50%; background:${dotBg}; border:2px solid ${dotBorder}; flex-shrink:0; z-index:2; position:relative;"></div>
        <div style="margin-left:10px; min-width:max-content;">
          <div style="font-size:15px; font-weight:700; color:${titleColor}; letter-spacing:0.5px;">
            <span class="ar-tip" data-ar-tip="${tipData}">
              ${role.roleName}${countBadge}${badge}
            </span>
          </div>
        </div>
      </div>
    `;
  };

  /**
   * [遞迴] 繪製上游 (多源頭樹狀結構)
   *
   * 同 roleName 的兄弟節點合併為一個視覺節點：
   *   - 右上角顯示人數 badge（>1 時）
   *   - hover tooltip 列出所有持有人姓名
   */
  const buildUpstreamHtml = (roleId, roleMap, visited) => {
    const role = roleMap.get(roleId);
    if (!role || role.prevRoleIds.length === 0) return '';

    if (visited.has(roleId))
      return `<div style="color:red;font-size:12px;">(循環錯誤)</div>`;
    visited.add(roleId);

    // 將同層兄弟（prevRoleIds）依 roleName 分組合併
    // Map<roleName, { representative: role, allNames: string[] }>
    const grouped = new Map();
    for (const pId of role.prevRoleIds) {
      const pRole = roleMap.get(pId);
      if (!pRole) continue;
      if (!grouped.has(pRole.roleName)) {
        grouped.set(pRole.roleName, { representative: pRole, allNames: [...pRole.holderNames] });
      } else {
        grouped.get(pRole.roleName).allNames.push(...pRole.holderNames);
      }
    }

    // 渲染每一個合併後的「代表節點」（同名的只渲染一次）
    // 注意：grand-parents 也只遞迴進代表節點（prevRoleIds[0]），避免重複
    const parentsHtml = [...grouped.values()]
      .map(({ representative: pRole, allNames }) => {
        const grandParentsHtml = buildUpstreamHtml(pRole.roleId, roleMap, new Set(visited));
        const nodeHtml = renderNodeHtml(pRole, 'normal', allNames);
        return `
          <div style="display:flex; align-items:center;">
            ${grandParentsHtml}
            ${nodeHtml}
          </div>`;
      })
      .join('');

    const treeClass = grouped.size > 1 ? 'ar-tree-border' : '';

    return `
      <div style="display:flex; align-items:center;">
        <div class="${treeClass}" style="display:flex; flex-direction:column; gap:8px;">
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
   * 將預覽插入空白欄位或指定 Slot，並綁定 floating tooltip 事件。
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
      bindTooltipEvents(container);
      return;
    }

    // 2. 編輯/新增頁：用 kintone API 取得 space 欄位
    const spaceEl = kintone.app.record.getSpaceElement('chain_preview');
    if (spaceEl) {
      spaceEl.insertBefore(container, spaceEl.firstChild);
      bindTooltipEvents(container);
      return;
    }

    // 3. Fallback: 表單底部
    const formEl =
      document.querySelector('.gaia-argoui-app-edit-record') ||
      document.querySelector('.gaia-argoui-app-show-detail') ||
      document.querySelector('#record-gaia');
    if (formEl) {
      formEl.appendChild(container);
      bindTooltipEvents(container);
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
