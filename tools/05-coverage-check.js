/**
 * 涵蓋率檢查工具 — 找出「使用中但尚未納入簽核系統」的使用者，並可就地補設定
 *
 * 在角色定義表（685）或員工起點對照表（686）的列表頁加入「未設定名單」按鈕，
 * 掃描後以報告呈現兩類缺口，並提供快速補設定：
 *   A. 未設定起點 — 使用中、但 686 沒有起點記錄的人（無法送單，最優先處理）
 *        → 勾選多人 + 選一個起點角色 → 批量建立 686 記錄
 *   B. 不具簽核身分 — 使用中、但不在任何角色的 holder_user、也不在任何簽核群組的人
 *        → 勾選多人 + 選一個「指定個人」角色 → 批量加入該角色的 holder_user
 *          （同名角色視為同一關卡，會一併寫入所有同名記錄，維持一致性；
 *            群組型角色的成員仍由 IT 在 cybozu 後台維護，本工具不碰）
 *
 * 【影響的欄位】
 *   - 686 employee / entry_role_id / is_active：A 區批量建立寫入
 *   - 685 holder_user：B 區快速指派以「附加」方式寫入（不覆蓋既有簽核者）
 *
 * 【依賴】
 *   - core/01-config.js（Config）
 *   - core/04-utils.js（Utils）
 *   - User API：/v1/users、/v1/organizations、/v1/organization/users、/v1/group/users
 *     （路徑不帶 /k、直接傳給 kintone.api，與 04-chain-preview 實測可行的方式一致）
 *
 * 【變更履歷】
 *   2026-07-12  Jimmy/Claude  初版建立
 */
(() => {
  'use strict';

  const { APP_ID, ROLE_FIELDS: RF, ENTRY_FIELDS: EF, CHECKBOX, HOLDER_TYPE_OPTIONS: HT } =
    window.ApprovalRouting.Config;
  const { safeHandler, kintoneApi, showWarning } = window.ApprovalRouting.Utils;

  const CONFIG = Object.freeze({
    BTN_ID:      'ar-coverage-check-btn',
    OVERLAY_ID:  'ar-coverage-overlay',
    USER_PAGE:   100,   // User API 分頁大小上限
    RECORD_PAGE: 500,   // records API 單次上限
    WRITE_BATCH: 100,   // records 批量寫入上限
    ORG_PARALLEL: 10,   // 組織成員查詢的並行數（控制瞬間 API 量）
  });

  const UNGROUPED_LABEL = '（未分類）';

  // ═══════════════════════════════════════════════════════════════════
  // 資料讀取
  // ═══════════════════════════════════════════════════════════════════

  /** 陣列切批 */
  const chunk = (arr, size) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };

  /**
   * User API 通用分頁撈全量（offset + size 迴圈直到不足一頁）
   * @param {string} path - 如 '/v1/users'
   * @param {Object} params - 額外參數（code 等）
   * @param {Function} pluck - 從單頁回應取出項目陣列
   * @returns {Promise<Array>}
   */
  const fetchUserApiAll = async (path, params, pluck) => {
    const all = [];
    let offset = 0;
    while (true) {
      const resp = await kintone.api(path, 'GET', { ...params, offset, size: CONFIG.USER_PAGE });
      const items = pluck(resp) || [];
      all.push(...items);
      if (items.length < CONFIG.USER_PAGE) break;
      offset += CONFIG.USER_PAGE;
    }
    return all;
  };

  /** kintone records 通用分頁撈全量（offset 適用：兩表資料量在數百～千級） */
  const fetchRecordsAll = async (app, fields, condition) => {
    const all = [];
    let offset = 0;
    while (true) {
      const resp = await kintoneApi('/k/v1/records', 'GET', {
        app,
        fields,
        query: `${condition} limit ${CONFIG.RECORD_PAGE} offset ${offset}`,
      });
      all.push(...resp.records);
      if (resp.records.length < CONFIG.RECORD_PAGE) break;
      offset += CONFIG.RECORD_PAGE;
    }
    return all;
  };

  /** 全公司「使用狀態＝使用中」的使用者（排除已停止的帳號） */
  const fetchActiveUsers = async () => {
    const users = await fetchUserApiAll('/v1/users', {}, (r) => r.users);
    return users
      .filter((u) => u.valid !== false)
      .map((u) => ({ code: u.code, name: u.name || u.code }));
  };

  /**
   * 建立 使用者帳號 → 所屬單位名稱清單 的對照
   * 作法：撈全部組織 → 逐組織撈成員（並行分批），一人可屬多個組織
   * @returns {Promise<Map<string, string[]>>}
   */
  const fetchUserOrgMap = async () => {
    const orgs = await fetchUserApiAll('/v1/organizations', {}, (r) => r.organizations);
    const map = new Map();

    for (const part of chunk(orgs, CONFIG.ORG_PARALLEL)) {
      await Promise.all(part.map(async (org) => {
        // 回應格式為 { userTitles: [{ user, title }] }，保守起見也相容 users 形式
        const members = await fetchUserApiAll(
          '/v1/organization/users',
          { code: org.code },
          (r) => (r.userTitles ? r.userTitles.map((t) => t.user) : r.users),
        );
        for (const u of members) {
          if (!u?.code) continue;
          if (!map.has(u.code)) map.set(u.code, []);
          map.get(u.code).push(org.name);
        }
      }));
    }
    return map;
  };

  /**
   * 685 啟用角色的簽核者資料
   * @returns {Promise<{holderCodes: Set<string>, roles: Array}>}
   *   holderCodes：具簽核身分的帳號集合（holder_user ∪ 各群組成員）
   *   roles：啟用角色清單（含 recordId 與現有 holder_user，供 B 區快速指派）
   */
  const fetchRoleCoverage = async () => {
    const records = await fetchRecordsAll(
      APP_ID.ROLE_DEFINITION,
      ['$id', RF.ROLE_ID, RF.ROLE_NAME, RF.HOLDER_TYPE, RF.HOLDER_USER, RF.HOLDER_GROUP],
      `${RF.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}")`,
    );

    const holderCodes = new Set();
    const groupCodes = new Set();
    const roles = [];

    for (const rec of records) {
      const holderType = rec[RF.HOLDER_TYPE]?.value || '';
      const holderUsers = (rec[RF.HOLDER_USER]?.value || []).map((u) => u.code);
      holderUsers.forEach((c) => holderCodes.add(c));
      (rec[RF.HOLDER_GROUP]?.value || []).forEach((g) => groupCodes.add(g.code));

      roles.push({
        recordId: rec.$id.value,
        roleId: rec[RF.ROLE_ID]?.value || '',
        roleName: rec[RF.ROLE_NAME]?.value || '',
        holderType,
        holderUsers,
      });
    }

    // 展開所有簽核群組的成員（並行，群組數量級：數十）
    for (const part of chunk([...groupCodes], CONFIG.ORG_PARALLEL)) {
      await Promise.all(part.map(async (code) => {
        const members = await fetchUserApiAll('/v1/group/users', { code }, (r) => r.users);
        members.forEach((u) => { if (u?.code) holderCodes.add(u.code); });
      }));
    }

    return { holderCodes, roles };
  };

  /** 686 已設定起點的帳號集合（僅計啟用中記錄） */
  const fetchEmployeeCodes = async () => {
    const records = await fetchRecordsAll(
      APP_ID.EMPLOYEE_ENTRY,
      [EF.EMPLOYEE],
      `${EF.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}")`,
    );
    const codes = new Set();
    for (const rec of records) {
      for (const u of rec[EF.EMPLOYEE]?.value || []) codes.add(u.code);
    }
    return codes;
  };

  /** 主掃描：組出報告資料模型 */
  const runScan = async () => {
    const [users, orgMap, roleCoverage, employeeCodes] = await Promise.all([
      fetchActiveUsers(),
      fetchUserOrgMap(),
      fetchRoleCoverage(),
      fetchEmployeeCodes(),
    ]);

    const decorate = (u) => ({
      ...u,
      units: orgMap.get(u.code) || [UNGROUPED_LABEL],
    });

    return {
      totalActive: users.length,
      noEntry:  users.filter((u) => !employeeCodes.has(u.code)).map(decorate),
      noHolder: users.filter((u) => !roleCoverage.holderCodes.has(u.code)).map(decorate),
      roles: roleCoverage.roles,
    };
  };

  // ═══════════════════════════════════════════════════════════════════
  // 寫入動作
  // ═══════════════════════════════════════════════════════════════════

  /** A 區：批量建立 686 起點記錄 */
  const createEntries = async (userCodes, roleId) => {
    for (const part of chunk(userCodes, CONFIG.WRITE_BATCH)) {
      await kintoneApi('/k/v1/records', 'POST', {
        app: APP_ID.EMPLOYEE_ENTRY,
        records: part.map((code) => ({
          [EF.EMPLOYEE]:      { value: [{ code }] },
          [EF.ENTRY_ROLE_ID]: { value: roleId },
          [EF.IS_ACTIVE]:     { value: [CHECKBOX.ACTIVE] },
        })),
      });
    }
  };

  /**
   * B 區：把使用者「附加」到指定角色名稱的 holder_user
   * 同名角色視為同一關卡，一併更新所有同名的「指定個人」記錄，維持一致性
   */
  const assignHolders = async (userCodes, roleName, roles) => {
    const targets = roles.filter(
      (r) => r.roleName === roleName && r.holderType === HT.USER,
    );
    const updates = targets.map((r) => ({
      id: r.recordId,
      record: {
        [RF.HOLDER_USER]: {
          // 既有成員 + 新成員去重後附加，不覆蓋原設定
          value: [...new Set([...r.holderUsers, ...userCodes])].map((code) => ({ code })),
        },
      },
    }));

    for (const part of chunk(updates, CONFIG.WRITE_BATCH)) {
      await kintoneApi('/k/v1/records', 'PUT', {
        app: APP_ID.ROLE_DEFINITION,
        records: part,
      });
    }
    return targets.length;
  };

  // ═══════════════════════════════════════════════════════════════════
  // 報告 UI（自訂全螢幕覆蓋層；確認與結果用 SweetAlert）
  // ═══════════════════════════════════════════════════════════════════

  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /** 匯出目前清單為 CSV（含 BOM 讓 Excel 正確顯示中文） */
  const exportCsv = (rows, filename) => {
    const lines = ['帳號,姓名,單位',
      ...rows.map((u) => `"${u.code}","${u.name}","${u.units.join('、')}"`)];
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  /**
   * 渲染單一分頁（A 或 B 共用）：工具列（單位篩選 + 搜尋 + 全選）、
   * 人員表格、底部動作列（角色選擇 + 執行按鈕 + 匯出 CSV）
   */
  const buildTab = ({ key, users, roleOptions, actionLabel, onAction, onExport }) => {
    const root = document.createElement('div');

    // ── 工具列 ──
    const unitSet = [...new Set(users.flatMap((u) => u.units))].sort();
    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'display:flex; gap:12px; align-items:center; margin-bottom:10px; flex-wrap:wrap;';
    toolbar.innerHTML = `
      <label style="font-size:14px;">單位：
        <select data-role="unit" style="font-size:14px; padding:6px;">
          <option value="">全部（${users.length} 人）</option>
          ${unitSet.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
        </select>
      </label>
      <input data-role="search" type="text" placeholder="搜尋姓名或帳號…"
             style="font-size:14px; padding:6px 10px; border:1px solid #ccc; border-radius:4px; min-width:200px;">
      <label style="font-size:14px;"><input type="checkbox" data-role="check-all"> 全選（目前篩選結果）</label>
      <span data-role="count" style="font-size:13px; color:#666;"></span>
    `;

    // ── 表格 ──
    const listWrap = document.createElement('div');
    listWrap.style.cssText = 'flex:1; overflow-y:auto; border:1px solid #e0e0e0; border-radius:6px;';
    const table = document.createElement('table');
    table.style.cssText = 'width:100%; border-collapse:collapse; font-size:14px;';
    table.innerHTML = `
      <thead>
        <tr style="background:#f5f5f5; position:sticky; top:0;">
          <th style="padding:8px; width:36px;"></th>
          <th style="padding:8px; text-align:left;">姓名</th>
          <th style="padding:8px; text-align:left;">帳號</th>
          <th style="padding:8px; text-align:left;">單位</th>
        </tr>
      </thead>
      <tbody></tbody>`;
    listWrap.appendChild(table);
    const tbody = table.querySelector('tbody');

    const checked = new Set();   // 已勾選帳號（跨篩選保留）
    let visible = users;

    const renderRows = () => {
      const unit = toolbar.querySelector('[data-role="unit"]').value;
      const kw = toolbar.querySelector('[data-role="search"]').value.trim();
      visible = users.filter((u) =>
        (!unit || u.units.includes(unit)) &&
        (!kw || u.name.includes(kw) || u.code.includes(kw)));

      tbody.innerHTML = visible.map((u) => `
        <tr style="border-top:1px solid #eee;">
          <td style="padding:6px 8px; text-align:center;">
            <input type="checkbox" data-code="${esc(u.code)}" ${checked.has(u.code) ? 'checked' : ''}>
          </td>
          <td style="padding:6px 8px;">${esc(u.name)}</td>
          <td style="padding:6px 8px; color:#666;">${esc(u.code)}</td>
          <td style="padding:6px 8px;">${esc(u.units.join('、'))}</td>
        </tr>`).join('') ||
        '<tr><td colspan="4" style="padding:16px; color:#999; text-align:center;">沒有符合的人員</td></tr>';
      updateCount();
    };

    const updateCount = () => {
      toolbar.querySelector('[data-role="count"]').textContent =
        `顯示 ${visible.length} 人／已勾選 ${checked.size} 人`;
      actionBtn.disabled = checked.size === 0 || !roleSelect.value;
      actionBtn.style.opacity = actionBtn.disabled ? '0.5' : '1';
    };

    tbody.addEventListener('change', (e) => {
      const code = e.target.dataset?.code;
      if (!code) return;
      e.target.checked ? checked.add(code) : checked.delete(code);
      updateCount();
    });
    toolbar.querySelector('[data-role="unit"]').addEventListener('change', renderRows);
    toolbar.querySelector('[data-role="search"]').addEventListener('input', renderRows);
    toolbar.querySelector('[data-role="check-all"]').addEventListener('change', (e) => {
      visible.forEach((u) => e.target.checked ? checked.add(u.code) : checked.delete(u.code));
      renderRows();
    });

    // ── 底部動作列 ──
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex; gap:12px; align-items:center; margin-top:12px; flex-wrap:wrap;';

    const roleSelect = document.createElement('select');
    roleSelect.style.cssText = 'font-size:14px; padding:8px; min-width:240px;';
    roleSelect.innerHTML = `<option value="">— 選擇角色 —</option>` +
      roleOptions.map((g) => `
        <optgroup label="${esc(g.unit)}">
          ${g.items.map((r) => `<option value="${esc(r.value)}">${esc(r.label)}</option>`).join('')}
        </optgroup>`).join('');
    roleSelect.addEventListener('change', updateCount);

    const actionBtn = document.createElement('button');
    actionBtn.textContent = actionLabel;
    actionBtn.style.cssText =
      'font-size:15px; padding:10px 24px; background:#3498db; color:#fff; border:none; border-radius:6px; cursor:pointer;';
    actionBtn.addEventListener('click', () =>
      onAction([...checked], roleSelect.value, roleSelect.selectedOptions[0]?.textContent || ''));

    const exportBtn = document.createElement('button');
    exportBtn.textContent = '匯出 CSV';
    exportBtn.style.cssText =
      'font-size:14px; padding:10px 18px; background:#fff; color:#333; border:1px solid #ccc; border-radius:6px; cursor:pointer; margin-left:auto;';
    exportBtn.addEventListener('click', () => onExport(visible));

    footer.append(roleSelect, actionBtn, exportBtn);
    root.style.cssText = 'display:flex; flex-direction:column; height:100%;';
    root.append(toolbar, listWrap, footer);
    root.dataset.tab = key;
    renderRows();
    return root;
  };

  /** 由角色清單組出下拉選項（依單位分組、同名去重；filter 可再限縮類型） */
  const buildRoleOptions = (roles, { userTypeOnly = false, valueBy = 'roleId' } = {}) => {
    const seen = new Set();
    const groups = new Map();
    for (const r of roles) {
      if (userTypeOnly && r.holderType !== HT.USER) continue;
      if (seen.has(r.roleName)) continue;
      seen.add(r.roleName);
      const unit = r.roleName.split('_')[0] || UNGROUPED_LABEL;
      if (!groups.has(unit)) groups.set(unit, []);
      groups.get(unit).push({
        value: valueBy === 'roleId' ? r.roleId : r.roleName,
        label: r.roleName,
      });
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b, 'zh-Hant'))
      .map(([unit, items]) => ({ unit, items }));
  };

  /** 顯示報告覆蓋層 */
  const showReport = (model, rescan) => {
    document.getElementById(CONFIG.OVERLAY_ID)?.remove();

    const overlay = document.createElement('div');
    overlay.id = CONFIG.OVERLAY_ID;
    overlay.style.cssText =
      // z-index 必須低於 SweetAlert2 的 1060，確認/結果視窗才能疊在報告上方
      'position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:1050; display:flex; align-items:center; justify-content:center;';

    const panel = document.createElement('div');
    panel.style.cssText =
      'background:#fff; border-radius:10px; width:min(960px, 94vw); height:min(720px, 92vh); ' +
      'display:flex; flex-direction:column; padding:20px 24px; box-shadow:0 8px 40px rgba(0,0,0,.25);';

    panel.innerHTML = `
      <div style="display:flex; align-items:center; margin-bottom:4px;">
        <h2 style="font-size:18px; margin:0;">簽核系統涵蓋率檢查</h2>
        <span style="font-size:13px; color:#666; margin-left:12px;">使用中帳號共 ${model.totalActive} 人</span>
        <button data-role="close" style="margin-left:auto; font-size:20px; border:none; background:none; cursor:pointer;">✕</button>
      </div>
      <div data-role="tabs" style="display:flex; gap:8px; margin:10px 0;"></div>
      <div data-role="body" style="flex:1; overflow:hidden;"></div>
    `;

    const tabsEl = panel.querySelector('[data-role="tabs"]');
    const bodyEl = panel.querySelector('[data-role="body"]');
    panel.querySelector('[data-role="close"]').addEventListener('click', () => overlay.remove());

    // ── A 分頁：未設定起點 ──
    const tabA = buildTab({
      key: 'A',
      users: model.noEntry,
      roleOptions: buildRoleOptions(model.roles, { valueBy: 'roleId' }),
      actionLabel: '建立起點設定',
      onAction: async (codes, roleId, roleLabel) => {
        if (!codes.length || !roleId) return;
        const ok = (await Swal.fire({
          icon: 'question',
          title: `建立 ${codes.length} 筆起點設定？`,
          html: `起點角色：<strong>${esc(roleLabel)}</strong><br>對象：${codes.length} 人`,
          showCancelButton: true, confirmButtonText: '確定建立', cancelButtonText: '取消',
        })).isConfirmed;
        if (!ok) return;

        Swal.fire({ title: '建立中…', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        await createEntries(codes, roleId);
        await Swal.fire({ icon: 'success', title: `已建立 ${codes.length} 筆起點設定`, timer: 1800, showConfirmButton: false });
        rescan(); // 重新掃描刷新報告
      },
      onExport: (rows) => exportCsv(rows, `未設定起點_${new Date().toISOString().slice(0, 10)}.csv`),
    });

    // ── B 分頁：不具簽核身分 ──
    const tabB = buildTab({
      key: 'B',
      users: model.noHolder,
      roleOptions: buildRoleOptions(model.roles, { userTypeOnly: true, valueBy: 'roleName' }),
      actionLabel: '加入為簽核者',
      onAction: async (codes, roleName, roleLabel) => {
        if (!codes.length || !roleName) return;
        const ok = (await Swal.fire({
          icon: 'question',
          title: `將 ${codes.length} 人加入簽核者？`,
          html: `角色：<strong>${esc(roleLabel)}</strong>（附加到現有簽核者之後，不會移除任何人）`,
          showCancelButton: true, confirmButtonText: '確定加入', cancelButtonText: '取消',
        })).isConfirmed;
        if (!ok) return;

        Swal.fire({ title: '寫入中…', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        const touched = await assignHolders(codes, roleName, model.roles);
        await Swal.fire({
          icon: 'success',
          title: `已將 ${codes.length} 人加入「${roleName}」`,
          text: touched > 1 ? `（同名角色共 ${touched} 筆記錄已同步更新）` : undefined,
          timer: 2200, showConfirmButton: false,
        });
        rescan();
      },
      onExport: (rows) => exportCsv(rows, `不具簽核身分_${new Date().toISOString().slice(0, 10)}.csv`),
    });

    // ── 分頁切換 ──
    const tabs = [
      { key: 'A', label: `A. 未設定起點（${model.noEntry.length} 人）`, el: tabA, hint: '這些人目前無法送單' },
      { key: 'B', label: `B. 不具簽核身分（${model.noHolder.length} 人）`, el: tabB, hint: '多數基層同仁本來就不簽核，此區用於確認主管沒被漏掉' },
    ];
    const switchTo = (key) => {
      bodyEl.innerHTML = '';
      const t = tabs.find((x) => x.key === key);
      bodyEl.appendChild(t.el);
      tabs.forEach((x) => {
        const btn = tabsEl.querySelector(`[data-key="${x.key}"]`);
        btn.style.background = x.key === key ? '#3498db' : '#eee';
        btn.style.color = x.key === key ? '#fff' : '#333';
      });
    };
    tabsEl.innerHTML = tabs.map((t) => `
      <button data-key="${t.key}" title="${esc(t.hint)}"
              style="font-size:14px; padding:8px 18px; border:none; border-radius:6px; cursor:pointer;">
        ${esc(t.label)}
      </button>`).join('');
    tabsEl.addEventListener('click', (e) => {
      if (e.target.dataset?.key) switchTo(e.target.dataset.key);
    });

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    switchTo('A');
  };

  // ═══════════════════════════════════════════════════════════════════
  // 進入點
  // ═══════════════════════════════════════════════════════════════════

  const runTool = async () => {
    Swal.fire({
      title: '掃描中…',
      html: '正在比對全公司使用者與兩張表的設定，約需數秒',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading(),
    });
    const model = await runScan();
    Swal.close();
    showReport(model, runTool);
  };

  kintone.events.on(['app.record.index.show'], safeHandler(async (event) => {
    if (document.getElementById(CONFIG.BTN_ID)) return event;

    const btn = document.createElement('button');
    btn.id = CONFIG.BTN_ID;
    btn.textContent = '未設定名單';
    btn.style.cssText =
      'font-size:14px; padding:8px 20px; margin-left:8px; background:#8e44ad; color:#fff; border:none; border-radius:4px; cursor:pointer;';
    btn.addEventListener('click', async () => {
      try {
        await runTool();
      } catch (err) {
        console.error('[ApprovalRouting] 涵蓋率檢查錯誤', err);
        Swal.close();
        await showWarning('掃描失敗', err.message);
      }
    });

    const headerSpace = kintone.app.getHeaderMenuSpaceElement?.() ||
                        document.querySelector('.gaia-argoui-app-index-toolbar');
    if (headerSpace) headerSpace.appendChild(btn);
    return event;
  }));
})();
