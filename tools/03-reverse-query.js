/**
 * 反向查詢 — 「哪些員工的簽核鏈會經過我」
 *
 * 在員工起點對照表列表頁的「查詢」選單提供「反向查詢」，
 * 輸入目標人員代碼，找出哪些角色包含此人、
 * 以及哪些員工的簽核鏈會走到這些角色。
 *
 * 【流程】
 *   1. 掃描所有角色，找出「holder 包含目標員工」的角色 ID
 *      - USER 類型：直接比對
 *      - GROUP 類型：展開群組成員後比對
 *   2. 掃描所有員工起點，模擬每條鏈，找出哪些鏈會經過步驟 1 的角色
 *   3. 回報「會簽到此人」的角色清單 + 申請人清單
 *
 * 【依賴】
 *   - core/01-config.js（Config）
 *   - core/02-api-client.js（ApiClient）
 *   - core/04-utils.js（Utils）
 *   - core/09-tool-registry.js（ToolRegistry：工具列選單）
 *
 * 【變更履歷】
 *   2026-04-18  Jimmy/Claude  初版建立
 */
(() => {
  'use strict';

  const {
    APP_ID,
    ROLE_FIELDS: RF,
    ENTRY_FIELDS: EF,
    CHECKBOX,
    HOLDER_TYPE_OPTIONS: HT,
  } = window.ApprovalRouting.Config;

  const { getAllRoles, getGroupMembers, clearRoleCache } = window.ApprovalRouting.ApiClient;
  const { safeHandler } = window.ApprovalRouting.Utils;

  const MAX_DEPTH = 20;

  // -------------------------------------------------------------------
  // 反向查詢邏輯
  // -------------------------------------------------------------------

  /**
   * 找出 targetCode 是 holder 的所有角色 ID
   * @param {Map} roleMap
   * @param {string} targetCode
   * @returns {Promise<Set<string>>}
   */
  const findHolderRoles = async (roleMap, targetCode) => {
    const result = new Set();

    for (const [roleId, rec] of roleMap) {
      const holderType = rec[RF.HOLDER_TYPE].value;

      if (holderType === HT.USER) {
        const codes = (rec[RF.HOLDER_USER].value ?? []).map((u) => u.code);
        if (codes.includes(targetCode)) result.add(roleId);

      } else {
        // GROUP：展開群組成員
        const groupVal = rec[RF.HOLDER_GROUP].value ?? [];
        if (groupVal.length === 0) continue;
        try {
          const members = await getGroupMembers(groupVal[0].code);
          if (members.includes(targetCode)) result.add(roleId);
        } catch {
          // 群組查不到，略過
        }
      }
    }

    return result;
  };

  /**
   * 走一條鏈，判斷是否經過 targetRoleIds 中的任一角色
   * @param {Map} roleMap
   * @param {string} startRoleId
   * @param {Set<string>} targetRoleIds
   * @returns {string|null} 第一個命中的 roleId，或 null
   */
  const chainPassesThrough = (roleMap, startRoleId, targetRoleIds) => {
    const visited = new Set();
    let currentId = startRoleId;

    for (let i = 0; i < MAX_DEPTH; i++) {
      if (!currentId || visited.has(currentId)) break;
      if (targetRoleIds.has(currentId)) return currentId;

      visited.add(currentId);
      const rec = roleMap.get(currentId);
      if (!rec) break;

      const isEnd = (rec[RF.IS_CHAIN_END].value ?? []).includes(CHECKBOX.CHAIN_END);
      if (isEnd) break;

      currentId = rec[RF.NEXT_ROLE_ID].value;
    }
    return null;
  };

  /**
   * 主查詢邏輯
   * @param {string} targetCode
   * @returns {Promise<Object>} 查詢結果
   */
  const runReverseQuery = async (targetCode) => {
    clearRoleCache();
    const roleMap = await getAllRoles();

    // Step 1：找出此人擔任 holder 的角色
    const holderRoleIds = await findHolderRoles(roleMap, targetCode);

    if (holderRoleIds.size === 0) {
      return { holderRoles: [], applicants: [] };
    }

    // 整理角色名稱
    const holderRoles = [...holderRoleIds].map((id) => ({
      roleId: id,
      roleName: roleMap.get(id)?.[RF.ROLE_NAME]?.value ?? id,
    }));

    // Step 2：掃描員工起點，找出哪些員工的鏈會走到這些角色
    const entryResp = await kintone.api(
      kintone.api.url('/k/v1/records.json', true), 'GET', {
        app: APP_ID.EMPLOYEE_ENTRY,
        fields: [EF.EMPLOYEE, EF.ENTRY_ROLE_ID],
        query: `${EF.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}") limit 500`,
      }
    );

    const applicants = [];
    for (const rec of entryResp.records) {
      const empVal = rec[EF.EMPLOYEE].value ?? [];
      if (empVal.length === 0) continue;
      const empCode = empVal[0].code;
      const entryRoleId = rec[EF.ENTRY_ROLE_ID].value;

      const hitRoleId = chainPassesThrough(roleMap, entryRoleId, holderRoleIds);
      if (hitRoleId) {
        applicants.push({
          employeeCode: empCode,
          hitRoleId,
          hitRoleName: roleMap.get(hitRoleId)?.[RF.ROLE_NAME]?.value ?? hitRoleId,
        });
      }
    }

    return { holderRoles, applicants };
  };

  // -------------------------------------------------------------------
  // 結果 UI
  // -------------------------------------------------------------------

  const renderResult = (targetCode, result) => {
    const { holderRoles, applicants } = result;

    if (holderRoles.length === 0) {
      return `<div style="color:#999; padding:12px;">「${targetCode}」未擔任任何角色的簽核者。</div>`;
    }

    const roleList = holderRoles.map((r) =>
      `<li><strong>${r.roleName}</strong>（${r.roleId}）</li>`
    ).join('');

    const applicantList = applicants.length === 0
      ? '<div style="color:#999; margin-top:8px;">目前沒有員工的簽核鏈會經過此人。</div>'
      : `<ul style="margin:0; padding-left:20px; line-height:1.8; font-size:13px;">
           ${applicants.map((a) =>
             `<li><strong>${a.employeeCode}</strong> → 經過「${a.hitRoleName}」</li>`
           ).join('')}
         </ul>`;

    return `
      <div style="text-align:left; max-height:420px; overflow-y:auto; font-size:14px;">
        <div style="margin-bottom:12px;">
          <div style="font-weight:bold; margin-bottom:6px;">「${targetCode}」擔任簽核者的角色：</div>
          <ul style="margin:0; padding-left:20px; line-height:1.8; font-size:13px;">${roleList}</ul>
        </div>
        <hr style="border:none; border-top:1px solid #eee; margin:12px 0;">
        <div>
          <div style="font-weight:bold; margin-bottom:6px;">
            會簽到此人的申請人（共 ${applicants.length} 位）：
          </div>
          ${applicantList}
        </div>
      </div>`;
  };

  // -------------------------------------------------------------------
  // 入口
  // -------------------------------------------------------------------

  const runAndShow = async () => {
    const { value: targetCode, isConfirmed } = await Swal.fire({
      title: '反向查詢',
      html: `
        <div style="text-align:left; margin-bottom:8px; font-size:14px; color:#555;">
          輸入員工的 kintone 使用者代碼，查詢哪些申請人的簽核鏈會經過此人。
        </div>
        <input id="ar-rv-input" class="swal2-input" placeholder="例：yamada.taro"
               style="font-size:15px;" />
      `,
      showCancelButton: true,
      confirmButtonText: '查詢',
      cancelButtonText: '取消',
      preConfirm: () => {
        const val = document.getElementById('ar-rv-input').value.trim();
        if (!val) Swal.showValidationMessage('請輸入員工代碼');
        return val;
      },
    });

    if (!isConfirmed || !targetCode) return;

    Swal.fire({ title: '查詢中...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    const result = await runReverseQuery(targetCode);
    Swal.close();

    await Swal.fire({
      title: `反向查詢結果`,
      html: renderResult(targetCode, result),
      width: 650,
      confirmButtonText: '關閉',
    });
  };

  // 掛在共用工具列（core/09-tool-registry.js）的「query」群組，不再自己長一顆按鈕
  window.ApprovalRouting.ToolRegistry.register({
    id:    'reverse-query',
    group: 'query',
    label: '反向查詢',
    hint:  '查「哪些員工的簽核鏈會經過某個人」',
    apps:  [APP_ID.EMPLOYEE_ENTRY],
    run:   runAndShow,
  });
})();
