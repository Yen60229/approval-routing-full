/**
 * 健康檢查工具 — 找循環鏈、斷鏈、孤立角色、空 holder
 *
 * 在角色定義表列表頁的「體檢」選單提供「健康檢查」，
 * 點擊後掃描整張角色表，以報告方式呈現問題。
 *
 * 【問題類型】
 *   1. 循環鏈   — A→B→C→A，永遠走不到終點
 *   2. 斷鏈     — next_role_id 指向不存在的角色
 *   3. 孤立角色 — 沒有任何角色指向它（且不是任何員工的起點）
 *   4. 空 holder — 角色沒有設定任何簽核者
 *   5. 無終點   — 鏈深度超過上限
 *   6. 同名不一致 — 同名角色（＝同一關）的下一關／終點／簽核模式設定不同
 *
 * 【依賴】
 *   - core/01-config.js（Config）
 *   - core/02-api-client.js（ApiClient）
 *   - core/04-utils.js（Utils）
 *   - core/09-tool-registry.js（ToolRegistry：工具列選單）
 *
 * 【變更履歷】
 *   2026-04-18  Jimmy/Claude  初版建立
 *   2026-08-31  Jimmy/Claude  新增第 6 條規則「同名角色設定一致性」（docs/05 評估 #4）
 */
(() => {
  'use strict';

  const { APP_ID, ROLE_FIELDS: RF, ENTRY_FIELDS: EF, CHECKBOX, HOLDER_TYPE_OPTIONS: HT } =
    window.ApprovalRouting.Config;
  const { getAllRoles, clearRoleCache } = window.ApprovalRouting.ApiClient;
  const { safeHandler } = window.ApprovalRouting.Utils;

  const MAX_DEPTH = 20;

  // -------------------------------------------------------------------
  // 檢查邏輯
  // -------------------------------------------------------------------

  /**
   * 執行完整健康檢查
   * @returns {Promise<Object>} 檢查報告
   */
  const runHealthCheck = async () => {
    // 強制重新載入最新資料
    clearRoleCache();
    const roleMap = await getAllRoles();

    const issues = {
      circular:     [],   // 循環鏈
      broken:       [],   // 斷鏈
      noHolder:     [],   // 空 holder
      orphan:       [],   // 孤立角色
      noEnd:        [],   // 超過深度限制
      inconsistent: [],   // 同名角色設定不一致
    };

    // 被指向的角色 ID（用來找孤立角色）
    const pointedTo = new Set();

    // --- Pass 1：逐角色掃描鏈結構 ---
    for (const [roleId, rec] of roleMap) {
      const isEnd = (rec[RF.IS_CHAIN_END].value ?? []).includes(CHECKBOX.CHAIN_END);
      const nextId = rec[RF.NEXT_ROLE_ID].value;

      // 追蹤被指向的角色
      if (nextId) pointedTo.add(nextId);

      // 空 holder 檢查
      const holderType = rec[RF.HOLDER_TYPE].value;
      const groupVal = rec[RF.HOLDER_GROUP].value ?? [];
      const userVal  = rec[RF.HOLDER_USER].value ?? [];
      if (holderType === HT.GROUP && groupVal.length === 0) {
        issues.noHolder.push({ roleId, roleName: rec[RF.ROLE_NAME].value });
      }
      if (holderType === HT.USER && userVal.length === 0) {
        issues.noHolder.push({ roleId, roleName: rec[RF.ROLE_NAME].value });
      }

      // 非終點 + 斷鏈
      if (!isEnd && nextId && !roleMap.has(nextId)) {
        issues.broken.push({
          roleId,
          roleName: rec[RF.ROLE_NAME].value,
          nextRoleId: nextId,
        });
      }
    }

    // --- Pass 2：從每個角色走鏈，找循環 & 無終點 ---
    const checkedStarts = new Set();

    for (const [startId] of roleMap) {
      if (checkedStarts.has(startId)) continue;

      const visited = new Set();
      let currentId = startId;
      let depth = 0;
      let foundIssue = false;

      while (currentId && depth < MAX_DEPTH) {
        if (visited.has(currentId)) {
          issues.circular.push({ startId, loopAt: currentId });
          foundIssue = true;
          break;
        }
        visited.add(currentId);
        checkedStarts.add(currentId);
        depth++;

        const rec = roleMap.get(currentId);
        if (!rec) break; // 斷鏈，Pass 1 已記錄

        const isEnd = (rec[RF.IS_CHAIN_END].value ?? []).includes(CHECKBOX.CHAIN_END);
        if (isEnd) break;

        currentId = rec[RF.NEXT_ROLE_ID].value;
      }

      if (!foundIssue && depth >= MAX_DEPTH) {
        issues.noEnd.push({ startId });
      }
    }

    // --- Pass 3：孤立角色（沒有任何角色指向它）---
    // 同時查員工起點對照表，排除「是員工起點」的角色
    const entryResp = await kintone.api(
      kintone.api.url('/k/v1/records.json', true), 'GET', {
        app: APP_ID.EMPLOYEE_ENTRY,
        fields: [EF.ENTRY_ROLE_ID],
        query: `${EF.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}") limit 500`,
      }
    );
    const entryRoleIds = new Set(
      entryResp.records.map((r) => r[EF.ENTRY_ROLE_ID].value)
    );

    for (const [roleId, rec] of roleMap) {
      if (!pointedTo.has(roleId) && !entryRoleIds.has(roleId)) {
        issues.orphan.push({ roleId, roleName: rec[RF.ROLE_NAME].value });
      }
    }

    // --- Pass 4：同名角色設定一致性 ---
    // 同名 role_name 就是同一關（docs/對話脈絡.md §9.2、§9.5），
    // 一關有幾位簽核者就有幾筆記錄——同名多筆是正常的。
    // 但既然是同一關，「下一關是誰」與「怎麼簽」就必須一致：
    // 不一致時，下拉以 role_name 去重的假設就破了，選同一個名字會走出兩條不同的鏈，
    // 而且畫面上完全看不出來。可用 tools/07-batch-next-role.js 統一。
    const byRoleName = new Map();
    for (const [roleId, rec] of roleMap) {
      const name = rec[RF.ROLE_NAME].value;
      if (!byRoleName.has(name)) byRoleName.set(name, []);
      byRoleName.get(name).push({ roleId, rec });
    }

    /** 同一關的三個關鍵設定壓成一個可比對的字串 */
    const settingKey = ({ rec }) => [
      rec[RF.NEXT_ROLE_ID].value || '',
      (rec[RF.IS_CHAIN_END].value ?? []).includes(CHECKBOX.CHAIN_END) ? 'END' : '',
      rec[RF.SIGNING_MODE].value || '',
    ].join('|');

    for (const [roleName, group] of byRoleName) {
      if (group.length < 2) continue;

      const first = settingKey(group[0]);
      if (group.every((g) => settingKey(g) === first)) continue;

      issues.inconsistent.push({
        roleName,
        records: group.map(({ roleId, rec }) => ({
          roleId,
          nextRoleId:  rec[RF.NEXT_ROLE_ID].value || '（未設定）',
          isEnd:       (rec[RF.IS_CHAIN_END].value ?? []).includes(CHECKBOX.CHAIN_END),
          signingMode: rec[RF.SIGNING_MODE].value || '（未設定）',
        })),
      });
    }

    return {
      totalRoles: roleMap.size,
      issues,
      hasIssues: Object.values(issues).some((arr) => arr.length > 0),
    };
  };

  // -------------------------------------------------------------------
  // 報告 UI
  // -------------------------------------------------------------------

  const renderReport = (report) => {
    const { totalRoles, issues, hasIssues } = report;

    if (!hasIssues) {
      return `
        <div style="text-align:center; padding:20px; color:#2e7d32; font-size:18px;">
          ✅ 全部 ${totalRoles} 個角色健康，無異常！
        </div>`;
    }

    const section = (title, color, items, renderItem) => {
      if (items.length === 0) return '';
      return `
        <div style="margin-bottom:16px;">
          <div style="font-weight:bold; color:${color}; margin-bottom:6px;">${title}（${items.length} 筆）</div>
          <ul style="margin:0; padding-left:20px; font-size:13px; line-height:1.8;">
            ${items.map(renderItem).join('')}
          </ul>
        </div>`;
    };

    return `
      <div style="text-align:left; max-height:400px; overflow-y:auto; font-size:14px;">
        <div style="margin-bottom:12px; color:#666;">共掃描 ${totalRoles} 個角色</div>
        ${section('🔴 循環鏈', '#c62828', issues.circular,
          (i) => `<li>從 <code>${i.startId}</code> 出發，在 <code>${i.loopAt}</code> 形成循環</li>`)}
        ${section('🔴 同名角色設定不一致', '#c62828', issues.inconsistent,
          (i) => `<li><strong>${i.roleName}</strong>（${i.records.length} 筆記錄，同一關卻設定不同）
            <ul style="margin:4px 0 8px; padding-left:18px; color:#666; font-size:12px;">
              ${i.records.map((r) => `<li><code>${r.roleId}</code>　下一關 <code>${r.nextRoleId}</code>${r.isEnd ? '　<strong>終點</strong>' : ''}　${r.signingMode}</li>`).join('')}
            </ul>
            <span style="font-size:12px; color:#888;">可用「批次設定下一關」工具統一</span></li>`)}
        ${section('🟠 斷鏈', '#e65100', issues.broken,
          (i) => `<li><strong>${i.roleName}</strong>（${i.roleId}）→ <code>${i.nextRoleId}</code> 不存在</li>`)}
        ${section('🟡 空簽核者', '#f57f17', issues.noHolder,
          (i) => `<li><strong>${i.roleName}</strong>（${i.roleId}）未設定簽核者</li>`)}
        ${section('🔵 孤立角色', '#1565c0', issues.orphan,
          (i) => `<li><strong>${i.roleName}</strong>（${i.roleId}）沒有任何角色或員工指向它</li>`)}
        ${section('⚪ 鏈過深', '#555', issues.noEnd,
          (i) => `<li>從 <code>${i.startId}</code> 出發，超過 ${MAX_DEPTH} 層未到終點</li>`)}
      </div>`;
  };

  // -------------------------------------------------------------------
  // 入口
  // -------------------------------------------------------------------

  const runAndShow = async () => {
    Swal.fire({ title: '健康檢查中...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

    const report = await runHealthCheck();
    Swal.close();

    await Swal.fire({
      title: report.hasIssues ? '⚠ 發現問題' : '✅ 健康',
      html: renderReport(report),
      width: 700,
      confirmButtonText: '關閉',
    });
  };

  // 掛在共用工具列（core/09-tool-registry.js）的「inspect」群組，不再自己長一顆按鈕
  window.ApprovalRouting.ToolRegistry.register({
    id:    'health-check',
    group: 'inspect',
    label: '健康檢查',
    hint:  '循環鏈、斷鏈、孤立角色、沒有簽核者的關卡',
    apps:  [APP_ID.ROLE_DEFINITION],
    run:   runAndShow,
  });
})();
