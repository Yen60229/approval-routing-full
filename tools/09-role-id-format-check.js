/**
 * role_id 位數對照與批次修正（kintone App 685 / 686）
 *
 * role_id 的標準格式是 4 碼補零（ROLE_0001，見 docs/02-欄位代碼對照表.md），
 * 但 apps/role-definition/01-role-form-init.js 曾經補 3 碼，因此舊資料混著
 * ROLE_599 與 ROLE_0598 兩種寫法。本工具把「數字不足 4 碼」的代碼，
 * 連同所有引用它的位置一次列出來，供 HR 手動一起改：
 *
 *   ① 685 role_id       — 代碼本體
 *   ② 685 next_role_id  — 指向它的上一關
 *   ③ 686 entry_role_id — 以它為起點的員工
 *
 * 三處必須一起改，只改其中一處會斷鏈。可勾選後一鍵批次修正，也可複製成 TSV 手動處理。
 *
 * 【批次修正的寫入順序】先引用、後本體 —— 兩者之間必然有一小段鏈是斷的，
 *   選這個順序是因為中途失敗還能靠「再掃一次、再按一次」補完：
 *     ① 685 next_role_id  → 改成新代碼
 *     ② 686 entry_role_id → 改成新代碼
 *     ③ 685 role_id       → 最後才改本體
 *   若反過來先改本體，失敗後本體已不是 3 碼、掃描時就不再列入，殘留的引用只能手動修。
 *
 * 另外會檢查兩件事：
 *   - 撞號：補零後的代碼若已經存在，該筆不能改（會違反唯一值），整列標紅且不可勾選
 *   - 位數寫錯造成的斷鏈：引用的代碼在 685 找不到，但補零／去零後找得到 → 可一鍵接回
 *
 * 【影響的欄位】
 *   - 685 role_id       ：批次修正時補零（唯一值欄位，撞號者會被擋下）
 *   - 685 next_role_id  ：跟著改成新代碼
 *   - 686 entry_role_id ：跟著改成新代碼
 *
 * 【依賴】
 *   - core/01-config.js（Config）
 *   - core/04-utils.js（Utils）
 *
 * 【變更履歷】
 *   2026-08-27  Jimmy/Claude  初版建立
 *   2026-08-27  Jimmy/Claude  加上批次補零與斷鏈接回；寫入失敗時明確指出停在哪一階段
 *                             （最常見是對 686 沒有編輯權限），並提示可重掃重跑
 *   2026-08-27  Jimmy/Claude  ② 區可勾選後批次指定要指向的角色（685 next_role_id／686
 *                             entry_role_id），附角色搜尋、迴圈偵測與終點旗標一併取消
 */
(() => {
  'use strict';

  const { APP_ID, ROLE_FIELDS: RF, ENTRY_FIELDS: EF, CHECKBOX, ROLE_ID_PREFIX } =
    window.ApprovalRouting.Config;
  const { safeHandler, kintoneApi, showWarning } = window.ApprovalRouting.Utils;

  const CONFIG = Object.freeze({
    BTN_ID:      'ar-roleid-format-btn',
    OVERLAY_ID:  'ar-roleid-format-overlay',
    RECORD_PAGE: 500,   // records API 單次上限
    WRITE_BATCH: 100,   // records 批量寫入上限
    STD_WIDTH:   4,     // 標準位數
  });

  const MAX_WALK = 50;  // 迴圈偵測最大步數，與 tools/07 同量級

  const chunk = (arr, size) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };

  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const recordUrl = (appId, recordId) =>
    `${location.origin}/k/${appId}/show#record=${recordId}`;

  /** ROLE_ 後面純數字才算合法代碼；回傳數字部分，否則 null */
  const seqOf = (roleId) => {
    if (!roleId.startsWith(ROLE_ID_PREFIX)) return null;
    const digits = roleId.slice(ROLE_ID_PREFIX.length);
    return /^\d+$/.test(digits) ? digits : null;
  };

  /** 位數不足標準寬度 → 需要補零 */
  const isShort = (roleId) => {
    const digits = seqOf(roleId);
    return digits !== null && digits.length < CONFIG.STD_WIDTH;
  };

  /** 補成標準寬度；非法代碼原樣回傳 */
  const toStandard = (roleId) => {
    const digits = seqOf(roleId);
    return digits === null
      ? roleId
      : ROLE_ID_PREFIX + digits.padStart(CONFIG.STD_WIDTH, '0');
  };

  // ═══════════════════════════════════════════════════════════════════
  // 資料讀取（含停用記錄：停用的引用之後被啟用一樣會斷）
  // ═══════════════════════════════════════════════════════════════════

  const fetchAll = async (app, fields) => {
    const all = [];
    let offset = 0;
    for (;;) {
      const resp = await kintoneApi('/k/v1/records', 'GET', {
        app,
        fields,
        query: `order by $id asc limit ${CONFIG.RECORD_PAGE} offset ${offset}`,
      });
      all.push(...resp.records);
      if (resp.records.length < CONFIG.RECORD_PAGE) break;
      offset += CONFIG.RECORD_PAGE;
    }
    return all;
  };

  const isActive = (rec, field) =>
    (rec[field]?.value ?? []).includes(CHECKBOX.ACTIVE);

  const loadData = async () => {
    const [roleRecords, entryRecords] = await Promise.all([
      fetchAll(APP_ID.ROLE_DEFINITION, ['$id', RF.ROLE_ID, RF.ROLE_NAME, RF.NEXT_ROLE_ID, RF.IS_CHAIN_END, RF.IS_ACTIVE]),
      fetchAll(APP_ID.EMPLOYEE_ENTRY, ['$id', EF.EMPLOYEE, EF.ENTRY_ROLE_ID, EF.IS_ACTIVE]),
    ]);

    const roles = roleRecords.map((rec) => ({
      recordId:   rec.$id.value,
      roleId:     rec[RF.ROLE_ID]?.value || '',
      roleName:   rec[RF.ROLE_NAME]?.value || '',
      nextRoleId: rec[RF.NEXT_ROLE_ID]?.value || '',
      isChainEnd: (rec[RF.IS_CHAIN_END]?.value ?? []).includes(CHECKBOX.CHAIN_END),
      active:     isActive(rec, RF.IS_ACTIVE),
    }));

    const entries = entryRecords.map((rec) => ({
      recordId:    rec.$id.value,
      employee:    (rec[EF.EMPLOYEE]?.value ?? []).map((u) => u.name || u.code).join('、'),
      entryRoleId: rec[EF.ENTRY_ROLE_ID]?.value || '',
      active:      isActive(rec, EF.IS_ACTIVE),
    }));

    return { roles, entries };
  };

  // ═══════════════════════════════════════════════════════════════════
  // 分析
  // ═══════════════════════════════════════════════════════════════════

  const analyze = ({ roles, entries }) => {
    const roleByRoleId = new Map(roles.filter((r) => r.roleId).map((r) => [r.roleId, r]));

    // 位數不足的代碼本體
    const shortRoles = roles
      .filter((r) => isShort(r.roleId))
      .sort((a, b) => Number(seqOf(a.roleId)) - Number(seqOf(b.roleId)));

    const groups = shortRoles.map((role) => {
      const standard = toStandard(role.roleId);
      return {
        current:  role.roleId,
        standard,
        // 補零後的代碼已經有人用 → 不能直接改，會撞唯一值
        conflict: roleByRoleId.has(standard),
        role,
        // 三處要一起改的位置
        targets: [
          { app: APP_ID.ROLE_DEFINITION, field: RF.ROLE_ID, recordId: role.recordId,
            label: role.roleName || '（未命名）', active: role.active },
          ...roles
            .filter((r) => r.nextRoleId === role.roleId)
            .map((r) => ({ app: APP_ID.ROLE_DEFINITION, field: RF.NEXT_ROLE_ID, recordId: r.recordId,
              label: r.roleName || r.roleId, active: r.active })),
          ...entries
            .filter((e) => e.entryRoleId === role.roleId)
            .map((e) => ({ app: APP_ID.EMPLOYEE_ENTRY, field: EF.ENTRY_ROLE_ID, recordId: e.recordId,
              label: e.employee || '（未填員工）', active: e.active })),
        ],
      };
    });

    // 引用的代碼在 685 找不到；若換一種位數就找得到，就是位數寫錯造成的斷鏈
    const broken = [];
    const checkRef = (app, field, recordId, label, refId, active, extra = {}) => {
      if (!refId || roleByRoleId.has(refId)) return;
      const digits = seqOf(refId);
      const alt = digits === null
        ? null
        : [ROLE_ID_PREFIX + digits.padStart(CONFIG.STD_WIDTH, '0'),
           ROLE_ID_PREFIX + digits.replace(/^0+/, '')]
          .find((cand) => cand !== refId && roleByRoleId.has(cand));
      broken.push({ app, field, recordId, label, refId, alt, active, ...extra });
    };

    roles.forEach((r) => checkRef(APP_ID.ROLE_DEFINITION, RF.NEXT_ROLE_ID, r.recordId,
      r.roleName || r.roleId, r.nextRoleId, r.active,
      // 指定新的下一關時要用：自己的代碼（偵測迴圈）與終點旗標（避免自相矛盾）
      { sourceRoleId: r.roleId, isChainEnd: r.isChainEnd }));
    entries.forEach((e) => checkRef(APP_ID.EMPLOYEE_ENTRY, EF.ENTRY_ROLE_ID, e.recordId,
      e.employee || '（未填員工）', e.entryRoleId, e.active));

    // 位數寫錯的排前面（那是這次要處理的），其餘真的找不到的排後面
    broken.sort((a, b) => Number(Boolean(b.alt)) - Number(Boolean(a.alt)));

    return {
      groups,
      broken,
      roles,
      totalRoles: roles.length,
      totalEntries: entries.length,
      fixCount: groups.reduce((sum, g) => sum + g.targets.length, 0),
    };
  };

  /** 給「複製清單」用的 TSV（可直接貼進 Excel 逐項打勾） */
  const buildTsv = (groups) => [
    ['目前代碼', '改成', 'App', '欄位', '記錄編號', '記錄內容', '連結'].join('\t'),
    ...groups.flatMap((g) => g.targets.map((t) => [
      g.current, g.standard, t.app, t.field, t.recordId, t.label, recordUrl(t.app, t.recordId),
    ].join('\t'))),
  ].join('\n');

  // ═══════════════════════════════════════════════════════════════════
  // 寫入動作
  // ═══════════════════════════════════════════════════════════════════

  const putRecords = async (app, updates) => {
    for (const part of chunk(updates, CONFIG.WRITE_BATCH)) {
      await kintoneApi('/k/v1/records', 'PUT', { app, records: part });
    }
  };

  /**
   * 批次補零。順序固定為「引用 → 本體」，理由見檔頭。
   * @param {Function} [onPhase] - 進度回報
   */
  const applyGroupFixes = async (groups, onPhase) => {
    const roleRefs = [];
    const entryRefs = [];
    const bodies = [];

    for (const g of groups) {
      for (const t of g.targets) {
        if (t.app === APP_ID.EMPLOYEE_ENTRY) {
          entryRefs.push({ id: t.recordId, record: { [EF.ENTRY_ROLE_ID]: { value: g.standard } } });
        } else if (t.field === RF.NEXT_ROLE_ID) {
          roleRefs.push({ id: t.recordId, record: { [RF.NEXT_ROLE_ID]: { value: g.standard } } });
        } else {
          bodies.push({ id: t.recordId, record: { [RF.ROLE_ID]: { value: g.standard } } });
        }
      }
    }

    onPhase?.(`① 685 下一關　${roleRefs.length} 筆`);
    await putRecords(APP_ID.ROLE_DEFINITION, roleRefs);
    onPhase?.(`② 686 員工起點　${entryRefs.length} 筆`);
    await putRecords(APP_ID.EMPLOYEE_ENTRY, entryRefs);
    onPhase?.(`③ 685 角色代碼　${bodies.length} 筆`);
    await putRecords(APP_ID.ROLE_DEFINITION, bodies);

    return { refs: roleRefs.length + entryRefs.length, bodies: bodies.length };
  };

  /**
   * 迴圈偵測：套用後來源的下一關會變成 target，
   * 因此只要 target 的下游走得回 sourceRoleId 就會形成迴圈（target === source 也算）。
   */
  const walksBackTo = (targetRoleId, sourceRoleId, nextByRoleId) => {
    let cur = targetRoleId;
    for (let i = 0; i < MAX_WALK; i++) {
      if (!cur) return false;
      if (cur === sourceRoleId) return true;
      cur = nextByRoleId.get(cur) || '';
    }
    return false;
  };

  /**
   * ② 區：把勾選的斷鏈記錄指向一個實際存在的角色。
   * 685 寫 next_role_id（原本標記終點的一併取消，否則與下一關互相矛盾），
   * 686 寫 entry_role_id。
   */
  const applyTargetRole = async (items, targetRoleId) => {
    const roleUpdates = items
      .filter((b) => b.app === APP_ID.ROLE_DEFINITION)
      .map((b) => ({
        id: b.recordId,
        record: {
          [RF.NEXT_ROLE_ID]: { value: targetRoleId },
          ...(b.isChainEnd ? { [RF.IS_CHAIN_END]: { value: [] } } : {}),
        },
      }));
    const entryUpdates = items
      .filter((b) => b.app === APP_ID.EMPLOYEE_ENTRY)
      .map((b) => ({ id: b.recordId, record: { [EF.ENTRY_ROLE_ID]: { value: targetRoleId } } }));

    await putRecords(APP_ID.ROLE_DEFINITION, roleUpdates);
    await putRecords(APP_ID.EMPLOYEE_ENTRY, entryUpdates);
    return { roles: roleUpdates.length, entries: entryUpdates.length };
  };

  /** ② 區：把位數寫錯的引用改成實際存在的代碼（只動引用，不動本體） */
  const repairBrokenRefs = async (items) => {
    await putRecords(APP_ID.ROLE_DEFINITION, items
      .filter((b) => b.app === APP_ID.ROLE_DEFINITION)
      .map((b) => ({ id: b.recordId, record: { [RF.NEXT_ROLE_ID]: { value: b.alt } } })));
    await putRecords(APP_ID.EMPLOYEE_ENTRY, items
      .filter((b) => b.app === APP_ID.EMPLOYEE_ENTRY)
      .map((b) => ({ id: b.recordId, record: { [EF.ENTRY_ROLE_ID]: { value: b.alt } } })));
    return items.length;
  };

  /**
   * 角色選擇器：600 個角色用純下拉太難找，配一個即時過濾的輸入框。
   * @returns {Promise<string|null>} 選中的 role_id
   */
  const pickRole = async (roles) => {
    const options = roles
      .filter((r) => r.roleId)
      .sort((a, b) => a.roleName.localeCompare(b.roleName, 'zh-Hant') || a.roleId.localeCompare(b.roleId));

    const optionHtml = (list) => list.map((r) =>
      `<option value="${esc(r.roleId)}">${esc(r.roleName || '（未命名）')}　${esc(r.roleId)}${r.active ? '' : '　［已停用］'}</option>`).join('');

    const { value } = await Swal.fire({
      title: '要指向哪一個角色？',
      html:
        `<input id="ar-pick-filter" placeholder="輸入角色名稱或代碼過濾…" autocomplete="off"
           style="width:100%; box-sizing:border-box; padding:8px 10px; font-size:14px; font-family:inherit; border:1px solid #cbd5e1; border-radius:6px; margin-bottom:8px;">
         <select id="ar-pick-select" size="10" style="width:100%; font-size:14px; padding:4px; font-family:inherit;">
           ${optionHtml(options)}
         </select>
         <div style="text-align:left; font-size:12px; color:#888; margin-top:6px;">
           同一關若有多位簽核者（同名多筆），這裡挑的是其中一筆的代碼——鏈會走到那一筆。
         </div>`,
      width: '640px',
      showCancelButton: true,
      confirmButtonText: '確定',
      cancelButtonText: '取消',
      didOpen: () => {
        const filter = document.getElementById('ar-pick-filter');
        const select = document.getElementById('ar-pick-select');
        filter.addEventListener('input', () => {
          const kw = filter.value.trim().toLowerCase();
          const hit = kw
            ? options.filter((r) => r.roleName.toLowerCase().includes(kw) || r.roleId.toLowerCase().includes(kw))
            : options;
          select.innerHTML = optionHtml(hit);
        });
        filter.focus();
      },
      preConfirm: () => {
        const select = document.getElementById('ar-pick-select');
        if (!select?.value) {
          Swal.showValidationMessage('請先選一個角色');
          return false;
        }
        return select.value;
      },
    });

    return value || null;
  };

  // ═══════════════════════════════════════════════════════════════════
  // 報告 UI
  // ═══════════════════════════════════════════════════════════════════

  const SECTION_CSS = 'border:1px solid #e5e7eb; border-radius:8px; margin-bottom:16px; overflow:hidden;';
  const SECTION_HEAD_CSS =
    'padding:10px 14px; background:#f7f9fc; border-bottom:1px solid #e5e7eb; font-size:15px; font-weight:700;';
  const TABLE_CSS = 'width:100%; border-collapse:collapse; font-size:14px;';
  const TH_CSS = 'padding:6px 10px; text-align:left; background:#fafafa; border-bottom:1px solid #eee; font-size:12px; color:#555; white-space:nowrap;';
  const TD_CSS = 'padding:6px 10px; border-bottom:1px solid #f2f2f2; vertical-align:middle;';
  const LINK_CSS = 'color:#2980b9; text-decoration:none;';
  const CODE_CSS = 'font-family:monospace; font-size:13px;';

  const appLabel = (app) => (Number(app) === APP_ID.ROLE_DEFINITION ? '685 角色定義' : '686 員工起點');

  const showReport = (model, rescan) => {
    document.getElementById(CONFIG.OVERLAY_ID)?.remove();

    const { groups, broken, roles, totalRoles, totalEntries, fixCount } = model;
    const repairable = broken.filter((b) => b.alt);
    // 撞號的不能自動改，預設不勾
    const picked = new Set(groups.filter((g) => !g.conflict).map((g) => g.current));

    const overlay = document.createElement('div');
    overlay.id = CONFIG.OVERLAY_ID;
    overlay.style.cssText =
      // 低於 SweetAlert2 的 1060，提示視窗才疊得上來
      'position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:1050; display:flex; align-items:center; justify-content:center;';

    const panel = document.createElement('div');
    panel.style.cssText =
      'background:#fff; border-radius:10px; width:min(1080px, 96vw); height:min(780px, 92vh); ' +
      'display:flex; flex-direction:column; padding:18px 22px; box-shadow:0 8px 40px rgba(0,0,0,.25);';

    const groupHtml = (g) => `
      <div style="padding:12px 14px; border-bottom:1px solid #eee;">
        <div style="font-size:14px; margin-bottom:6px; display:flex; align-items:center; flex-wrap:wrap; gap:4px;">
          <input type="checkbox" data-group="${esc(g.current)}" ${g.conflict ? 'disabled title="補零後的代碼已存在，不能自動改"' : 'checked'}
            style="margin-right:6px;">
          <code style="${CODE_CSS} background:#fff4e5; padding:2px 6px; border-radius:4px;">${esc(g.current)}</code>
          <span style="color:#888; margin:0 6px;">→</span>
          <code style="${CODE_CSS} background:#e8f5e9; padding:2px 6px; border-radius:4px;">${esc(g.standard)}</code>
          <span style="color:#666; font-size:13px; margin-left:8px;">${esc(g.role.roleName || '（未命名）')}</span>
          <span style="color:#888; font-size:12px; margin-left:8px;">共 ${g.targets.length} 處要改</span>
          ${g.conflict ? `
            <span style="color:#c0392b; font-weight:700; font-size:13px; margin-left:8px;">
              ⚠ ${esc(g.standard)} 已經存在，不能直接改（會違反唯一值）
            </span>` : ''}
        </div>
        <table style="${TABLE_CSS} border:1px solid #eee; border-radius:4px;">
          <thead><tr>
            <th style="${TH_CSS}">App</th>
            <th style="${TH_CSS}">欄位</th>
            <th style="${TH_CSS}">記錄</th>
            <th style="${TH_CSS}">內容</th>
            <th style="${TH_CSS}">狀態</th>
          </tr></thead>
          <tbody>
            ${g.targets.map((t) => `
              <tr>
                <td style="${TD_CSS} white-space:nowrap;">${esc(appLabel(t.app))}</td>
                <td style="${TD_CSS}"><code style="${CODE_CSS}">${esc(t.field)}</code></td>
                <td style="${TD_CSS}">
                  <a href="${recordUrl(t.app, t.recordId)}" target="_blank" style="${LINK_CSS}">#${esc(t.recordId)}</a>
                </td>
                <td style="${TD_CSS} color:#555;">${esc(t.label)}</td>
                <td style="${TD_CSS} color:${t.active ? '#16a085' : '#999'}; white-space:nowrap;">
                  ${t.active ? '啟用中' : '已停用'}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    const brokenHtml = broken.length
      ? `
        <table style="${TABLE_CSS}">
          <thead><tr>
            <th style="${TH_CSS} width:36px;"></th>
            <th style="${TH_CSS}">App</th>
            <th style="${TH_CSS}">欄位</th>
            <th style="${TH_CSS}">記錄</th>
            <th style="${TH_CSS}">內容</th>
            <th style="${TH_CSS}">填的代碼</th>
            <th style="${TH_CSS}">判斷</th>
          </tr></thead>
          <tbody>
            ${broken.map((b, i) => `
              <tr>
                <td style="${TD_CSS} text-align:center;"><input type="checkbox" data-broken="${i}"></td>
                <td style="${TD_CSS} white-space:nowrap;">${esc(appLabel(b.app))}</td>
                <td style="${TD_CSS}"><code style="${CODE_CSS}">${esc(b.field)}</code></td>
                <td style="${TD_CSS}">
                  <a href="${recordUrl(b.app, b.recordId)}" target="_blank" style="${LINK_CSS}">#${esc(b.recordId)}</a>
                </td>
                <td style="${TD_CSS} color:#555;">${esc(b.label)}</td>
                <td style="${TD_CSS}"><code style="${CODE_CSS}">${esc(b.refId)}</code></td>
                <td style="${TD_CSS}">
                  ${b.alt
                    ? `<span style="color:#b7791f;">位數寫錯，實際是 <code style="${CODE_CSS}">${esc(b.alt)}</code></span>`
                    : '<span style="color:#c0392b;">685 查無此代碼</span>'}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>`
      : '<div style="padding:16px; text-align:center; color:#999;">沒有指向不存在代碼的記錄</div>';

    panel.innerHTML = `
      <div style="display:flex; align-items:center; margin-bottom:8px;">
        <h2 style="font-size:18px; margin:0;">role_id 位數對照</h2>
        <span style="font-size:13px; color:#666; margin-left:12px;">
          685 共 ${totalRoles} 筆 · 686 共 ${totalEntries} 筆 · 標準格式 ${ROLE_ID_PREFIX}${'0'.repeat(CONFIG.STD_WIDTH)}
        </span>
        <button data-role="close" style="margin-left:auto; font-size:20px; border:none; background:none; cursor:pointer;">✕</button>
      </div>

      <div style="flex:1; overflow-y:auto; padding-right:4px;">
        <div style="${SECTION_CSS}">
          <div style="${SECTION_HEAD_CSS} background:#fff8e1; color:#92400e; display:flex; align-items:center; gap:12px;">
            <span>① 位數不足的代碼（${groups.length} 個，共 ${fixCount} 處要改）</span>
            ${groups.length ? `
              <button data-role="copy"
                style="margin-left:auto; font-size:13px; padding:5px 14px; background:#fff; border:1px solid #ccc; border-radius:4px; cursor:pointer;">
                複製清單（TSV）
              </button>` : ''}
          </div>
          ${groups.length ? `
            <div style="padding:10px 14px; background:#fffdf5; border-bottom:1px solid #f0e6c8; font-size:13px; color:#92400e;">
              同一個代碼底下的每一列都要一起改，只改其中一處會斷鏈。
              建議順序：<strong>先改引用（next_role_id／entry_role_id），最後改 685 的 role_id 本體</strong>——
              反過來改的話，中間那段時間鏈是斷的。
            </div>
            ${groups.map(groupHtml).join('')}`
            : '<div style="padding:16px; text-align:center; color:#999;">沒有位數不足的代碼，格式已經一致</div>'}
        </div>

        <div style="${SECTION_CSS}">
          <div style="${SECTION_HEAD_CSS} display:flex; align-items:center; gap:12px;">
            <span>② 指向不存在代碼的記錄（${broken.length} 筆）
              <span style="font-weight:400; font-size:13px;">— 多半是位數寫錯造成的斷鏈</span></span>
            ${repairable.length ? `
              <button data-role="repair"
                style="margin-left:auto; white-space:nowrap; font-size:13px; padding:5px 14px; background:#fff; border:1px solid #ccc; border-radius:4px; cursor:pointer;">
                把位數寫錯的接回正確代碼（${repairable.length} 筆）
              </button>` : ''}
            ${broken.length ? `
              <button data-role="assign"
                style="${repairable.length ? '' : 'margin-left:auto;'} white-space:nowrap; font-size:13px; padding:5px 14px; background:#3498db; color:#fff; border:none; border-radius:4px; cursor:pointer;">
                <span data-role="assign-label">指定角色給勾選的記錄</span>
              </button>` : ''}
          </div>
          ${broken.length ? `
            <div style="padding:8px 14px; background:#fafafa; border-bottom:1px solid #eee; font-size:13px; color:#555;">
              勾選後按「指定角色」，可以直接把這些記錄的
              <code style="${CODE_CSS}">next_role_id</code>／<code style="${CODE_CSS}">entry_role_id</code>
              改指到一個實際存在的角色。套用前會檢查是否造成迴圈。
            </div>` : ''}
          ${brokenHtml}
        </div>
      </div>

      ${groups.length ? `
        <div style="border-top:1px solid #e5e7eb; padding:12px 0 0; margin-top:8px; display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
          <span data-role="picked-count" style="font-size:13px; color:#666;"></span>
          <span style="font-size:12px; color:#999;">寫入順序：先改引用，最後才改代碼本體</span>
          <span style="flex:1;"></span>
          <button data-role="fix"
            style="font-size:14px; padding:9px 20px; background:#8e6ac2; color:#fff; border:none; border-radius:6px; cursor:pointer;">
            批次補零
          </button>
        </div>` : ''}
    `;

    panel.querySelector('[data-role="close"]').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    // ── 勾選與批次修正 ──
    const countEl = panel.querySelector('[data-role="picked-count"]');
    const fixBtn  = panel.querySelector('[data-role="fix"]');

    const selected = () => groups.filter((g) => picked.has(g.current));
    const updateCount = () => {
      const sel = selected();
      const places = sel.reduce((sum, g) => sum + g.targets.length, 0);
      if (countEl) countEl.textContent = `已勾選 ${sel.length} 個代碼 · ${places} 處要改`;
      if (fixBtn) {
        fixBtn.disabled = sel.length === 0;
        fixBtn.style.opacity = fixBtn.disabled ? '0.5' : '1';
        fixBtn.textContent = sel.length ? `批次補零（${sel.length} 個代碼）` : '批次補零';
      }
    };

    panel.addEventListener('change', (e) => {
      const code = e.target.dataset?.group;
      if (!code) return;
      e.target.checked ? picked.add(code) : picked.delete(code);
      updateCount();
    });

    fixBtn?.addEventListener('click', async () => {
      const sel = selected();
      if (!sel.length) return;
      const places = sel.reduce((sum, g) => sum + g.targets.length, 0);

      const ok = (await Swal.fire({
        icon: 'warning',
        title: `補零 ${sel.length} 個代碼、共 ${places} 處？`,
        html:
          `<div style="text-align:left;">會依序寫入：<br>` +
          `① 685 <code>next_role_id</code> → ② 686 <code>entry_role_id</code> → ③ 685 <code>role_id</code></div>` +
          `<div style="text-align:left; margin-top:8px; color:#b7791f;">` +
          `這三步之間會有<strong>幾秒鐘</strong>鏈是接不上的，請避開送單尖峰時段。` +
          `萬一中途失敗，重新掃描後再按一次即可補完。</div>` +
          `<div style="text-align:left; margin-top:6px; font-size:13px; color:#666;">` +
          `會同時寫入 685 與 686（API 走登入者權限，與這支程式掛在哪個 App 無關），` +
          `請確認目前帳號對<strong>兩張表</strong>都有記錄編輯權。</div>` +
          `<div style="max-height:180px; overflow-y:auto; text-align:left; margin-top:10px;">` +
          sel.map((g) => `・<code>${esc(g.current)}</code> → <code>${esc(g.standard)}</code>` +
            `　<span style="color:#888; font-size:12px;">${g.targets.length} 處</span>`).join('<br>') +
          `</div>`,
        width: '640px',
        showCancelButton: true,
        confirmButtonText: '確定補零',
        confirmButtonColor: '#8e6ac2',
        cancelButtonText: '取消',
        focusCancel: true,
      })).isConfirmed;
      if (!ok) return;

      Swal.fire({ title: '寫入中…', html: '準備中', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

      // 三個階段是分開的 API 呼叫，沒有交易可回滾；失敗時要講清楚停在哪一步
      let lastPhase = '（尚未開始）';
      try {
        const result = await applyGroupFixes(sel, (phase) => {
          lastPhase = phase;
          const html = Swal.getHtmlContainer();
          if (html) html.textContent = phase;
        });
        await Swal.fire({
          icon: 'success',
          title: '補零完成',
          text: `引用 ${result.refs} 筆、代碼本體 ${result.bodies} 筆`,
          timer: 2200, showConfirmButton: false,
        });
      } catch (err) {
        console.error('[ApprovalRouting] 批次補零失敗', err);
        await Swal.fire({
          icon: 'error',
          title: '補零中斷',
          html:
            `<div style="text-align:left;">停在這一步：<strong>${esc(lastPhase)}</strong></div>` +
            `<div style="text-align:left; margin-top:6px; color:#c0392b;">${esc(err.message || err)}</div>` +
            `<div style="text-align:left; margin-top:10px;">` +
            `已寫入的部分<strong>不會回滾</strong>，但這個順序是可以重跑的——` +
            `重新掃描後再按一次，工具會重新算出還沒改完的部分。</div>` +
            `<div style="text-align:left; margin-top:6px; font-size:13px; color:#666;">` +
            `若停在「② 686 員工起點」，通常是這個帳號對 686 沒有記錄編輯權限，` +
            `請改用有權限的帳號再執行一次。</div>`,
          width: '640px',
        });
      }
      overlay.remove();
      rescan?.();
    });

    // ── ② 區：勾選斷鏈記錄，指定要指向的角色 ──
    const pickedBroken = new Set();
    const assignLabel = panel.querySelector('[data-role="assign-label"]');
    const nextByRoleId = new Map(roles.filter((r) => r.roleId).map((r) => [r.roleId, r.nextRoleId]));
    const roleById = new Map(roles.filter((r) => r.roleId).map((r) => [r.roleId, r]));

    const updateAssignLabel = () => {
      if (assignLabel) {
        assignLabel.textContent = pickedBroken.size
          ? `指定角色給勾選的 ${pickedBroken.size} 筆`
          : '指定角色給勾選的記錄';
      }
    };

    panel.addEventListener('change', (e) => {
      const idx = e.target.dataset?.broken;
      if (idx === undefined) return;
      e.target.checked ? pickedBroken.add(Number(idx)) : pickedBroken.delete(Number(idx));
      updateAssignLabel();
    });

    panel.querySelector('[data-role="assign"]')?.addEventListener('click', async () => {
      const items = [...pickedBroken].map((i) => broken[i]).filter(Boolean);
      if (!items.length) {
        await showWarning('還沒勾選', '請先勾選要指定的記錄。');
        return;
      }

      const targetRoleId = await pickRole(roles);
      if (!targetRoleId) return;
      const target = roleById.get(targetRoleId);

      // 只有 685 的下一關會形成迴圈；686 的起點指到誰都不會繞回來
      const cyclic = items.filter((b) =>
        b.app === APP_ID.ROLE_DEFINITION && walksBackTo(targetRoleId, b.sourceRoleId, nextByRoleId));
      if (cyclic.length) {
        await Swal.fire({
          icon: 'error',
          title: '這樣會繞成迴圈',
          html:
            `<div style="text-align:left;">指到 <strong>${esc(target?.roleName || targetRoleId)}</strong> 之後，` +
            `以下記錄的下游會走回自己：</div>` +
            `<div style="text-align:left; margin-top:8px;">` +
            cyclic.map((b) => `・#${esc(b.recordId)}　${esc(b.label)}　<code>${esc(b.sourceRoleId)}</code>`).join('<br>') +
            `</div>`,
          width: '640px',
        });
        return;
      }

      const endCount = items.filter((b) => b.isChainEnd).length;
      const ok = (await Swal.fire({
        icon: 'question',
        title: `把 ${items.length} 筆指向「${target?.roleName || targetRoleId}」？`,
        html:
          `<div style="text-align:left;">目標代碼 <code>${esc(targetRoleId)}</code>` +
          `${target && !target.active ? '　<span style="color:#c0392b;">（這個角色目前是停用狀態）</span>' : ''}</div>` +
          (endCount ? `<div style="text-align:left; margin-top:6px; color:#b7791f;">` +
            `其中 ${endCount} 筆原本標記為「鏈終點」，設定下一關後會一併取消終點標記` +
            `（否則兩者互相矛盾）。</div>` : '') +
          `<div style="max-height:200px; overflow-y:auto; text-align:left; margin-top:10px;">` +
          items.map((b) => `・${esc(appLabel(b.app))} #${esc(b.recordId)}　${esc(b.label)}　` +
            `<code>${esc(b.refId)}</code> → <code>${esc(targetRoleId)}</code>`).join('<br>') +
          `</div>`,
        width: '660px',
        showCancelButton: true, confirmButtonText: '確定指定', cancelButtonText: '取消',
      })).isConfirmed;
      if (!ok) return;

      Swal.fire({ title: '寫入中…', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      try {
        const r = await applyTargetRole(items, targetRoleId);
        await Swal.fire({
          icon: 'success',
          title: '已指定',
          text: `685 ${r.roles} 筆、686 ${r.entries} 筆`,
          timer: 2000, showConfirmButton: false,
        });
      } catch (err) {
        console.error('[ApprovalRouting] 指定角色失敗', err);
        await showWarning('指定中斷', `${err.message || err}（已寫入的部分不會回滾，重新掃描後可再試一次）`);
      }
      overlay.remove();
      rescan?.();
    });

    panel.querySelector('[data-role="repair"]')?.addEventListener('click', async () => {
      const ok = (await Swal.fire({
        icon: 'question',
        title: `把 ${repairable.length} 筆位數寫錯的引用接回？`,
        html:
          `<div style="text-align:left;">只會改引用欄位，不動任何角色代碼本體。</div>` +
          `<div style="max-height:200px; overflow-y:auto; text-align:left; margin-top:10px;">` +
          repairable.map((b) => `・${esc(appLabel(b.app))} #${esc(b.recordId)}　` +
            `<code>${esc(b.refId)}</code> → <code>${esc(b.alt)}</code>`).join('<br>') +
          `</div>`,
        width: '640px',
        showCancelButton: true, confirmButtonText: '確定接回', cancelButtonText: '取消',
      })).isConfirmed;
      if (!ok) return;

      Swal.fire({ title: '寫入中…', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      try {
        const n = await repairBrokenRefs(repairable);
        await Swal.fire({ icon: 'success', title: `已接回 ${n} 筆`, timer: 1800, showConfirmButton: false });
      } catch (err) {
        console.error('[ApprovalRouting] 接回引用失敗', err);
        await showWarning('接回中斷', `${err.message || err}（已寫入的部分不會回滾，重新掃描後可再試一次）`);
      }
      overlay.remove();
      rescan?.();
    });

    panel.querySelector('[data-role="copy"]')?.addEventListener('click', async (e) => {
      try {
        await navigator.clipboard.writeText(buildTsv(groups));
        e.target.textContent = '已複製 ✓';
        setTimeout(() => { e.target.textContent = '複製清單（TSV）'; }, 2000);
      } catch (err) {
        console.error('[ApprovalRouting] 複製失敗', err);
        await showWarning('複製失敗', '瀏覽器拒絕存取剪貼簿，請改用手動選取複製。');
      }
    });

    updateCount();
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  };

  // ═══════════════════════════════════════════════════════════════════
  // 進入點
  // ═══════════════════════════════════════════════════════════════════

  const runTool = async () => {
    Swal.fire({
      title: '掃描中…',
      html: '正在比對 685 的 role_id／next_role_id 與 686 的 entry_role_id',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading(),
    });
    const model = analyze(await loadData());
    Swal.close();
    showReport(model, runTool);
  };

  kintone.events.on(['app.record.index.show'], safeHandler(async (event) => {
    if (document.getElementById(CONFIG.BTN_ID)) return event;
    // 兩張表的清單頁都放按鈕（查的是同一組資料）
    const appId = Number(kintone.app.getId());
    if (appId !== APP_ID.ROLE_DEFINITION && appId !== APP_ID.EMPLOYEE_ENTRY) return event;

    const btn = document.createElement('button');
    btn.id = CONFIG.BTN_ID;
    btn.textContent = 'role_id 位數對照';
    btn.style.cssText =
      'font-size:14px; padding:8px 20px; margin-left:8px; background:#8e6ac2; color:#fff; border:none; border-radius:4px; cursor:pointer;';
    btn.addEventListener('click', async () => {
      try {
        await runTool();
      } catch (err) {
        console.error('[ApprovalRouting] role_id 位數對照錯誤', err);
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
