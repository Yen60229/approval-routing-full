/**
 * 工具列註冊表 — 把散落在列表頁的十幾顆按鈕，收成「系統健檢／查詢／維護／部署」四顆下拉
 *
 * 為什麼要這層：工具一支支長出來之後，685 的列表頁最多會同時出現 9 顆按鈕，
 * HR 得記住哪顆做什麼；而且每支各自寫一遍「建立按鈕 → 找 header → appendChild」，
 * App ID 守門有的有、有的沒有，貼錯 App 就冒出不該有的按鈕（見 docs/10 §二）。
 *
 * 這裡只做**容器**，不合併工具本體：每支工具照舊是自己的 IIFE，
 * 只把最後那段掛按鈕換成 `ToolRegistry.register({...})`。
 *
 * 【分組】docs/10-工具按鈕盤點與分組.md
 *   系統健檢 inspect  — 掃描 → 勾選 → 批次修正（互動一致、資料來源重疊）
 *   查詢 query    — 唯讀，輸入關鍵字看一條鏈
 *   維護 maintain — 主動性的大量寫入作業
 *   部署 deploy   — 把流程設定寫進申請 App（只在 736）
 *
 * 【影響的欄位】
 *   - 無（純 UI 容器）
 *
 * 【依賴】
 *   - core/04-utils.js（Utils.safeHandler）
 *   - SweetAlert2（工具執行失敗時報錯）
 *   ⚠️ 必須在所有 tools/*.js 之前載入（core 一律先載，自動滿足）
 *
 * 【變更履歷】
 *   2026-09-01  Jimmy/Claude  初版建立
 */
(() => {
  'use strict';

  const { safeHandler } = window.ApprovalRouting.Utils;

  const CONTAINER_ID = 'ar-toolbar';

  const GROUPS = Object.freeze([
    Object.freeze({ key: 'inspect',  label: '系統健檢', color: '#8e44ad', hint: '掃出問題並就地修正' }),
    Object.freeze({ key: 'query',    label: '查詢', color: '#2980b9', hint: '唯讀，不會寫入任何資料' }),
    Object.freeze({ key: 'maintain', label: '維護', color: '#16a085', hint: '大量建立或修改設定' }),
    Object.freeze({ key: 'deploy',   label: '部署', color: '#b45309', hint: '寫入申請 App 的流程設定' }),
  ]);

  const GROUP_KEYS = new Set(GROUPS.map((g) => g.key));

  /** 已註冊的工具，依註冊順序（＝ JS 上傳順序，剛好就是檔名編號） */
  const tools = [];

  /**
   * 目前展開的選單。放在模組層而不是 mountInto 裡面，是因為「點別處收起來」的
   * document 監聽只掛一次——每次掛工具列都掛一組的話，列表頁換頁重畫就會愈疊愈多。
   */
  let openPanel = null;
  const closeOpenPanel = () => {
    if (openPanel) { openPanel.style.display = 'none'; openPanel = null; }
  };
  document.addEventListener('click', closeOpenPanel);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOpenPanel(); });

  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /**
   * 註冊一支工具
   *
   * @param {Object} tool
   * @param {string} tool.id      - 唯一代號（重複註冊會覆蓋，避免同一支 JS 被載入兩次長出兩顆）
   * @param {string} tool.group   - inspect / query / maintain / deploy
   * @param {string} tool.label   - 選單上的文字
   * @param {string} [tool.hint]  - 選單上的一行說明（HR 看得懂的白話）
   * @param {number[]} [tool.apps] - 可用的 App ID；省略＝不限（由上傳位置決定）
   * @param {Function} tool.run   - 點下去要跑的進入點（可為 async）
   */
  const register = (tool) => {
    if (!tool || !tool.id || !tool.label || typeof tool.run !== 'function') {
      console.error('[ApprovalRouting] 工具註冊失敗：缺少 id / label / run', tool);
      return;
    }
    if (!GROUP_KEYS.has(tool.group)) {
      console.error(`[ApprovalRouting] 工具「${tool.label}」的 group 不合法：${tool.group}`);
      return;
    }

    const entry = Object.freeze({ apps: [], hint: '', ...tool });
    const idx = tools.findIndex((t) => t.id === entry.id);
    if (idx >= 0) tools[idx] = entry;
    else tools.push(entry);
  };

  /** 這個 App 用得到的工具，依分組整理（沒有工具的分組不會出現） */
  const listFor = (appId) => {
    const id = Number(appId);
    const usable = tools.filter((t) => !t.apps.length || t.apps.includes(id));
    return GROUPS
      .map((g) => ({ ...g, tools: usable.filter((t) => t.group === g.key) }))
      .filter((g) => g.tools.length);
  };

  /** 執行一支工具：統一收斂錯誤處理，個別工具不必再各寫一次 try/catch */
  const runTool = async (tool) => {
    try {
      await tool.run();
    } catch (err) {
      console.error(`[ApprovalRouting] ${tool.label} 執行失敗`, err);
      // 工具中途可能開著 loading 視窗，先關掉才看得到錯誤
      if (window.Swal) {
        Swal.close();
        await Swal.fire({ icon: 'error', title: `${tool.label}失敗`, text: err?.message || String(err) });
      }
    }
  };

  /**
   * 把工具列畫進指定容器
   * @param {HTMLElement} container - kintone 的 header menu space
   * @param {number} appId
   * @returns {HTMLElement|null} 工具列元素；這個 App 沒有可用工具時回 null
   */
  const mountInto = (container, appId) => {
    if (!container) return null;
    document.getElementById(CONTAINER_ID)?.remove();

    const groups = listFor(appId);
    if (!groups.length) return null;

    const bar = document.createElement('div');
    bar.id = CONTAINER_ID;
    bar.style.cssText = 'display:inline-flex; gap:8px; margin-left:8px; vertical-align:middle;';

    const closeOpen = closeOpenPanel;

    for (const group of groups) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:relative; display:inline-block;';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.group = group.key;
      btn.textContent = `${group.label} ▾`;
      btn.title = group.hint;
      btn.style.cssText =
        `font-size:15px; padding:9px 18px; background:${group.color}; color:#fff; ` +
        'border:none; border-radius:6px; cursor:pointer;';

      const panel = document.createElement('div');
      panel.style.cssText =
        'position:absolute; top:calc(100% + 6px); left:0; min-width:300px; background:#fff; ' +
        'border:1px solid #ddd; border-radius:8px; box-shadow:0 6px 24px rgba(0,0,0,.18); ' +
        'z-index:1000; display:none; overflow:hidden;';

      panel.innerHTML = group.tools.map((t, i) => `
        <div data-idx="${i}" role="button" tabindex="0"
             style="padding:11px 14px; cursor:pointer; ${i ? 'border-top:1px solid #f0f0f0;' : ''}">
          <div style="font-size:15px; font-weight:600;">${esc(t.label)}</div>
          ${t.hint ? `<div style="font-size:12px; color:#777; margin-top:2px;">${esc(t.hint)}</div>` : ''}
        </div>`).join('');

      panel.addEventListener('mouseover', (e) => {
        const row = e.target.closest('[data-idx]');
        if (row) row.style.background = '#f5f3ff';
      });
      panel.addEventListener('mouseout', (e) => {
        const row = e.target.closest('[data-idx]');
        if (row) row.style.background = '';
      });
      panel.addEventListener('click', (e) => {
        const idx = e.target.closest('[data-idx]')?.dataset.idx;
        if (idx === undefined) return;
        closeOpen();
        runTool(group.tools[Number(idx)]);
      });

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = panel.style.display === 'block';
        closeOpen();
        if (!isOpen) { panel.style.display = 'block'; openPanel = panel; }
      });

      wrap.append(btn, panel);
      bar.appendChild(wrap);
    }

    container.appendChild(bar);
    return bar;
  };

  kintone.events.on(['app.record.index.show'], safeHandler(async (event) => {
    if (document.getElementById(CONTAINER_ID)) return event;

    const container = kintone.app.getHeaderMenuSpaceElement?.() ||
                      document.querySelector('.gaia-argoui-app-index-toolbar');
    mountInto(container, kintone.app.getId());
    return event;
  }));

  window.ApprovalRouting = window.ApprovalRouting || {};
  window.ApprovalRouting.ToolRegistry = Object.freeze({
    register, listFor, mountInto, runTool, GROUPS, CONTAINER_ID,
  });
})();
