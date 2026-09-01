/**
 * 簽核者重複檢查（kintone App 685）— holder_type =「指定個人」的 holder_user 重複偵測
 *
 * 【前提規則】一筆角色記錄只掛一個人（見 docs/對話脈絡.md §9.5）。
 * 因此同一關有 N 個簽核者 = N 筆同名記錄，**同名多筆本身是正常的**。
 *
 * 在角色定義表列表頁加入「簽核者重複檢查」按鈕，掃描所有**啟用中**且
 * holder_type =「指定個人」的角色記錄，分三類呈現：
 *
 *   ① 一筆記錄掛了多人 — holder_user 有兩筆以上（不同人或同一人被列兩次）
 *        違反「一筆一人」規則。可一鍵拆分：原記錄留第一人（role_id 不變，
 *        指向它的鏈不會斷），其餘每人各建一筆新記錄，沒有人會被移除。
 *
 *   ② 同一人在同一關被掛了多筆 — 同一個人出現在多筆「role_name 相同」的記錄
 *        同一個人在同一關只該佔一筆。可逐筆勾選後**刪除**或**停用**，
 *        並提供「保留第一筆」快捷。
 *
 *   ③ 一人身兼多個角色 — 同一個人出現在多筆「role_name 不同」的記錄
 *        兼任多關通常是正常的，列出來供確認沒有誤設。逐筆列出實際記錄
 *        （role_id 連結 + 記錄編號 + 被指向數），誤設的可直接勾選刪除或停用。
 *
 * 【刪除前的安全檢查】
 *   同名角色的每一筆各有自己的 role_id，可能正被別處指向，刪掉就會斷鏈：
 *     - 鏈上游：其他角色的 next_role_id 指向這筆的 role_id
 *     - 起點  ：686 員工起點對照表的 entry_role_id 指向這筆的 role_id
 *   兩者都會逐筆顯示數字；有被指向者預設不可勾選刪除，需先改指向（可用
 *   tools/07-batch-next-role.js 批次改下一關）。
 *
 * 【影響的欄位】
 *   - 685 holder_user：僅 ①「拆分」寫入，原記錄縮成第一人，其餘人移到新記錄
 *   - 685 is_active  ：②③ 的「停用勾選記錄」取消勾選
 *   - 685 記錄本身   ：① 的「拆分」會新增記錄；
 *                      ②③ 的「刪除勾選記錄」為永久刪除（kintone 無還原桶）
 *
 * 【依賴】
 *   - core/01-config.js（Config）
 *   - core/04-utils.js（Utils）
 *
 * 【變更履歷】
 *   2026-08-19  Jimmy/Claude  初版建立
 *   2026-08-19  Jimmy/Claude  ② 區改為可逐筆勾選刪除／停用，並加上鏈上游與起點
 *                             的被指向檢查，避免刪掉仍被引用的記錄造成斷鏈
 *   2026-08-19  Jimmy/Claude  確立「一筆記錄只掛一人」規則後改版：
 *                             ① 由「同一筆內同一人重複」擴大為「一筆掛多人」，
 *                                動作由「去重」改為「拆成一人一筆」
 *                             ② 措辭更正（同名多筆是正常的，違規的是同一人佔多筆）
 *                             修正同一筆記錄在多個人的區塊各有一個 checkbox 時，
 *                             勾選狀態不同步、導致刪錯筆的問題
 *   2026-08-27  Jimmy/Claude  ③ 區由純檢視改為逐筆對應到實際記錄並可勾選刪除／停用，
 *                             沿用②的被指向鎖定；動作列移到面板底部，②③ 共用勾選集合
 */
(() => {
  'use strict';

  const { APP_ID, ROLE_FIELDS: RF, ENTRY_FIELDS: EF, CHECKBOX, HOLDER_TYPE_OPTIONS: HT,
          SIGNING_MODE_OPTIONS: SM, ROLE_ID_PREFIX } = window.ApprovalRouting.Config;
  const { safeHandler, kintoneApi, showWarning } = window.ApprovalRouting.Utils;

  const CONFIG = Object.freeze({
    BTN_ID:      'ar-holder-dup-btn',
    OVERLAY_ID:  'ar-holder-dup-overlay',
    RECORD_PAGE: 500,   // records API 單次上限
    WRITE_BATCH: 100,   // records 批量寫入／刪除上限
  });

  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const chunk = (arr, size) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };

  /** 記錄詳情頁連結，讓 HR 從報告直接跳去看 */
  const recordUrl = (recordId) =>
    `${location.origin}/k/${APP_ID.ROLE_DEFINITION}/show#record=${recordId}`;

  // ═══════════════════════════════════════════════════════════════════
  // 資料讀取
  // ═══════════════════════════════════════════════════════════════════

  /** 685 通用分頁撈全量 */
  const fetchRoleRecords = async (fields, condition) => {
    const all = [];
    let offset = 0;
    while (true) {
      const resp = await kintoneApi('/k/v1/records.json', 'GET', {
        app: APP_ID.ROLE_DEFINITION,
        fields,
        query: `${condition} limit ${CONFIG.RECORD_PAGE} offset ${offset}`,
      });
      all.push(...resp.records);
      if (resp.records.length < CONFIG.RECORD_PAGE) break;
      offset += CONFIG.RECORD_PAGE;
    }
    return all;
  };

  /** 啟用中、holder_type =「指定個人」的角色（重複檢查的主體） */
  const fetchUserTypeRoles = async () => {
    const records = await fetchRoleRecords(
      ['$id', RF.ROLE_ID, RF.ROLE_NAME, RF.UNIT_NAME, RF.HOLDER_TYPE, RF.HOLDER_USER,
       RF.NEXT_ROLE_ID, RF.SIGNING_MODE, RF.TITLE_LEVEL, RF.IS_CHAIN_END],
      `${RF.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}") and ${RF.HOLDER_TYPE} in ("${HT.USER}")`,
    );

    return records.map((rec) => ({
      recordId:   rec.$id.value,
      roleId:     rec[RF.ROLE_ID]?.value || '',
      roleName:   rec[RF.ROLE_NAME]?.value || '',
      unitName:   rec[RF.UNIT_NAME]?.value || '',
      nextRoleId: rec[RF.NEXT_ROLE_ID]?.value || '',
      signingMode: rec[RF.SIGNING_MODE]?.value || '',
      // 拆成一人一筆時，新記錄沿用這些設定
      titleLevel: rec[RF.TITLE_LEVEL]?.value || '',
      isChainEnd: rec[RF.IS_CHAIN_END]?.value || [],
      // 保留原始順序與重複，重複偵測就靠它
      holders: (rec[RF.HOLDER_USER]?.value || []).map((u) => ({
        code: u.code,
        name: u.name || u.code,
      })),
    }));
  };

  /**
   * 建立「role_id 被指向次數」的對照，用於判斷某筆記錄可不可以安全刪除
   *   - chain：其他啟用角色的 next_role_id 指向它
   *   - entry：686 啟用中的起點記錄 entry_role_id 指向它
   * @returns {Promise<{chain: Map<string, number>, entry: Map<string, number>, nameByRoleId: Map<string, string>}>}
   */
  const fetchInboundRefs = async () => {
    const chain = new Map();
    const entry = new Map();
    const nameByRoleId = new Map();

    // ① 685 全部啟用角色的 next_role_id
    const roleRecords = await fetchRoleRecords(
      ['$id', RF.ROLE_ID, RF.ROLE_NAME, RF.NEXT_ROLE_ID],
      `${RF.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}")`,
    );
    for (const rec of roleRecords) {
      const roleId = rec[RF.ROLE_ID]?.value || '';
      if (roleId) nameByRoleId.set(roleId, rec[RF.ROLE_NAME]?.value || roleId);
      const next = rec[RF.NEXT_ROLE_ID]?.value || '';
      if (next) chain.set(next, (chain.get(next) || 0) + 1);
    }

    // ② 686 啟用中的起點記錄
    let offset = 0;
    while (true) {
      const resp = await kintoneApi('/k/v1/records.json', 'GET', {
        app: APP_ID.EMPLOYEE_ENTRY,
        fields: [EF.ENTRY_ROLE_ID],
        query: `${EF.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}") limit ${CONFIG.RECORD_PAGE} offset ${offset}`,
      });
      for (const rec of resp.records) {
        const roleId = rec[EF.ENTRY_ROLE_ID]?.value || '';
        if (roleId) entry.set(roleId, (entry.get(roleId) || 0) + 1);
      }
      if (resp.records.length < CONFIG.RECORD_PAGE) break;
      offset += CONFIG.RECORD_PAGE;
    }

    return { chain, entry, nameByRoleId };
  };

  // ═══════════════════════════════════════════════════════════════════
  // 分析
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 分析三類重複
   * @returns {{multiHolder: Array, sameName: Array, crossRole: Array, totalRoles: number}}
   */
  const analyze = (roles, refs) => {
    // 每筆記錄補上被指向資訊（決定能不能刪）
    for (const r of roles) {
      r.inboundChain = refs.chain.get(r.roleId) || 0;
      r.inboundEntry = refs.entry.get(r.roleId) || 0;
      r.locked = r.inboundChain > 0 || r.inboundEntry > 0;
      r.nextName = r.nextRoleId
        ? (refs.nameByRoleId.get(r.nextRoleId) || `未知：${r.nextRoleId}`)
        : '（未設定）';
    }

    // ── ① 一筆記錄掛了多人 ──
    // 規則是一筆記錄只掛一個人，所以 holder_user 有第二筆就算違規，
    // 不論是不同人（該拆開）還是同一人被列兩次（該去重）。
    const multiHolder = [];
    for (const r of roles) {
      if (r.holders.length <= 1) continue;
      const uniqueCodes = [...new Set(r.holders.map((h) => h.code))];
      const nameOf = new Map(r.holders.map((h) => [h.code, h.name]));
      multiHolder.push({
        ...r,
        uniqueCodes,
        uniqueNames: uniqueCodes.map((c) => nameOf.get(c) || c),
        // 拆完會變幾筆：原記錄留第一人，其餘各一筆新記錄
        willBecome: uniqueCodes.length,
      });
    }

    // ── 使用者 → 擔任的角色記錄（同一筆內重複只算一次）──
    const byUser = new Map();
    for (const r of roles) {
      for (const code of new Set(r.holders.map((h) => h.code))) {
        if (!byUser.has(code)) {
          byUser.set(code, {
            code,
            name: r.holders.find((h) => h.code === code)?.name || code,
            records: [],
          });
        }
        byUser.get(code).records.push(r);
      }
    }

    // ── ② 同名角色重複掛同一人 ／ ③ 一人身兼多個角色 ──
    const sameName = [];
    const crossRole = [];
    for (const u of byUser.values()) {
      const byRoleName = new Map();
      for (const r of u.records) {
        if (!byRoleName.has(r.roleName)) byRoleName.set(r.roleName, []);
        byRoleName.get(r.roleName).push(r);
      }

      const repeated = [...byRoleName.entries()].filter(([, list]) => list.length > 1);
      if (repeated.length) {
        sameName.push({
          code: u.code,
          name: u.name,
          groups: repeated.map(([roleName, list]) => ({
            roleName,
            // 記錄編號小的排前面，「保留第一筆」＝保留最早建立的那筆
            records: [...list].sort((a, b) => Number(a.recordId) - Number(b.recordId)),
          })),
        });
      }

      if (byRoleName.size > 1) {
        crossRole.push({
          code: u.code,
          name: u.name,
          roleNames: [...byRoleName.keys()].sort((a, b) => a.localeCompare(b, 'zh-Hant')),
          // 逐筆列出實際記錄，才能直接對應到 685 的哪一筆並勾選處理
          records: [...u.records].sort((a, b) =>
            a.roleName.localeCompare(b.roleName, 'zh-Hant') || Number(a.recordId) - Number(b.recordId)),
        });
      }
    }

    const byName = (a, b) => a.name.localeCompare(b.name, 'zh-Hant');
    sameName.sort(byName);
    crossRole.sort((a, b) => b.roleNames.length - a.roleNames.length || byName(a, b));

    return { multiHolder, sameName, crossRole, totalRoles: roles.length, roles };
  };

  // ═══════════════════════════════════════════════════════════════════
  // 寫入動作
  // ═══════════════════════════════════════════════════════════════════

  /** 產生 role_id 流水號的起點：現有最大的 ROLE_NNNN 再加 1 */
  const nextRoleSeq = async () => {
    const resp = await kintoneApi('/k/v1/records.json', 'GET', {
      app: APP_ID.ROLE_DEFINITION,
      fields: [RF.ROLE_ID],
      query: `order by ${RF.ROLE_ID} desc limit ${CONFIG.RECORD_PAGE}`,
    });
    let max = 0;
    for (const rec of resp.records) {
      const val = rec[RF.ROLE_ID]?.value || '';
      if (!val.startsWith(ROLE_ID_PREFIX)) continue;
      const num = Number(val.slice(ROLE_ID_PREFIX.length));
      if (Number.isInteger(num) && num > max) max = num;
    }
    return max + 1;
  };

  /**
   * ① 拆成一人一筆
   *
   * 原記錄的 holder_user 只留第一個人（role_id 不變，指向它的鏈不會斷），
   * 其餘每人各建一筆新記錄，其他欄位原封沿用。沒有人會被移除。
   */
  const splitHolders = async (targets) => {
    // 原記錄：holder_user 縮成第一人
    const updates = targets.map((r) => ({
      id: r.recordId,
      record: { [RF.HOLDER_USER]: { value: [{ code: r.uniqueCodes[0] }] } },
    }));

    // 其餘的人：各建一筆新記錄
    let seq = await nextRoleSeq();
    const creates = targets.flatMap((r) => r.uniqueCodes.slice(1).map((code) => ({
      [RF.ROLE_ID]:      { value: `${ROLE_ID_PREFIX}${String(seq++).padStart(4, '0')}` },
      [RF.ROLE_NAME]:    { value: r.roleName },
      [RF.UNIT_NAME]:    { value: r.unitName },
      [RF.TITLE_LEVEL]:  { value: r.titleLevel },
      [RF.HOLDER_TYPE]:  { value: HT.USER },
      [RF.HOLDER_USER]:  { value: [{ code }] },
      [RF.HOLDER_GROUP]: { value: [] },
      [RF.NEXT_ROLE_ID]: { value: r.nextRoleId },
      [RF.IS_CHAIN_END]: { value: r.isChainEnd },
      // 單選必填，原記錄沒填就給預設值，避免整批寫入失敗
      [RF.SIGNING_MODE]: { value: r.signingMode || SM.ANY },
      [RF.IS_ACTIVE]:    { value: [CHECKBOX.ACTIVE] },
    })));

    // 先新增再縮減：中途失敗時人還在原記錄上，不會有人不見
    for (const part of chunk(creates, CONFIG.WRITE_BATCH)) {
      await kintoneApi('/k/v1/records.json', 'POST', { app: APP_ID.ROLE_DEFINITION, records: part });
    }
    for (const part of chunk(updates, CONFIG.WRITE_BATCH)) {
      await kintoneApi('/k/v1/records.json', 'PUT', { app: APP_ID.ROLE_DEFINITION, records: part });
    }
    return creates.length;
  };

  /** ② 永久刪除記錄（kintone 沒有還原桶，刪掉就沒了） */
  const deleteRecords = async (ids) => {
    for (const part of chunk(ids, CONFIG.WRITE_BATCH)) {
      await kintoneApi('/k/v1/records.json', 'DELETE', { app: APP_ID.ROLE_DEFINITION, ids: part });
    }
  };

  /** ② 停用記錄（取消勾選「啟用中」，資料留著，可隨時勾回來） */
  const deactivateRecords = async (ids) => {
    const updates = ids.map((id) => ({ id, record: { [RF.IS_ACTIVE]: { value: [] } } }));
    for (const part of chunk(updates, CONFIG.WRITE_BATCH)) {
      await kintoneApi('/k/v1/records.json', 'PUT', { app: APP_ID.ROLE_DEFINITION, records: part });
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // 報告 UI
  // ═══════════════════════════════════════════════════════════════════

  const SECTION_CSS =
    'border:1px solid #e5e7eb; border-radius:8px; margin-bottom:16px; overflow:hidden;';
  const SECTION_HEAD_CSS =
    'padding:10px 14px; background:#f7f9fc; border-bottom:1px solid #e5e7eb; font-size:15px; font-weight:700;';
  const TABLE_CSS = 'width:100%; border-collapse:collapse; font-size:14px;';
  const TH_CSS = 'padding:8px 10px; text-align:left; background:#fafafa; border-bottom:1px solid #eee; font-size:13px; color:#555;';
  const TD_CSS = 'padding:8px 10px; border-bottom:1px solid #f0f0f0; vertical-align:top;';
  const LINK_CSS = 'color:#2980b9; text-decoration:none;';

  /** 「被指向」欄：鏈上游與員工起點各有幾筆指著它（有數字就不能直接刪） */
  const refCellHtml = (r) => {
    const refs = [];
    if (r.inboundChain) refs.push(`鏈上游 ${r.inboundChain}`);
    if (r.inboundEntry) refs.push(`起點 ${r.inboundEntry}`);
    return refs.length
      ? `<span style="color:#c0392b; font-weight:700;">${esc(refs.join('／'))}</span>`
      : '<span style="color:#999;">無</span>';
  };

  const emptyRow = (colspan, text) =>
    `<tr><td colspan="${colspan}" style="padding:16px; text-align:center; color:#999;">${esc(text)}</td></tr>`;

  const showReport = (model, rescan) => {
    document.getElementById(CONFIG.OVERLAY_ID)?.remove();

    const overlay = document.createElement('div');
    overlay.id = CONFIG.OVERLAY_ID;
    overlay.style.cssText =
      // 低於 SweetAlert2 的 1060，確認視窗才疊得上來
      'position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:1050; display:flex; align-items:center; justify-content:center;';

    const panel = document.createElement('div');
    panel.style.cssText =
      'background:#fff; border-radius:10px; width:min(1040px, 95vw); height:min(740px, 92vh); ' +
      'display:flex; flex-direction:column; padding:20px 24px; box-shadow:0 8px 40px rgba(0,0,0,.25);';

    const { multiHolder, sameName, crossRole, totalRoles, roles } = model;

    // 勾選的記錄（②③ 共用一個集合，同一筆在兩區各有 checkbox 也只算一次）
    const picked = new Set();
    const recordById = new Map(roles.map((r) => [r.recordId, r]));

    // ── ① ──
    const sec1Rows = multiHolder.length
      ? multiHolder.map((r) => `
          <tr>
            <td style="${TD_CSS}">
              <a href="${recordUrl(r.recordId)}" target="_blank" style="${LINK_CSS}">${esc(r.roleName || r.roleId)}</a>
              <span style="color:#999; font-size:12px;">（記錄 ${esc(r.recordId)}）</span>
            </td>
            <td style="${TD_CSS} color:#c0392b; font-weight:600;">
              ${r.uniqueNames.map(esc).join('、')}
            </td>
            <td style="${TD_CSS} color:#666;">1 筆 → ${r.willBecome} 筆</td>
          </tr>`).join('')
      : emptyRow(3, '沒有這類問題');

    /** ② 單筆記錄一列：勾選框 + 判斷要不要留所需的資訊 */
    const dupRecordRow = (r) => `
        <tr style="border-top:1px solid #f0f0f0;">
          <td style="padding:6px 8px; text-align:center; width:36px;">
            <input type="checkbox" data-record="${esc(r.recordId)}" ${r.locked ? 'disabled title="仍被指向，請先改指向再處理"' : ''}>
          </td>
          <td style="padding:6px 8px;">
            <a href="${recordUrl(r.recordId)}" target="_blank" style="${LINK_CSS}">${esc(r.roleId)}</a>
            <span style="color:#999; font-size:12px;">（記錄 ${esc(r.recordId)}）</span>
          </td>
          <td style="padding:6px 8px; color:#555;">${esc(r.nextName)}</td>
          <td style="padding:6px 8px; color:#555;">${esc(r.signingMode || '—')}</td>
          <td style="padding:6px 8px;">${r.holders.length} 人</td>
          <td style="padding:6px 8px;">${refCellHtml(r)}</td>
        </tr>`;

    const sec2Html = sameName.length
      ? sameName.map((u) => `
          <div style="padding:12px 14px; border-bottom:1px solid #eee;">
            <div style="font-size:14px; margin-bottom:8px;">
              <strong>${esc(u.name)}</strong>
              <span style="color:#888; font-size:12px;">（${esc(u.code)}）</span>
            </div>
            ${u.groups.map((g) => `
              <div style="margin:0 0 10px 8px;">
                <div style="font-size:14px; font-weight:600; margin-bottom:4px;">
                  ${esc(g.roleName)}
                  <span style="color:#c0392b;">重複 ${g.records.length} 筆</span>
                  <button data-role="keep-first" data-name="${esc(u.code)}||${esc(g.roleName)}"
                    style="margin-left:8px; font-size:12px; padding:3px 10px; background:#fff; border:1px solid #ccc; border-radius:4px; cursor:pointer;">
                    保留第一筆、其餘勾選
                  </button>
                </div>
                <table style="${TABLE_CSS} border:1px solid #eee; border-radius:4px;">
                  <thead><tr>
                    <th style="${TH_CSS} width:36px;"></th>
                    <th style="${TH_CSS}">role_id</th>
                    <th style="${TH_CSS}">下一關</th>
                    <th style="${TH_CSS}">簽核方式</th>
                    <th style="${TH_CSS}">簽核者</th>
                    <th style="${TH_CSS}">被指向</th>
                  </tr></thead>
                  <tbody data-group="${esc(u.code)}||${esc(g.roleName)}">
                    ${g.records.map(dupRecordRow).join('')}
                  </tbody>
                </table>
              </div>`).join('')}
          </div>`).join('')
      : '<div style="padding:16px; text-align:center; color:#999;">沒有這類問題</div>';

    // ── ③ ──
    // 逐筆列出實際記錄（含 role_id 連結與被指向數），才能直接勾選刪除／停用
    const crossRecordRow = (r) => `
      <tr style="border-top:1px solid #f0f0f0;">
        <td style="padding:6px 8px; text-align:center; width:36px;">
          <input type="checkbox" data-record="${esc(r.recordId)}" ${r.locked ? 'disabled title="仍被指向，請先改指向再處理"' : ''}>
        </td>
        <td style="padding:6px 8px;">${esc(r.roleName)}</td>
        <td style="padding:6px 8px;">
          <a href="${recordUrl(r.recordId)}" target="_blank" style="${LINK_CSS}">${esc(r.roleId)}</a>
          <span style="color:#999; font-size:12px;">（記錄 ${esc(r.recordId)}）</span>
        </td>
        <td style="padding:6px 8px; color:#555;">${esc(r.nextName)}</td>
        <td style="padding:6px 8px;">${refCellHtml(r)}</td>
      </tr>`;

    const sec3Html = crossRole.length
      ? crossRole.map((u) => `
          <div style="padding:12px 14px; border-bottom:1px solid #eee;">
            <div style="font-size:14px; margin-bottom:8px;">
              <strong>${esc(u.name)}</strong>
              <span style="color:#888; font-size:12px;">（${esc(u.code)}）</span>
              <span style="color:#666; font-size:13px;">　擔任 ${u.roleNames.length} 個關卡</span>
            </div>
            <table style="${TABLE_CSS} border:1px solid #eee; border-radius:4px;">
              <thead><tr>
                <th style="${TH_CSS} width:36px;"></th>
                <th style="${TH_CSS}">角色</th>
                <th style="${TH_CSS}">role_id</th>
                <th style="${TH_CSS}">下一關</th>
                <th style="${TH_CSS}">被指向</th>
              </tr></thead>
              <tbody>${u.records.map(crossRecordRow).join('')}</tbody>
            </table>
          </div>`).join('')
      : '<div style="padding:16px; text-align:center; color:#999;">沒有人身兼多個角色</div>';

    panel.innerHTML = `
      <div style="display:flex; align-items:center; margin-bottom:6px;">
        <h2 style="font-size:18px; margin:0;">簽核者重複檢查</h2>
        <span style="font-size:13px; color:#666; margin-left:12px;">
          掃描範圍：啟用中且 holder_type =「指定個人」的角色 ${totalRoles} 筆
        </span>
        <button data-role="close" style="margin-left:auto; font-size:20px; border:none; background:none; cursor:pointer;">✕</button>
      </div>

      <div data-role="body" style="flex:1; overflow-y:auto; padding-right:4px;">

        <div style="${SECTION_CSS}">
          <div style="${SECTION_HEAD_CSS} background:#fdecea; color:#7f1d1d;">
            ① 一筆記錄掛了多人（${multiHolder.length} 筆）
            <span style="font-weight:400; font-size:13px;">— 一筆記錄只該掛一個人，多人要拆成多筆</span>
          </div>
          <table style="${TABLE_CSS}">
            <thead><tr>
              <th style="${TH_CSS}">角色</th><th style="${TH_CSS}">目前的簽核者</th><th style="${TH_CSS}">拆完</th>
            </tr></thead>
            <tbody>${sec1Rows}</tbody>
          </table>
          ${multiHolder.length ? `
            <div style="padding:10px 14px; border-top:1px solid #eee; display:flex; align-items:center; gap:12px;">
              <span style="font-size:13px; color:#666;">
                原記錄留第一個人（role_id 不變，鏈不會斷），其餘每人各建一筆新記錄，沒有人會被移除。
              </span>
              <button data-role="split"
                style="margin-left:auto; white-space:nowrap; font-size:14px; padding:9px 20px; background:#3498db; color:#fff; border:none; border-radius:6px; cursor:pointer;">
                拆成一人一筆（${multiHolder.length} 筆）
              </button>
            </div>` : ''}
        </div>

        <div style="${SECTION_CSS}">
          <div style="${SECTION_HEAD_CSS} background:#fff8e1; color:#92400e;">
            ② 同一人在同一關被掛了多筆（${sameName.length} 人）
            <span style="font-weight:400; font-size:13px;">— 同名角色有多筆是正常的（一人一筆），但同一個人只該佔其中一筆</span>
          </div>
          ${sameName.length ? `
            <div style="padding:10px 14px; background:#fffdf5; border-bottom:1px solid #f0e6c8; font-size:13px; color:#92400e;">
              勾選要處理的記錄，再選下方的動作。<strong>「被指向」有數字的記錄已鎖住無法勾選</strong>——
              代表還有簽核鏈或員工起點指著它，直接處理會讓那些流程斷掉；
              請先用「批次設定下一關」改指向，或到 686 改起點角色，再回來重掃。
            </div>` : ''}
          ${sec2Html}
        </div>

        <div style="${SECTION_CSS}">
          <div style="${SECTION_HEAD_CSS}">
            ③ 一人身兼多個角色（${crossRole.length} 人）
            <span style="font-weight:400; font-size:13px;">— 兼任多關通常正常；確認有誤設的話可直接勾選處理</span>
          </div>
          ${crossRole.length ? `
            <div style="padding:10px 14px; background:#fafafa; border-bottom:1px solid #eee; font-size:13px; color:#555;">
              這裡列的是<strong>實際的角色記錄</strong>，點 role_id 可開啟該筆。
              要移除誤設的兼任，勾選後用下方的動作；<strong>「被指向」有數字的一樣鎖住</strong>，
              請先改指向再處理。
            </div>` : ''}
          ${sec3Html}
        </div>

      </div>

      ${(sameName.length || crossRole.length) ? `
        <div style="border-top:1px solid #e5e7eb; padding:12px 0 0; margin-top:8px; display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
          <span data-role="picked-count" style="font-size:13px; color:#666;">已勾選 0 筆</span>
          <span style="font-size:12px; color:#999;">（②③ 區共用）</span>
          <span style="flex:1;"></span>
          <button data-role="deactivate"
            style="font-size:14px; padding:9px 20px; background:#fff; color:#333; border:1px solid #ccc; border-radius:6px; cursor:pointer;">
            停用勾選的記錄
          </button>
          <button data-role="delete"
            style="font-size:14px; padding:9px 20px; background:#e74c3c; color:#fff; border:none; border-radius:6px; cursor:pointer;">
            刪除勾選的記錄
          </button>
        </div>` : ''}
    `;

    const body = panel.querySelector('[data-role="body"]');
    const countEl = panel.querySelector('[data-role="picked-count"]');
    const delBtn = panel.querySelector('[data-role="delete"]');
    const deacBtn = panel.querySelector('[data-role="deactivate"]');

    const updateCount = () => {
      if (countEl) countEl.textContent = `已勾選 ${picked.size} 筆`;
      [delBtn, deacBtn].forEach((btn) => {
        if (!btn) return;
        btn.disabled = picked.size === 0;
        btn.style.opacity = btn.disabled ? '0.5' : '1';
      });
    };

    panel.querySelector('[data-role="close"]').addEventListener('click', () => overlay.remove());

    /** 同一筆記錄在多個人的區塊各有一個 checkbox，全部設成同一個狀態 */
    const syncCheckbox = (recordId, checked) => {
      body.querySelectorAll(`input[data-record="${CSS.escape(recordId)}"]`)
        .forEach((cb) => { cb.checked = checked; });
      checked ? picked.add(recordId) : picked.delete(recordId);
    };

    // 勾選（事件委派，涵蓋所有群組的表格）
    body.addEventListener('change', (e) => {
      const id = e.target.dataset?.record;
      if (!id) return;
      syncCheckbox(id, e.target.checked);
      updateCount();
    });

    // 「保留第一筆、其餘勾選」：第一筆＝記錄編號最小者；被鎖住的不勾
    body.addEventListener('click', (e) => {
      const key = e.target.dataset?.name;
      if (!key || e.target.dataset.role !== 'keep-first') return;
      const tbody = body.querySelector(`tbody[data-group="${CSS.escape(key)}"]`);
      if (!tbody) return;
      [...tbody.querySelectorAll('input[data-record]')].forEach((cb, idx) => {
        if (cb.disabled) return;
        syncCheckbox(cb.dataset.record, idx > 0);
      });
      updateCount();
    });

    /** 產生確認視窗用的記錄清單 HTML */
    const pickedListHtml = () => {
      const rows = [...picked].map((id) => recordById.get(id)).filter(Boolean);
      return `<div style="max-height:220px; overflow-y:auto; text-align:left; margin-top:10px;">` +
        rows.map((r) =>
          `・${esc(r.roleName)}　<code style="font-size:12px;">${esc(r.roleId)}</code>` +
          `　<span style="color:#888; font-size:12px;">記錄 ${esc(r.recordId)}／簽核者 ${r.holders.length} 人</span>`)
          .join('<br>') +
        `</div>`;
    };

    delBtn?.addEventListener('click', async () => {
      const ids = [...picked];
      if (!ids.length) return;

      const ok = (await Swal.fire({
        icon: 'warning',
        title: `永久刪除 ${ids.length} 筆角色記錄？`,
        html:
          `<div style="text-align:left; color:#c0392b; font-weight:700;">` +
          `kintone 沒有還原桶，刪除後無法復原。</div>` +
          `<div style="text-align:left; margin-top:8px;">若只是想讓它退場，建議改用「停用勾選的記錄」，` +
          `資料留著、隨時可以勾回來。</div>` +
          pickedListHtml(),
        width: '680px',
        showCancelButton: true,
        confirmButtonText: '我確定，永久刪除',
        confirmButtonColor: '#e74c3c',
        cancelButtonText: '取消',
        // 危險操作：預設焦點在取消，避免連按 Enter 誤刪
        focusCancel: true,
      })).isConfirmed;
      if (!ok) return;

      Swal.fire({ title: '刪除中…', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      await deleteRecords(ids);
      await Swal.fire({ icon: 'success', title: `已刪除 ${ids.length} 筆`, timer: 1800, showConfirmButton: false });
      rescan();
    });

    deacBtn?.addEventListener('click', async () => {
      const ids = [...picked];
      if (!ids.length) return;

      const ok = (await Swal.fire({
        icon: 'question',
        title: `停用 ${ids.length} 筆角色記錄？`,
        html:
          `<div style="text-align:left;">只會取消勾選「啟用中」，記錄與簽核者名單都保留，` +
          `之後隨時可以勾回來。</div>` + pickedListHtml(),
        width: '680px',
        showCancelButton: true, confirmButtonText: '確定停用', cancelButtonText: '取消',
      })).isConfirmed;
      if (!ok) return;

      Swal.fire({ title: '停用中…', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      await deactivateRecords(ids);
      await Swal.fire({ icon: 'success', title: `已停用 ${ids.length} 筆`, timer: 1800, showConfirmButton: false });
      rescan();
    });

    panel.querySelector('[data-role="split"]')?.addEventListener('click', async () => {
      const total = multiHolder.length;
      const added = multiHolder.reduce((sum, r) => sum + r.uniqueCodes.length - 1, 0);

      const ok = (await Swal.fire({
        icon: 'question',
        title: `把 ${total} 筆記錄拆成一人一筆？`,
        html:
          `<div style="text-align:left;">` +
          `會新增 <strong>${added}</strong> 筆角色記錄（role_id 自動流水號），` +
          `原記錄只留第一個人。<br>` +
          `其他欄位原封沿用，<strong>沒有任何人會被移除</strong>。</div>`,
        width: '620px',
        showCancelButton: true, confirmButtonText: '確定拆分', cancelButtonText: '取消',
      })).isConfirmed;
      if (!ok) return;

      Swal.fire({ title: '處理中…', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      const created = await splitHolders(multiHolder);
      await Swal.fire({
        icon: 'success',
        title: `已拆分 ${total} 筆，新增 ${created} 筆`,
        timer: 2200, showConfirmButton: false,
      });
      rescan();
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
      html: '正在檢查簽核者設定，並比對哪些角色仍被鏈或起點指向',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading(),
    });
    const [roles, refs] = await Promise.all([fetchUserTypeRoles(), fetchInboundRefs()]);
    const model = analyze(roles, refs);
    Swal.close();
    showReport(model, runTool);
  };

  kintone.events.on(['app.record.index.show'], safeHandler(async (event) => {
    if (document.getElementById(CONFIG.BTN_ID)) return event;

    const btn = document.createElement('button');
    btn.id = CONFIG.BTN_ID;
    btn.textContent = '簽核者重複檢查';
    btn.style.cssText =
      'font-size:14px; padding:8px 20px; margin-left:8px; background:#16a085; color:#fff; border:none; border-radius:4px; cursor:pointer;';
    btn.addEventListener('click', async () => {
      try {
        await runTool();
      } catch (err) {
        console.error('[ApprovalRouting] 簽核者重複檢查錯誤', err);
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
