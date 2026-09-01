/**
 * 批次設定下一關角色（kintone App 685）
 *
 * 在角色定義表列表頁加入「批次設定下一關」按鈕。以 **role_name 為單位**列出所有
 * 啟用中的角色（同名角色在本系統視為同一關卡，故一併處理），勾選多個來源角色 →
 * 挑一個「下一關角色」→ 一次寫入所有選中角色的 next_role_id。
 *
 * 送出前的三道防護：
 *   1. 自我循環  — 目標不可與來源同名
 *   2. 迴圈偵測  — 從目標沿 next_role_id 往下走，若走回任一來源角色即擋下並指出路徑
 *   3. 終點衝突  — 來源若勾了 is_chain_end，設定下一關後就不是終點，
 *                  確認視窗會列出這些角色並在套用時一併取消終點標記
 *
 * 【影響的欄位】
 *   - 685 next_role_id：寫入選定的目標角色 role_id
 *   - 685 is_chain_end：來源原本標記為終點時一併清空（否則與 next_role_id 互相矛盾）
 *   （holder_user / holder_group 完全不動）
 *
 * 【依賴】
 *   - core/01-config.js（Config）
 *   - core/04-utils.js（Utils）
 *
 * 【變更履歷】
 *   2026-08-19  Jimmy/Claude  初版建立
 */
(() => {
  'use strict';

  const { APP_ID, ROLE_FIELDS: RF, CHECKBOX } = window.ApprovalRouting.Config;
  const { safeHandler, kintoneApi, showWarning } = window.ApprovalRouting.Utils;

  const CONFIG = Object.freeze({
    BTN_ID:      'ar-batch-next-btn',
    OVERLAY_ID:  'ar-batch-next-overlay',
    RECORD_PAGE: 500,
    WRITE_BATCH: 100,
    MAX_WALK:    50,    // 迴圈偵測的最大步數，與 chain-builder 的深度上限同量級
  });

  const UNGROUPED_LABEL = '（未分類）';

  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const chunk = (arr, size) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };

  // ═══════════════════════════════════════════════════════════════════
  // 資料讀取
  // ═══════════════════════════════════════════════════════════════════

  /** 撈所有啟用中的角色記錄 */
  const fetchActiveRoles = async () => {
    const all = [];
    let offset = 0;
    while (true) {
      const resp = await kintoneApi('/k/v1/records.json', 'GET', {
        app: APP_ID.ROLE_DEFINITION,
        fields: ['$id', RF.ROLE_ID, RF.ROLE_NAME, RF.UNIT_NAME, RF.NEXT_ROLE_ID, RF.IS_CHAIN_END],
        query: `${RF.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}") limit ${CONFIG.RECORD_PAGE} offset ${offset}`,
      });
      all.push(...resp.records);
      if (resp.records.length < CONFIG.RECORD_PAGE) break;
      offset += CONFIG.RECORD_PAGE;
    }

    return all.map((rec) => ({
      recordId:   rec.$id.value,
      roleId:     rec[RF.ROLE_ID]?.value || '',
      roleName:   rec[RF.ROLE_NAME]?.value || '',
      unitName:   rec[RF.UNIT_NAME]?.value || '',
      nextRoleId: rec[RF.NEXT_ROLE_ID]?.value || '',
      isChainEnd: (rec[RF.IS_CHAIN_END]?.value || []).includes(CHECKBOX.CHAIN_END),
    }));
  };

  /**
   * 以 role_name 聚合成「關卡」
   * @returns {{groups: Array, nameByRoleId: Map, nextByRoleId: Map}}
   *   groups     ：[{ roleName, unitName, records[], roleId(代表值), nextNames[], endCount }]
   *   nameByRoleId：role_id → role_name（迴圈偵測時把 id 翻成看得懂的名稱）
   *   nextByRoleId：role_id → next_role_id（迴圈偵測用）
   */
  const buildGroups = (roles) => {
    const nameByRoleId = new Map();
    const nextByRoleId = new Map();
    const map = new Map();

    for (const r of roles) {
      nameByRoleId.set(r.roleId, r.roleName);
      nextByRoleId.set(r.roleId, r.nextRoleId);

      if (!map.has(r.roleName)) {
        map.set(r.roleName, {
          roleName: r.roleName,
          unitName: r.unitName || r.roleName.split('_')[0] || UNGROUPED_LABEL,
          records: [],
        });
      }
      map.get(r.roleName).records.push(r);
    }

    const groups = [...map.values()].map((g) => ({
      ...g,
      // 同名記錄的 role_id 取第一筆作為「被指向」時的代表值（與 03 的下拉一致）
      roleId: g.records[0].roleId,
      endCount: g.records.filter((r) => r.isChainEnd).length,
      // 目前的下一關（同名記錄若設得不一致，全部列出來讓 HR 看到）
      nextNames: [...new Set(g.records.map((r) =>
        r.isChainEnd ? '（終點）' : (nameByRoleId.get(r.nextRoleId) || (r.nextRoleId ? `未知：${r.nextRoleId}` : '（未設定）'))))],
    })).sort((a, b) =>
      a.unitName.localeCompare(b.unitName, 'zh-Hant') ||
      a.roleName.localeCompare(b.roleName, 'zh-Hant'));

    return { groups, nameByRoleId, nextByRoleId };
  };

  /**
   * 迴圈偵測：從 targetRoleId 沿 next_role_id 往下走，看會不會走回任一來源角色
   *
   * 走訪時用「即將套用後」的視角：來源角色的下一關都改成 target，
   * 所以只要目標的下游碰到任何來源，就會形成迴圈。
   *
   * @param {string} targetRoleId
   * @param {Set<string>} sourceRoleNames - 來源角色名稱集合
   * @returns {{cycle: boolean, path: string[]}}
   */
  const detectCycle = (targetRoleId, sourceRoleNames, nameByRoleId, nextByRoleId) => {
    const path = [];
    let cur = targetRoleId;

    for (let i = 0; i < CONFIG.MAX_WALK && cur; i++) {
      const name = nameByRoleId.get(cur);
      if (!name) break;                       // 指向不存在／已停用的角色，交給既有檢查工具處理
      path.push(name);
      if (sourceRoleNames.has(name)) return { cycle: true, path };
      cur = nextByRoleId.get(cur) || '';
    }
    return { cycle: false, path };
  };

  // ═══════════════════════════════════════════════════════════════════
  // 寫入
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 批次寫入 next_role_id
   * 原本標記為終點的記錄一併取消 is_chain_end，避免「有下一關又是終點」的矛盾狀態
   */
  const applyNextRole = async (records, targetRoleId) => {
    const updates = records.map((r) => {
      const record = { [RF.NEXT_ROLE_ID]: { value: targetRoleId } };
      if (r.isChainEnd) record[RF.IS_CHAIN_END] = { value: [] };
      return { id: r.recordId, record };
    });
    for (const part of chunk(updates, CONFIG.WRITE_BATCH)) {
      await kintoneApi('/k/v1/records.json', 'PUT', { app: APP_ID.ROLE_DEFINITION, records: part });
    }
    return updates.length;
  };

  // ═══════════════════════════════════════════════════════════════════
  // UI
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 可打字搜尋的角色選擇器（與 05-coverage-check 同一套互動：過濾 + ↑↓ + Enter）
   * @param {Array} groups - buildGroups 的結果
   * @param {Function} onChange
   */
  const buildRoleCombo = (groups, onChange) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative; display:inline-block;';

    const input = document.createElement('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.placeholder = `輸入關鍵字搜尋角色…（共 ${groups.length} 個）`;
    input.style.cssText =
      'font-size:14px; padding:8px 10px; min-width:320px; box-sizing:border-box; ' +
      'border:1px solid #ccc; border-radius:6px;';

    const panel = document.createElement('div');
    panel.style.cssText =
      'position:absolute; bottom:calc(100% + 4px); left:0; min-width:360px; max-height:300px; ' +
      'overflow-y:auto; background:#fff; border:1px solid #ccc; border-radius:6px; ' +
      'box-shadow:0 4px 16px rgba(0,0,0,.18); z-index:10; display:none;';

    let selected = null;
    let matches = [];
    let active = -1;

    const highlight = (label, kw) => {
      const i = kw ? label.toLowerCase().indexOf(kw.toLowerCase()) : -1;
      if (i < 0) return esc(label);
      return esc(label.slice(0, i)) +
        `<strong style="color:#1a6ea8;">${esc(label.slice(i, i + kw.length))}</strong>` +
        esc(label.slice(i + kw.length));
    };

    const paint = (keyboard = false) => {
      for (const el of panel.querySelectorAll('[data-idx]')) {
        const on = Number(el.dataset.idx) === active;
        el.style.background = on ? '#e0e7ff' : '';
        el.style.fontWeight = on ? '600' : '400';
        if (on && keyboard) el.scrollIntoView({ block: 'nearest' });
      }
    };

    const renderPanel = (keyword) => {
      const kw = keyword.trim();
      const k = kw.toLowerCase();
      matches = k
        ? groups.filter((g) => g.roleName.toLowerCase().includes(k) || g.unitName.toLowerCase().includes(k))
        : groups;
      active = matches.findIndex((g) => g.roleName === selected?.roleName);

      panel.innerHTML = '';
      if (!matches.length) {
        panel.innerHTML = '<div style="padding:12px; color:#999; font-size:14px;">找不到符合的角色</div>';
        return;
      }

      let unit = null;
      matches.forEach((g, idx) => {
        if (g.unitName !== unit) {
          unit = g.unitName;
          const header = document.createElement('div');
          header.textContent = unit;
          header.style.cssText =
            'padding:6px 12px; font-size:12px; font-weight:700; color:#555; ' +
            'background:#f5f5f5; position:sticky; top:0; z-index:1;';
          panel.appendChild(header);
        }
        const item = document.createElement('div');
        item.dataset.idx = String(idx);
        item.innerHTML = highlight(g.roleName, kw) +
          (g.records.length > 1 ? `<span style="color:#888; font-size:12px;">（${g.records.length} 筆）</span>` : '');
        item.style.cssText = 'padding:8px 12px 8px 20px; font-size:14px; cursor:pointer;';
        item.addEventListener('mousedown', (e) => { e.preventDefault(); choose(idx); });
        item.addEventListener('mouseenter', () => { active = idx; paint(); });
        panel.appendChild(item);
      });
      paint();
    };

    const open = (kw) => { renderPanel(kw); panel.style.display = 'block'; };
    const close = () => { panel.style.display = 'none'; };

    const choose = (idx) => {
      const g = matches[idx];
      if (!g) return;
      selected = g;
      input.value = g.roleName;
      close();
      onChange();
    };

    input.addEventListener('focus', () => { input.select(); open(''); });
    input.addEventListener('input', () => {
      if (selected && input.value !== selected.roleName) { selected = null; onChange(); }
      open(input.value);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (panel.style.display === 'none') open(input.value);
        if (!matches.length) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
        paint(true);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (panel.style.display !== 'none' && active >= 0) choose(active);
      } else if (e.key === 'Escape') {
        close();
        input.value = selected?.roleName || '';
      }
    });
    input.addEventListener('blur', () => {
      setTimeout(() => { close(); input.value = selected?.roleName || ''; }, 200);
    });

    wrap.append(input, panel);
    return { el: wrap, get: () => selected };
  };

  const showPanel = (model, reload) => {
    document.getElementById(CONFIG.OVERLAY_ID)?.remove();

    const { groups, nameByRoleId, nextByRoleId } = model;

    const overlay = document.createElement('div');
    overlay.id = CONFIG.OVERLAY_ID;
    overlay.style.cssText =
      'position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:1050; display:flex; align-items:center; justify-content:center;';

    const panel = document.createElement('div');
    panel.style.cssText =
      'background:#fff; border-radius:10px; width:min(1000px, 95vw); height:min(730px, 92vh); ' +
      'display:flex; flex-direction:column; padding:20px 24px; box-shadow:0 8px 40px rgba(0,0,0,.25);';

    panel.innerHTML = `
      <div style="display:flex; align-items:center; margin-bottom:6px;">
        <h2 style="font-size:18px; margin:0;">批次設定下一關角色</h2>
        <span style="font-size:13px; color:#666; margin-left:12px;">
          啟用中角色共 ${groups.length} 個關卡（同名角色算同一關）
        </span>
        <button data-role="close" style="margin-left:auto; font-size:20px; border:none; background:none; cursor:pointer;">✕</button>
      </div>

      <div style="display:flex; gap:12px; align-items:center; margin:10px 0; flex-wrap:wrap;">
        <label style="font-size:14px;">單位：
          <select data-role="unit" style="font-size:14px; padding:6px;"></select>
        </label>
        <input data-role="search" type="text" placeholder="搜尋角色名稱…"
               style="font-size:14px; padding:6px 10px; border:1px solid #ccc; border-radius:4px; min-width:220px;">
        <label style="font-size:14px;"><input type="checkbox" data-role="check-all"> 全選（目前篩選結果）</label>
        <span data-role="count" style="font-size:13px; color:#666;"></span>
      </div>

      <div data-role="list" style="flex:1; overflow-y:auto; border:1px solid #e0e0e0; border-radius:6px;">
        <table style="width:100%; border-collapse:collapse; font-size:14px;">
          <thead>
            <tr style="background:#f5f5f5; position:sticky; top:0;">
              <th style="padding:8px; width:36px;"></th>
              <th style="padding:8px; text-align:left;">角色名稱</th>
              <th style="padding:8px; text-align:left; width:90px;">記錄筆數</th>
              <th style="padding:8px; text-align:left;">目前的下一關</th>
              <th style="padding:8px; text-align:left;">單位</th>
            </tr>
          </thead>
          <tbody data-role="tbody"></tbody>
        </table>
      </div>

      <div style="display:flex; gap:12px; align-items:center; margin-top:12px; flex-wrap:wrap;">
        <span style="font-size:14px; font-weight:700;">下一關設為：</span>
        <span data-role="combo-slot"></span>
        <button data-role="apply"
          style="font-size:15px; padding:10px 24px; background:#2980b9; color:#fff; border:none; border-radius:6px; cursor:pointer;">
          套用
        </button>
        <span data-role="hint" style="font-size:13px; color:#888;"></span>
      </div>
    `;

    const tbody     = panel.querySelector('[data-role="tbody"]');
    const unitSel   = panel.querySelector('[data-role="unit"]');
    const searchEl  = panel.querySelector('[data-role="search"]');
    const checkAll  = panel.querySelector('[data-role="check-all"]');
    const countEl   = panel.querySelector('[data-role="count"]');
    const applyBtn  = panel.querySelector('[data-role="apply"]');
    const hintEl    = panel.querySelector('[data-role="hint"]');

    panel.querySelector('[data-role="close"]').addEventListener('click', () => overlay.remove());

    const units = [...new Set(groups.map((g) => g.unitName))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    unitSel.innerHTML = `<option value="">全部（${groups.length}）</option>` +
      units.map((u) => `<option value="${esc(u)}">${esc(u)}</option>`).join('');

    const checked = new Set();   // 已勾選的 roleName
    let visible = groups;

    const updateCount = () => {
      countEl.textContent = `顯示 ${visible.length} 個關卡／已勾選 ${checked.size} 個`;
      const target = combo.get();
      applyBtn.disabled = checked.size === 0 || !target;
      applyBtn.style.opacity = applyBtn.disabled ? '0.5' : '1';

      // 即時提示：目標若在勾選清單裡，就是自我循環
      hintEl.textContent = target && checked.has(target.roleName)
        ? '⚠ 下一關不能是自己'
        : (checked.size ? `將更新 ${totalRecords()} 筆記錄` : '');
      hintEl.style.color = target && checked.has(target.roleName) ? '#c0392b' : '#888';
    };

    const totalRecords = () =>
      groups.filter((g) => checked.has(g.roleName))
            .reduce((sum, g) => sum + g.records.length, 0);

    const render = () => {
      const unit = unitSel.value;
      const kw = searchEl.value.trim();
      visible = groups.filter((g) =>
        (!unit || g.unitName === unit) &&
        (!kw || g.roleName.includes(kw)));

      tbody.innerHTML = visible.map((g) => `
        <tr style="border-top:1px solid #eee;">
          <td style="padding:6px 8px; text-align:center;">
            <input type="checkbox" data-name="${esc(g.roleName)}" ${checked.has(g.roleName) ? 'checked' : ''}>
          </td>
          <td style="padding:6px 8px; font-weight:600;">${esc(g.roleName)}</td>
          <td style="padding:6px 8px; color:#666;">
            ${g.records.length}${g.endCount ? `<br><span style="color:#b45309; font-size:12px;">終點 ${g.endCount}</span>` : ''}
          </td>
          <td style="padding:6px 8px; ${g.nextNames.length > 1 ? 'color:#c0392b;' : 'color:#555;'}">
            ${esc(g.nextNames.join('、'))}${g.nextNames.length > 1 ? '<br><span style="font-size:12px;">（同名記錄設定不一致）</span>' : ''}
          </td>
          <td style="padding:6px 8px; color:#666;">${esc(g.unitName)}</td>
        </tr>`).join('') ||
        '<tr><td colspan="5" style="padding:16px; color:#999; text-align:center;">沒有符合的角色</td></tr>';
      updateCount();
    };

    tbody.addEventListener('change', (e) => {
      const name = e.target.dataset?.name;
      if (!name) return;
      e.target.checked ? checked.add(name) : checked.delete(name);
      updateCount();
    });
    unitSel.addEventListener('change', render);
    searchEl.addEventListener('input', render);
    checkAll.addEventListener('change', (e) => {
      visible.forEach((g) => e.target.checked ? checked.add(g.roleName) : checked.delete(g.roleName));
      render();
    });

    const combo = buildRoleCombo(groups, updateCount);
    panel.querySelector('[data-role="combo-slot"]').appendChild(combo.el);

    applyBtn.addEventListener('click', async () => {
      const target = combo.get();
      const sources = groups.filter((g) => checked.has(g.roleName));
      if (!target || !sources.length) return;

      // ① 自我循環
      if (checked.has(target.roleName)) {
        await showWarning('下一關不能是自己', `請取消勾選「${target.roleName}」，或改選其他目標角色。`);
        return;
      }

      // ② 迴圈偵測
      const { cycle, path } = detectCycle(target.roleId, checked, nameByRoleId, nextByRoleId);
      if (cycle) {
        await Swal.fire({
          icon: 'error',
          title: '會形成迴圈，已擋下',
          html:
            `<div style="text-align:left;">從「${esc(target.roleName)}」往下走會回到你勾選的角色：<br><br>` +
            `<code style="font-size:13px;">${esc(path.join(' → '))}</code><br><br>` +
            `請先調整這條路徑上的設定，或改選其他目標。</div>`,
          confirmButtonText: '我知道了',
        });
        return;
      }

      // ③ 終點衝突
      const endSources = sources.filter((g) => g.endCount > 0);
      const endHtml = endSources.length
        ? `<div style="color:#b45309; margin-top:10px;">
             以下角色原本標記為「是終點」，設定下一關後將<strong>一併取消終點標記</strong>：<br>
             ${esc(endSources.map((g) => `${g.roleName}（${g.endCount} 筆）`).join('、'))}
           </div>`
        : '';

      const records = sources.flatMap((g) => g.records);
      const ok = (await Swal.fire({
        icon: 'question',
        title: `把 ${sources.length} 個關卡的下一關設為「${target.roleName}」？`,
        html:
          `<div style="text-align:left;">` +
          `來源角色：${esc(sources.map((g) => g.roleName).join('、'))}<br>` +
          `共會更新 <strong>${records.length}</strong> 筆記錄（含同名角色的每一筆）。` +
          `</div>${endHtml}`,
        width: '640px',
        showCancelButton: true, confirmButtonText: '確定套用', cancelButtonText: '取消',
      })).isConfirmed;
      if (!ok) return;

      Swal.fire({ title: '寫入中…', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      const n = await applyNextRole(records, target.roleId);
      await Swal.fire({ icon: 'success', title: `已更新 ${n} 筆記錄`, timer: 1800, showConfirmButton: false });
      reload();   // 重新載入，讓「目前的下一關」欄反映最新結果
    });

    render();
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  };

  // ═══════════════════════════════════════════════════════════════════
  // 進入點
  // ═══════════════════════════════════════════════════════════════════

  const runTool = async () => {
    Swal.fire({
      title: '載入角色中…',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading(),
    });
    const roles = await fetchActiveRoles();
    const model = buildGroups(roles);
    Swal.close();
    showPanel(model, runTool);
  };

  kintone.events.on(['app.record.index.show'], safeHandler(async (event) => {
    if (document.getElementById(CONFIG.BTN_ID)) return event;

    const btn = document.createElement('button');
    btn.id = CONFIG.BTN_ID;
    btn.textContent = '批次設定下一關';
    btn.style.cssText =
      'font-size:14px; padding:8px 20px; margin-left:8px; background:#e67e22; color:#fff; border:none; border-radius:4px; cursor:pointer;';
    btn.addEventListener('click', async () => {
      try {
        await runTool();
      } catch (err) {
        console.error('[ApprovalRouting] 批次設定下一關錯誤', err);
        Swal.close();
        await showWarning('操作失敗', err.message);
      }
    });

    const headerSpace = kintone.app.getHeaderMenuSpaceElement?.() ||
                        document.querySelector('.gaia-argoui-app-index-toolbar');
    if (headerSpace) headerSpace.appendChild(btn);
    return event;
  }));
})();
