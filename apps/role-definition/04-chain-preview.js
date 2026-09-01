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
 * 2026-07-12  Jimmy/Claude  新增頁未儲存記錄查不到角色時顯示佔位文字，不再誤報「找不到此角色的資料」
 * 2026-08-26  Jimmy/Claude  上游改為「階層對齊表」：一列＝一條分支、一欄＝一關，
 *                           單位名同列只寫一次、共同上層用 rowspan 只畫一次，消除重複文字
 * 2026-08-26  Jimmy/Claude  共同段落改直式時間軸（圓點 + 關卡標示），解決橫向換行被切成多段的問題
 * 2026-08-26  Jimmy/Claude  高層角色上游可達上百條：改為左右版面（上游區塊／共同段落），
 *                           上游各關靠左不留空欄、超過門檻預設收合成摘要並提供搜尋過濾
 * 2026-08-27  Jimmy/Claude  排版修正：一關掛很多人時標籤在格內換行、上游區塊寬度上限 660px
 *                           自行橫捲（共同段落不再被推出畫面），箭頭與節點包成 flex 不再被換行
 * 2026-08-27  Jimmy/Claude  新增對外介面 ChainPreview.loadRoles / renderInto，供列表頁工具
 *                           tools/08-role-chain-search.js 把鏈畫進任意容器
 * 2026-08-27  Jimmy/Claude  一列橫跨多個單位時原本整列放棄收合、每個標籤都印全名：
 *                           改為格子內依單位分區塊、單位名各寫一次；並修正標籤內的角色名被折成多行
 * 2026-08-27  Jimmy/Claude  混合單位的列改成兩段式下鑽：左欄「多單位（N）」點開列出單位，
 *                           選定單位後該列只顯示該單位的角色與鏈（直屬上一關為錨點不受篩選）；
 *                           選定後格子裡只留職稱，單位名不再重複出現
 * 2026-08-27  Jimmy/Claude  格子樣式統一：一格只有一個角色就畫圓點節點（與直屬上一關同樣式），
 *                           兩個以上才用標籤；所有格子改用同一種「箭頭 + 內容」包法
 * 2026-08-27  Jimmy/Claude  上游改回右對齊：空白欄補在左邊，同一欄＝離本關同樣距離，
 *                           表頭改為「上一關／上2關…」與右側的「本關／下N關」同一套說法
 *                           （原本靠左會讓同一欄一列是課長、一列是課員；當初靠左是為了避免
 *                            內容被推出畫面，該問題已由標籤換行與 660px 上限解決）
 */
(() => {
  'use strict';

  const { APP_ID, ROLE_FIELDS: F, CHECKBOX, HOLDER_TYPE_OPTIONS: HT } = window.ApprovalRouting.Config;
  const { safeHandler, kintoneApi } = window.ApprovalRouting.Utils;

  const PREVIEW_CONTAINER_ID = 'ar-chain-preview-content';
  const MAX_DEPTH = 20; // 防無限迴圈

  // 上游分支超過此數量 → 預設收合成摘要，並提供搜尋框
  // （高層角色如總經理，上游可能上百條，全部攤開會蓋掉真正要看的下游）
  const UPSTREAM_FOLD_THRESHOLD = 8;

  // 單位選擇器裡「全部顯示」用的哨兵值（不能用空字串，那是「未標單位」的真值）
  const ALL_UNITS = '__all__';

  /**
   * 取得所有啟用角色，建成雙向綁定的 Map (roleId → record)
   * @returns {Promise<Map>}
   */
  const fetchRoleMap = async () => {
    const map = new Map();
    const LIMIT = 500;
    let offset = 0;

    // kintone 每頁上限 500，用 offset 翻頁直到取完全部
    for (;;) {
      const resp = await kintoneApi('/k/v1/records.json', 'GET', {
        app: APP_ID.ROLE_DEFINITION,
        fields: [F.ROLE_ID, F.ROLE_NAME, F.NEXT_ROLE_ID, F.IS_CHAIN_END, F.HOLDER_TYPE, F.HOLDER_USER, F.HOLDER_GROUP],
        query: `${F.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}") limit ${LIMIT} offset ${offset}`,
      });

      // 逐筆建立基礎節點
      for (const rec of resp.records) {
        const isEnd =
          Array.isArray(rec[F.IS_CHAIN_END].value) &&
          rec[F.IS_CHAIN_END].value.includes(CHECKBOX.CHAIN_END);

        // USER → 直接從欄位值取姓名（0 API）
        // GROUP → 只存 code，之後僅對可見節點呼叫 /v1/group/users 取成員
        const holderType = rec[F.HOLDER_TYPE].value;
        const holderNames = holderType === HT.USER
          ? (rec[F.HOLDER_USER].value ?? []).map((u) => u.name).filter(Boolean)
          : [];
        const holderGroupCode = holderType === HT.GROUP
          ? (rec[F.HOLDER_GROUP]?.value?.[0]?.code ?? null)
          : null;

        map.set(rec[F.ROLE_ID].value, {
          roleId:          rec[F.ROLE_ID].value,
          roleName:        rec[F.ROLE_NAME].value,
          nextRoleId:      rec[F.NEXT_ROLE_ID].value || '',
          prevRoleIds:     [],
          isChainEnd:      isEnd,
          holderNames,
          holderGroupCode,
        });
      }

      // 回傳筆數不足一頁，代表已到最後一頁
      if (resp.records.length < LIMIT) break;
      offset += LIMIT;
    }

    // 最後一次迴圈：建立反向關聯（需等所有頁都載入後才能建）
    for (const [id, role] of map.entries()) {
      if (role.nextRoleId && map.has(role.nextRoleId)) {
        map.get(role.nextRoleId).prevRoleIds.push(id);
      }
    }

    return map;
  };

  /**
   * 走訪上游（遞迴）與下游（迴圈），回傳當前預覽鏈所有可見 role ID 的 Set。
   */
  const getVisibleRoleIds = (currentRoleId, roleMap) => {
    const visible = new Set([currentRoleId]);
    const addUpstream = (id, seen = new Set()) => {
      if (seen.has(id)) return;
      seen.add(id);
      (roleMap.get(id)?.prevRoleIds ?? []).forEach((pId) => {
        visible.add(pId);
        addUpstream(pId, seen);
      });
    };
    addUpstream(currentRoleId);
    let id = currentRoleId;
    for (let i = 0; i < MAX_DEPTH; i++) {
      const role = roleMap.get(id);
      if (!role?.nextRoleId) break;
      id = role.nextRoleId;
      if (visible.has(id)) break;
      visible.add(id);
      if (roleMap.get(id)?.isChainEnd) break;
    }
    return visible;
  };

  /**
   * 對可見節點中的 GROUP 角色，呼叫 /v1/group/users（一般使用者可用）取成員姓名，
   * 並原地寫回 roleMap[role].holderNames。
   *
   * 與 05-detail-card.js 使用相同的 API 路徑與參數格式（已驗證可行）。
   */
  const fetchGroupMembers = async (visibleRoleIds, roleMap) => {
    const groupRoles = [...visibleRoleIds]
      .map((id) => roleMap.get(id))
      .filter((r) => r?.holderGroupCode);
    if (!groupRoles.length) return;

    // 去重後並行查詢，每個群組一次 API call
    const uniqueCodes = [...new Set(groupRoles.map((r) => r.holderGroupCode))];
    await Promise.all(
      uniqueCodes.map(async (code) => {
        try {
          // 路徑 /v1/group/users（不帶 /k），參數 code（不是 id）
          const resp = await kintone.api('/v1/group/users', 'GET', { code });
          const names = (resp.users ?? []).map((u) => u.name).filter(Boolean);
          groupRoles
            .filter((r) => r.holderGroupCode === code)
            .forEach((r) => { r.holderNames = names; });
        } catch (err) {
          console.warn(`[chain-preview] 無法取得群組 ${code} 的成員:`, err);
        }
      }),
    );
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

      /* class 的 display 會蓋掉 [hidden] 的預設值，這裡統一補回來 */
      #ar-chain-preview-content [hidden], .ar-layout [hidden] { display: none !important; }

      /* 版面：左＝上游區塊（可收合），右＝共同段落 */
      .ar-layout { display: flex; align-items: flex-start; gap: 18px; }
      /* 上游太寬時在自己這一塊裡橫捲，不把右邊的共同段落推出畫面外 */
      .ar-up { min-width: 0; max-width: 660px; overflow-x: auto; }
      .ar-common {
        background: #f8fafc; border-left: 2px solid #cbd5e1;
        border-radius: 0 8px 8px 0; padding: 8px 16px; flex-shrink: 0;
      }

      /* 階層對齊表：一列 = 一條上游分支，一欄 = 離本關同樣距離的一關（右對齊） */
      .ar-grid { border-collapse: separate; border-spacing: 0; }
      .ar-grid th {
        font-size: 11px; color: #94a3b8; font-weight: 700; text-align: left;
        padding: 0 12px 6px; letter-spacing: 0.5px; white-space: nowrap;
      }
      .ar-grid td { padding: 6px 12px; border-top: 1px solid #eef2f6; vertical-align: middle; white-space: nowrap; }
      .ar-grid tbody tr:first-child td { border-top: none; }

      /* 左欄的單位名（同一列共用時只寫一次） */
      .ar-unit { font-size: 13px; color: #64748b; }

      /* 一關有很多人時，標籤在格子內換行（不換行會把整張表撐到要拖畫面才看得完） */
      /* 選擇器要比 .ar-grid td 更明確，否則被上面的 nowrap 蓋掉 */
      .ar-grid td.ar-chips { white-space: normal; max-width: 420px; }

      /* 關與關之間的方向指示 */
      .ar-arrow { color: #cbd5e1; margin-right: 6px; flex-shrink: 0; }
      .ar-to    { color: #cbd5e1; padding-left: 0; padding-right: 0; }
      /* 箭頭是 inline、節點是 block，不包成 flex 會被擠到下一行 */
      .ar-cell-row { display: flex; align-items: center; }

      /* 上游收合按鈕與搜尋框 */
      .ar-fold-btn {
        display: inline-flex; align-items: center; gap: 8px;
        background: #fff; border: 1px dashed #cbd5e1; border-radius: 20px;
        padding: 6px 14px; font-size: 13px; color: #475569; cursor: pointer;
        font-family: inherit;
      }
      .ar-fold-btn:hover { border-color: #94a3b8; background: #f8fafc; }
      .ar-fold-hint { color: #94a3b8; }
      .ar-search-box {
        width: 220px; padding: 5px 10px; font-size: 13px; font-family: inherit;
        border: 1px solid #cbd5e1; border-radius: 6px; color: #475569;
      }
      .ar-search-box:focus { outline: none; border-color: #3b82f6; }
      .ar-search-bar { display: flex; align-items: center; gap: 10px; margin: 10px 0; }
      .ar-search-note { font-size: 12px; color: #94a3b8; }

      /* 展開後仍限制高度，避免上百列把整頁撐到幾千像素 */
      .ar-up-scroll { max-height: 420px; overflow-y: auto; }

      /* 上游職稱標籤 */
      .ar-chip {
        display: inline-flex; align-items: center;
        background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 6px;
        padding: 2px 8px; font-size: 13px; color: #475569;
        margin: 2px 5px 2px 0; cursor: help;
        white-space: nowrap;   /* 折行只發生在標籤之間，不把角色名折斷 */
      }

      /* 混合單位的列：左欄的單位選擇器（點開 → 選單位 → 才顯示該單位的人） */
      .ar-unit-pick {
        display: inline-flex; align-items: center; gap: 6px;
        background: none; border: none; font-family: inherit; font-size: 13px;
        color: #475569; cursor: pointer; padding: 2px 4px; border-radius: 4px;
      }
      .ar-unit-pick:hover { background: #f1f5f9; }
      .ar-unit-list { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; margin-top: 4px; }
      .ar-unit-opt {
        background: none; border: none; font-family: inherit; font-size: 12px;
        color: #2563eb; cursor: pointer; padding: 2px 6px; border-radius: 4px;
        text-align: left; white-space: nowrap;
      }
      .ar-unit-opt:hover { background: #eff6ff; }
      .ar-unit-opt.is-active { background: #dbeafe; font-weight: 700; }
      .ar-unit-hint { font-size: 12px; color: #cbd5e1; white-space: nowrap; }

      /* 一格內橫跨多個單位時：單位名自成一行寫一次，底下才是該單位的職稱 */
      .ar-unit-block + .ar-unit-block { margin-top: 8px; }
      .ar-unit-tag {
        display: block; font-size: 11px; color: #94a3b8;
        white-space: nowrap; margin-bottom: 1px;
      }

      /* 共同段落：直式時間軸（不論幾關都是一條連續的線，不換行也不橫捲） */
      .ar-vchain { position: relative; padding-left: 2px; }
      .ar-vchain::before {
        content: ''; position: absolute; left: 6px; top: 16px; bottom: 16px;
        width: 2px; background: #cbd5e1;
      }
      .ar-vrow { display: flex; align-items: center; gap: 9px; padding: 4px 0; position: relative; }
      /* 圓點外圈用儲存格底色描邊，讓垂直線看起來被節點斷開 */
      .ar-vdot { box-shadow: 0 0 0 3px #f8fafc; }
      .ar-step { font-size: 11px; color: #94a3b8; min-width: 40px; flex-shrink: 0; }

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

  /**
   * 綁定上游區塊的互動：收合切換與即時搜尋（同樣用事件委派，重繪後不必解綁）。
   */
  const bindUpstreamEvents = (containerEl) => {
    containerEl.addEventListener('click', (e) => {
      // ① 多單位：點開／收起單位清單
      const picker = e.target.closest('[data-ar-units]');
      if (picker) {
        const list = picker.parentElement.querySelector('[data-ar-unit-list]');
        if (!list) return;
        list.hidden = !list.hidden;
        picker.querySelector('.ar-caret').textContent = list.hidden ? '▸' : '▾';
        return;
      }

      // ② 選定單位：該列只顯示這個單位的角色（直屬上一關是錨點，不受影響）
      const opt = e.target.closest('[data-ar-unit]');
      if (opt) {
        const tr = opt.closest('tr');
        const unit = opt.dataset.arUnit;
        const isAll = unit === ALL_UNITS;

        tr.querySelectorAll('.ar-unit-block[data-unit]').forEach((block) => {
          block.hidden = !isAll && block.dataset.unit !== unit;
        });
        // 選定單一單位後，單位名已寫在左欄，格子裡只留職稱；
        // 「全部顯示」時各區塊混在一起，才需要把單位名標回去
        tr.querySelectorAll('.ar-unit-block[data-unit] .ar-unit-tag').forEach((tag) => {
          tag.hidden = !isAll;
        });
        tr.querySelectorAll('[data-ar-unit-hint]').forEach((hint) => { hint.hidden = true; });
        tr.querySelectorAll('.ar-arrow').forEach((arrow) => { arrow.hidden = false; });
        tr.querySelectorAll('[data-ar-unit]').forEach((b) => b.classList.toggle('is-active', b === opt));

        const label = tr.querySelector('[data-ar-unit-label]');
        if (label) label.textContent = isAll ? opt.dataset.arAllLabel : (unit || '（未標單位）');
        return;
      }

      // ③ 上游收合
      const btn = e.target.closest('[data-ar-fold]');
      if (!btn) return;
      const body = containerEl.querySelector('[data-ar-fold-body]');
      if (!body) return;

      const willOpen = body.hidden;
      body.hidden = !willOpen;
      btn.querySelector('.ar-caret').textContent = willOpen ? '▾' : '▸';
      btn.querySelector('.ar-fold-hint').textContent = willOpen ? '（收合）' : '（展開全部）';
      if (willOpen) body.querySelector('[data-ar-search-box]')?.focus();
    });

    containerEl.addEventListener('input', (e) => {
      const box = e.target.closest('[data-ar-search-box]');
      if (!box) return;

      const keyword = box.value.trim().toLowerCase();
      const trs = containerEl.querySelectorAll('.ar-grid tbody tr');
      let hit = 0;
      for (const tr of trs) {
        const match = !keyword || (tr.dataset.arSearch ?? '').includes(keyword);
        tr.hidden = !match;
        if (match) hit++;
      }

      const note = containerEl.querySelector('[data-ar-search-note]');
      if (note) note.textContent = keyword ? `符合 ${hit} 條分支` : '';
    });
  };

  /** 掛上預覽區的所有事件（tooltip + 上游互動） */
  const bindPreviewEvents = (containerEl) => {
    bindTooltipEvents(containerEl);
    bindUpstreamEvents(containerEl);
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
  /** 各狀態的配色與標籤（橫式節點與直式節點共用） */
  const NODE_STYLE = Object.freeze({
    normal:  { dotBg: '#e2e8f0', dotBorder: '#94a3b8', titleColor: '#64748b', pulseClass: '', badge: '' },
    current: {
      dotBg: '#3b82f6', dotBorder: '#2563eb', titleColor: '#1d4ed8', pulseClass: 'ar-pulse',
      badge: '<span style="background:#e0e7ff;color:#4f46e5;font-size:11px;padding:2px 8px;border-radius:12px;margin-left:8px;font-weight:600;border:1px solid #c7d2fe;">目前</span>',
    },
    end: {
      dotBg: '#22c55e', dotBorder: '#16a34a', titleColor: '#15803d', pulseClass: '',
      badge: '<span style="background:#dcfce7;color:#16a34a;font-size:11px;padding:2px 8px;border-radius:12px;margin-left:8px;font-weight:600;border:1px solid #bbf7d0;">終點</span>',
    },
    broken: {
      dotBg: '#ef4444', dotBorder: '#dc2626', titleColor: '#b91c1c', pulseClass: '',
      badge: '<span style="background:#fee2e2;color:#b91c1c;font-size:11px;padding:2px 8px;border-radius:12px;margin-left:8px;font-weight:600;">中斷</span>',
    },
  });

  const renderNodeHtml = (role, state = 'normal', holderNames) => {
    const { dotBg, dotBorder, titleColor, pulseClass, badge } = NODE_STYLE[state] ?? NODE_STYLE.normal;

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

  // ─── 上游：階層對齊表（一列 = 一條分支、一欄 = 一關）───

  /**
   * 把角色名稱拆成「單位」與「職稱」，只用於畫面上消除重複文字。
   * ⚠ 純顯示用途，不參與任何簽核者推導（推導一律走 role_id）。
   * 找不到分隔符號時，整串當作職稱、單位留空。
   */
  const splitRoleName = (roleName = '') => {
    const idx = Math.max(roleName.lastIndexOf('－'), roleName.lastIndexOf('—'), roleName.lastIndexOf('-'));
    return idx > 0
      ? { unit: roleName.slice(0, idx), title: roleName.slice(idx + 1) }
      : { unit: '', title: roleName };
  };

  /**
   * 把一批 roleId 依 roleName 合併成群組（同名只出現一次、人數與姓名累加）。
   * @returns {Array<{ representative: object, roleIds: string[], names: string[] }>}
   */
  const mergeByRoleName = (roleIds, roleMap) => {
    const grouped = new Map();
    for (const id of roleIds) {
      const role = roleMap.get(id);
      if (!role) continue;
      const g = grouped.get(role.roleName)
        ?? { representative: role, roleIds: [], names: [] };
      g.roleIds.push(id);
      g.names.push(...role.holderNames);
      grouped.set(role.roleName, g);
    }
    return [...grouped.values()];
  };

  /**
   * 建立上游矩陣：目前節點的每一個「直屬上一關」各成一列，
   * 再沿著 prevRoleIds 逐關往外 BFS，同一關的所有角色放進同一格。
   *
   * @returns {Array<Array<Array<object>>>} rows[列][關] = 該格的群組陣列
   *          每列 index 0 為最靠近目前節點的那一關（渲染時靠右對齊）
   */
  const buildUpstreamMatrix = (currentRoleId, roleMap) => {
    const directGroups = mergeByRoleName(roleMap.get(currentRoleId)?.prevRoleIds ?? [], roleMap);

    return directGroups.map((group) => {
      const levels = [[group]];
      // visited 同時擔任防循環：同一個角色在同一列只會出現一次
      const visited = new Set([currentRoleId, ...group.roleIds]);
      let frontier = group.roleIds;

      for (let d = 0; d < MAX_DEPTH; d++) {
        const prevIds = frontier
          .flatMap((id) => roleMap.get(id)?.prevRoleIds ?? [])
          .filter((id) => !visited.has(id));
        if (prevIds.length === 0) break;
        prevIds.forEach((id) => visited.add(id));
        levels.push(mergeByRoleName(prevIds, roleMap));
        frontier = prevIds;
      }
      return levels;
    });
  };

  /** 該列所有角色是否共用同一個單位名；是則回傳單位名，否則回傳空字串 */
  const getRowUnit = (levels) => {
    const units = levels
      .flat()
      .map((g) => splitRoleName(g.representative.roleName).unit);
    return units.length && units.every((u) => u && u === units[0]) ? units[0] : '';
  };

  /** 單一群組的 tooltip 資料（人數 + 角色代碼），與 renderNodeHtml 用同一格式 */
  const tipAttr = (group) =>
    JSON.stringify({ names: group.names, roleId: group.representative.roleId }).replace(/"/g, '&quot;');

  /**
   * 把同一格的群組依單位分組（保持原順序），讓混合單位的格子也能只寫一次單位名。
   * @returns {Array<{unit: string, groups: Array}>}
   */
  const groupByUnit = (groups) => {
    const byUnit = new Map();
    for (const g of groups) {
      const { unit } = splitRoleName(g.representative.roleName);
      if (!byUnit.has(unit)) byUnit.set(unit, []);
      byUnit.get(unit).push(g);
    }
    return [...byUnit.entries()].map(([unit, gs]) => ({ unit, groups: gs }));
  };

  /** 依「這一格採用的單位名」決定標籤上要不要拿掉單位前綴 */
  const labelOf = (group, cellUnit) => {
    const { unit, title } = splitRoleName(group.representative.roleName);
    return cellUnit && unit === cellUnit ? title : group.representative.roleName;
  };

  const chipHtml = (g, cellUnit) => {
    const count = g.names.length > 1 ? `<span class="ar-count-badge">${g.names.length}</span>` : '';
    return `<span class="ar-chip" data-ar-tip="${tipAttr(g)}">${labelOf(g, cellUnit)}${count}</span>`;
  };

  const nodeOf = (g, cellUnit) =>
    renderNodeHtml({ ...g.representative, roleName: labelOf(g, cellUnit) }, 'normal', g.names);

  /**
   * 一格內的角色：只有一個就畫成圓點節點（與直屬上一關同樣式，鏈的圓點才連得起來），
   * 兩個以上才用標籤並排（不然一整排圓點又高又長）。
   */
  const cellItemsHtml = (gs, cellUnit) =>
    (gs.length === 1 ? nodeOf(gs[0], cellUnit) : gs.map((g) => chipHtml(g, cellUnit)).join(''));

  /**
   * 一般欄位：以標籤（chip）呈現同一關的多個角色。
   *
   * 整列共用同一個單位時，單位名已寫在左欄，這裡只留職稱；
   * 一列橫跨多個單位時（例如某課長同時收營業 Team 與 CS Team），
   * 改成格子內依單位分行，單位名各寫一次——否則每個標籤都要印全名。
   */
  const renderChipsCell = (groups, rowUnit, drillDown = false) => {
    if (rowUnit) return cellItemsHtml(groups, rowUnit);

    return groupByUnit(groups)
      .map(({ unit, groups: gs }) => `
        <div class="ar-unit-block" data-unit="${unit}"${drillDown ? ' hidden' : ''}>
          ${unit ? `<span class="ar-unit-tag">${unit}</span>` : ''}
          <div>${cellItemsHtml(gs, unit)}</div>
        </div>`)
      .join('');
  };

  /** 最靠近目前節點的那一關：沿用圓點節點樣式，維持流程線的視覺連續性 */
  const renderNodesCell = (groups, rowUnit) => {
    const nodes = (gs, cellUnit) => gs.map((g) => nodeOf(g, cellUnit)).join('');

    if (rowUnit) return nodes(groups, rowUnit);

    return groupByUnit(groups)
      .map(({ unit, groups: gs }) => `
        <div class="ar-unit-block">
          ${unit ? `<span class="ar-unit-tag">${unit}</span>` : ''}
          ${nodes(gs, unit)}
        </div>`)
      .join('');
  };

  /** 上游總覽數字（收合時的摘要用） */
  const buildUpstreamStats = (rows) => {
    const units = new Set();
    const roleIds = new Set();
    const people = new Set();

    // rows[列][關][群組] → flat(2) 取出所有群組
    for (const group of rows.flat(2)) {
      group.roleIds.forEach((id) => roleIds.add(id));
      group.names.forEach((n) => people.add(n));
      const { unit } = splitRoleName(group.representative.roleName);
      if (unit) units.add(unit);
    }
    return { units: units.size, branches: rows.length, roles: roleIds.size, people: people.size };
  };

  /**
   * 上游區塊：表格 + （分支多時）收合摘要與搜尋框。
   *
   * 各關一律靠左排、不留空欄——分支深度不齊時若靠右對齊，
   * 淺分支左邊會出現大片空白、把內容推出畫面外。
   */
  const renderUpstreamBlockHtml = (rows) => {
    if (rows.length === 0) return '';

    const colCount = rows.reduce((max, levels) => Math.max(max, levels.length), 0);

    const rowsHtml = rows.map((levels) => {
      const rowUnit = getRowUnit(levels);

      // levels[0] 最靠近目前節點 → 反轉後由外而內、由左而右排列
      const ordered = [...levels].reverse();

      // 上游各關（不含最後的直屬上一關）橫跨兩個以上單位 → 改成兩段式：
      // 先在左欄點開單位清單，選了單位才顯示該單位的人與鏈，避免全部攤開很亂
      const upstreamUnits = [...new Set(
        levels.slice(1).flat().map((g) => splitRoleName(g.representative.roleName).unit),
      )];
      const drillDown = !rowUnit && upstreamUnits.length > 1;

      const cells = ordered.map((groups, col) => {
        const isDirectPrev = col === ordered.length - 1; // 最後一格 = 目前節點的上一關
        // 尚未選單位時整列是空的，箭頭會變成孤零零的符號 → 一起收起來
        const arrow = col === 0 ? '' : `<span class="ar-arrow"${drillDown ? ' hidden' : ''}>›</span>`;
        // 節點格：箭頭與節點包成 flex 才會同一行；同一關有多個節點時仍上下堆疊
        // （直屬上一關是整列的錨點，不參與單位篩選，永遠顯示）
        const content = isDirectPrev
          ? renderNodesCell(groups, rowUnit)
          : renderChipsCell(groups, rowUnit, drillDown) +
            (drillDown && col === 0 ? '<span class="ar-unit-hint" data-ar-unit-hint>← 先在左欄選單位</span>' : '');

        return `<td class="${isDirectPrev ? '' : 'ar-chips'}">` +
          `<div class="ar-cell-row">${arrow}<div>${content}</div></div></td>`;
      }).join('');

      // 空白欄補在左邊：每列的「直屬上一關」對齊在同一欄，
      // 同一欄＝離本關同樣的距離；分支較短就左邊留白（正確表達它比較短）
      const padding = '<td></td>'.repeat(colCount - ordered.length);

      // 搜尋用關鍵字：單位 + 該列所有角色全名（不受單位收合影響）
      const keywords = [rowUnit, ...levels.flat().map((g) => g.representative.roleName)]
        .join(' ').toLowerCase().replace(/"/g, '');

      // 左欄：單一單位就直接寫；混合單位時是可點開的單位選擇器
      const unitCount = new Set(
        levels.flat().map((g) => splitRoleName(g.representative.roleName).unit).filter(Boolean),
      ).size;
      const allLabel = `多單位（${upstreamUnits.length}）`;

      let unitCell;
      if (rowUnit) {
        unitCell = rowUnit;
      } else if (drillDown) {
        unitCell = `
          <button type="button" class="ar-unit-pick" data-ar-units>
            <span class="ar-caret">▸</span><span data-ar-unit-label>${allLabel}</span>
          </button>
          <div class="ar-unit-list" data-ar-unit-list hidden>
            ${upstreamUnits.map((u) => `
              <button type="button" class="ar-unit-opt" data-ar-unit="${u}">${u || '（未標單位）'}</button>`).join('')}
            <button type="button" class="ar-unit-opt" data-ar-unit="${ALL_UNITS}"
              data-ar-all-label="${allLabel}">全部顯示</button>
          </div>`;
      } else {
        unitCell = unitCount > 1 ? `多單位（${unitCount}）` : '—';
      }

      return `<tr data-ar-search="${keywords}"><td class="ar-unit">${unitCell}</td>${padding}${cells}<td class="ar-to">→</td></tr>`;
    }).join('');

    // 表頭由右往左數：最右邊的上游欄就是「上一關」，再往左是上二關…
    const headers = Array.from({ length: colCount }, (_, col) => {
      const distance = colCount - col;
      return `<th>${distance === 1 ? '上一關' : `上${distance}關`}</th>`;
    }).join('');

    const tableHtml = `
      <table class="ar-grid">
        <thead><tr><th>單位</th>${headers}<th></th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    `;

    // 分支數在門檻內 → 直接攤開，不加任何互動元件
    if (rows.length <= UPSTREAM_FOLD_THRESHOLD) {
      return `<div class="ar-up">${tableHtml}</div>`;
    }

    const { units, branches, roles, people } = buildUpstreamStats(rows);
    const summary = `上游　${units} 個單位 · ${branches} 條分支 · ${roles} 個角色 · ${people} 位同仁`;

    return `
      <div class="ar-up">
        <button type="button" class="ar-fold-btn" data-ar-fold>
          <span class="ar-caret">▸</span>
          <span>${summary}</span>
          <span class="ar-fold-hint">（展開全部）</span>
        </button>
        <div data-ar-fold-body hidden>
          <div class="ar-search-bar">
            <input type="text" class="ar-search-box" data-ar-search-box placeholder="輸入單位或角色名稱過濾…">
            <span class="ar-search-note" data-ar-search-note></span>
          </div>
          <div class="ar-up-scroll">${tableHtml}</div>
        </div>
      </div>
    `;
  };

  /**
   * [迴圈] 收集下游節點 (一直線到終點)
   * @returns {Array<{ role: object, state: 'normal'|'end'|'broken' }>}
   */
  const collectDownstreamNodes = (startRoleId, roleMap) => {
    const nodes = [];
    let currentId = startRoleId;
    const visited = new Set();

    for (let i = 0; i < MAX_DEPTH; i++) {
      const role = roleMap.get(currentId);
      if (!role) break;

      currentId = role.nextRoleId; // 往下走
      if (!currentId) break;

      if (visited.has(currentId)) {
        nodes.push({ role: { roleName: '錯誤', roleId: '偵測到循環' }, state: 'broken' });
        break;
      }
      visited.add(currentId);

      const nextRole = roleMap.get(currentId);
      if (!nextRole) {
        nodes.push({ role: { roleName: '遺失節點', roleId: currentId }, state: 'broken' });
        break;
      }

      nodes.push({ role: nextRole, state: nextRole.isChainEnd ? 'end' : 'normal' });

      if (nextRole.isChainEnd) break;
    }
    return nodes;
  };

  /**
   * 直式節點（共同段落用）：圓點 + 關卡標示 + 名稱，靠 .ar-vchain 的垂直線串起來。
   *
   * 上游各分支深度不一，絕對關數對不齊，因此標示改成相對目前節點：
   * 本關 / 下 1 關 / 下 2 關 …
   *
   * @param {number} stepIdx - 0 = 目前這關
   */
  const renderVerticalNodeHtml = (role, state, stepIdx) => {
    const step = stepIdx === 0 ? '本關' : `下${stepIdx}關`;
    const { dotBg, dotBorder, titleColor, pulseClass, badge } = NODE_STYLE[state] ?? NODE_STYLE.normal;
    const names      = role.holderNames || [];
    const countBadge = names.length > 1 ? `<span class="ar-count-badge">${names.length}</span>` : '';
    const tipData    = JSON.stringify({ names, roleId: role.roleId }).replace(/"/g, '&quot;');

    return `
      <div class="ar-vrow">
        <div class="ar-vdot ${pulseClass}" style="width:14px; height:14px; border-radius:50%; background:${dotBg}; border:2px solid ${dotBorder}; flex-shrink:0;"></div>
        <span class="ar-step">${step}</span>
        <div style="font-size:15px; font-weight:700; color:${titleColor}; letter-spacing:0.5px; white-space:nowrap;">
          <span class="ar-tip" data-ar-tip="${tipData}">${role.roleName}${countBadge}${badge}</span>
        </div>
      </div>
    `;
  };

  /**
   * 組合完整畫面： 上游(Tree) ➔ 目前節點 ➔ 下游(Linear)
   */
  const renderFullChainHtml = (currentRoleId, roleMap) => {
    const currentRole = roleMap.get(currentRoleId);
    if (!currentRole) {
      // 新增中尚未儲存的記錄，role_id 還沒寫進資料庫，查不到是正常現象，非資料錯誤
      let isUnsaved = false;
      try {
        isUnsaved = !kintone.app.record.get().record.$id?.value;
      } catch { /* detail 頁必為已存在記錄 → 忽略 */ }

      return isUnsaved
        ? '<div style="color:#999; padding:12px;">儲存後即可預覽簽核流程</div>'
        : '<div style="color: #999; padding: 12px;">找不到此角色的資料，請確認是否已啟用。</div>';
    }

    // 目前節點 + 下游（所有上游分支共用，只畫一次）
    const commonNodes = [
      { role: currentRole, state: 'current' },
      ...collectDownstreamNodes(currentRoleId, roleMap),
    ];
    const commonHtml = `
      <div class="ar-common">
        <div class="ar-vchain">
          ${commonNodes.map((n, i) => renderVerticalNodeHtml(n.role, n.state, i)).join('')}
        </div>
      </div>
    `;

    const rows = buildUpstreamMatrix(currentRoleId, roleMap);

    return `
      ${timelineStyles}
      <div style="padding: 16px 24px; overflow-x: auto; background: #fafafa; border-radius: 8px; border: 1px solid #f0f0f0;">
        <div class="ar-layout">
          ${renderUpstreamBlockHtml(rows)}
          ${commonHtml}
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
      bindPreviewEvents(container);
      return;
    }

    // 2. 編輯/新增頁：用 kintone API 取得 space 欄位
    const spaceEl = kintone.app.record.getSpaceElement('chain_preview');
    if (spaceEl) {
      spaceEl.insertBefore(container, spaceEl.firstChild);
      bindPreviewEvents(container);
      return;
    }

    // 3. Fallback: 表單底部
    const formEl =
      document.querySelector('.gaia-argoui-app-edit-record') ||
      document.querySelector('.gaia-argoui-app-show-detail') ||
      document.querySelector('#record-gaia');
    if (formEl) {
      formEl.appendChild(container);
      bindPreviewEvents(container);
    }
  };

  const renderChainPreview = async (currentRoleId) => {
    if (!currentRoleId) {
      mountPreview(
        '<div style="color:#999; padding:12px;">儲存後即可預覽簽核流程</div>',
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
        const rec = kintone.app.record.get().record;
        liveEntry.nextRoleId = rec[F.NEXT_ROLE_ID].value || '';
        liveEntry.isChainEnd = (rec[F.IS_CHAIN_END].value ?? []).includes(CHECKBOX.CHAIN_END);
      } catch { /* detail 頁 or 無 record context → 跳過，使用 DB 值 */ }
    }

    // ③ 只查當前預覽鏈可見的 GROUP 角色成員（避免全量查詢）
    const visibleIds = getVisibleRoleIds(currentRoleId, roleMap);
    await fetchGroupMembers(visibleIds, roleMap);

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
          '<div style="color:#999; padding:12px;">儲存後即可預覽簽核流程</div>',
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

  /**
   * 把指定角色的簽核鏈畫進任意容器（列表頁的「查簽核鏈」工具用）。
   *
   * 與 refresh() 的差別：不碰 kintone 記錄 context、不找空白欄位，
   * 純粹「給我容器與 role_id，我畫給你」。
   *
   * @param {HTMLElement} targetEl - 要畫進去的容器（內容會被覆蓋）
   * @param {string} roleId
   * @param {Map} [roleMap] - 已載入的角色表；不給就自己抓一次
   */
  const renderChainInto = async (targetEl, roleId, roleMap) => {
    const map = roleMap ?? await fetchRoleMap();
    // 只補當前鏈上 GROUP 角色的成員（同一份 roleMap 重複呼叫是安全的）
    await fetchGroupMembers(getVisibleRoleIds(roleId, map), map);
    targetEl.innerHTML = renderFullChainHtml(roleId, map);
    bindPreviewEvents(targetEl);
  };

  // 對外暴露：
  //   refresh    — 03-next-role-dropdown.js 在 dropdown change 後手動呼叫
  //   loadRoles  — 取得整份角色表（列表頁工具可載一次重複使用）
  //   renderInto — 把某個角色的鏈畫進任意容器
  window.ApprovalRouting = window.ApprovalRouting || {};
  window.ApprovalRouting.ChainPreview = Object.freeze({
    refresh: renderChainPreview,
    loadRoles: fetchRoleMap,
    renderInto: renderChainInto,
  });
})();
