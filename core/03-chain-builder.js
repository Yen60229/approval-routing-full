/**
 * 核心引擎 — buildChain() + window.ApprovalRouting 對外 API
 *
 * 【影響的欄位】
 *   - approver_chain（子表格）：buildChain() 產生的結果寫入各申請 App
 *
 * 【依賴】
 *   - core/01-config.js（Config）
 *   - core/02-api-client.js（ApiClient）
 *
 * 【核心流程】
 *   1. 查員工起點角色 ID
 *   2. 沿 next_role_id Linked List 走到 is_chain_end
 *   3. 每關解析 holder（群組 → 成員列表 / 個人 → 直接取值）
 *   4. 回傳 chain 陣列，供申請 App 寫入 approver_chain 子表格
 *
 * 【變更履歷】
 *   2026-04-14  Jimmy/Claude  初版建立
 */
(() => {
  'use strict';

  const {
    ROLE_FIELDS: RF,
    HOLDER_TYPE_OPTIONS: HT,
    CHECKBOX,
    CHAIN_FIELDS: CF,
    SIGNING_MODE_OPTIONS: SM,
  } = window.ApprovalRouting.Config;

  const { getRole, getEntryRoleId, getCurrentUserEntryRoleId, getGroupMembers } =
    window.ApprovalRouting.ApiClient;

  const MAX_DEPTH = 20;

  // -------------------------------------------------------------------
  // 內部工具
  // -------------------------------------------------------------------

  /**
   * 解析角色的實際簽核者（人員代碼清單）
   * @param {Object} roleRecord - kintone record
   * @returns {Promise<string[]>} 使用者 code 陣列
   */
  const resolveHolders = async (roleRecord) => {
    const holderType = roleRecord[RF.HOLDER_TYPE].value;

    if (holderType === HT.GROUP) {
      const groupVal = roleRecord[RF.HOLDER_GROUP].value;
      if (!groupVal || groupVal.length === 0) return [];
      const groupCode = groupVal[0].code;
      return getGroupMembers(groupCode);
    }

    // USER
    const userVal = roleRecord[RF.HOLDER_USER].value;
    if (!userVal || userVal.length === 0) return [];
    return [userVal[0].code];
  };

  /**
   * 將 role record 轉成 chain step 物件
   * @param {Object} roleRecord
   * @param {number} stepNo
   * @returns {Promise<Object>}
   */
  const toChainStep = async (roleRecord, stepNo) => {
    const holders = await resolveHolders(roleRecord);
    return {
      [CF.STEP_NO]:          { value: stepNo },
      [CF.ROLE_ID]:          { value: roleRecord[RF.ROLE_ID].value },
      [CF.STEP_NAME]:        { value: roleRecord[RF.ROLE_NAME].value },
      [CF.EXPECTED_SIGNERS]: { value: holders.map((code) => ({ code })) },
      [CF.SIGNED_BY]:        { value: [] },
      [CF.SIGNED_AT]:        { value: '' },
    };
  };

  // -------------------------------------------------------------------
  // 對外 API
  // -------------------------------------------------------------------

  /**
   * 建構簽核鏈
   *
   * @param {string} employeeCode - 申請人的 kintone 使用者代碼
   * @returns {Promise<{
   *   ok: boolean,
   *   chain: Object[],   // approver_chain 子表格的 value 陣列
   *   error: string|null
   * }>}
   *
   * @example
   * const { ok, chain, error } = await ApprovalRouting.buildChain('yamada');
   * if (!ok) { console.error(error); return; }
   * event.record.approver_chain.value = chain;
   */
  const buildChain = async (employeeCode) => {
    try {
      const entryRoleId = await getEntryRoleId(employeeCode);
      if (!entryRoleId) {
        return { ok: false, chain: [], error: `員工 ${employeeCode} 未設定起點角色` };
      }

      const chain = [];
      const visited = new Set();
      let currentRoleId = entryRoleId;

      for (let step = 1; step <= MAX_DEPTH; step++) {
        if (visited.has(currentRoleId)) {
          return { ok: false, chain, error: `偵測到循環：${currentRoleId} 重複出現` };
        }

        const roleRecord = await getRole(currentRoleId);
        if (!roleRecord) {
          return { ok: false, chain, error: `角色 ${currentRoleId} 不存在或未啟用` };
        }

        visited.add(currentRoleId);
        chain.push(await toChainStep(roleRecord, step));

        const isEnd = (roleRecord[RF.IS_CHAIN_END].value ?? []).includes(CHECKBOX.CHAIN_END);
        if (isEnd) break;

        currentRoleId = roleRecord[RF.NEXT_ROLE_ID].value;
        if (!currentRoleId) {
          return { ok: false, chain, error: `角色 ${roleRecord[RF.ROLE_ID].value} 未設定下一關且未標記終點` };
        }
      }

      if (chain.length >= MAX_DEPTH) {
        return { ok: false, chain, error: `簽核鏈深度超過 ${MAX_DEPTH}，可能存在循環` };
      }

      return { ok: true, chain, error: null };

    } catch (err) {
      return { ok: false, chain: [], error: err.message };
    }
  };

  /**
   * 建構目前登入使用者的簽核鏈
   * @returns {Promise<{ok, chain, error}>}
   */
  const buildChainForCurrentUser = async () => {
    const userCode = kintone.getLoginUser().code;
    return buildChain(userCode);
  };

  /**
   * 驗證鏈完整性（不解析群組成員，只走結構）
   * @param {string} startRoleId
   * @returns {Promise<{ok: boolean, depth: number, error: string|null}>}
   */
  const validateChain = async (startRoleId) => {
    const visited = new Set();
    let currentRoleId = startRoleId;
    let depth = 0;

    for (let i = 0; i < MAX_DEPTH; i++) {
      if (visited.has(currentRoleId)) {
        return { ok: false, depth, error: `循環：${currentRoleId} 重複` };
      }

      const rec = await getRole(currentRoleId);
      if (!rec) {
        return { ok: false, depth, error: `角色 ${currentRoleId} 不存在或未啟用` };
      }

      visited.add(currentRoleId);
      depth++;

      const isEnd = (rec[RF.IS_CHAIN_END].value ?? []).includes(CHECKBOX.CHAIN_END);
      if (isEnd) return { ok: true, depth, error: null };

      currentRoleId = rec[RF.NEXT_ROLE_ID].value;
      if (!currentRoleId) {
        return { ok: false, depth, error: `角色 ${rec[RF.ROLE_ID].value} 未設定下一關且未標記終點` };
      }
    }

    return { ok: false, depth, error: `鏈深度超過 ${MAX_DEPTH}` };
  };

  /**
   * 模擬建構鏈（不寫入、僅回傳結果，供模擬器使用）
   * @param {string} employeeCode
   * @returns {Promise<{ok, chain, error}>}
   */
  const simulateChain = async (employeeCode) => buildChain(employeeCode);

  /**
   * 反向查詢：找出所有「會簽到 targetEmployeeCode」的申請人起點
   *
   * 做法：全量載入角色 → 找出哪些角色的 holder 包含 targetEmployeeCode
   *       → 往回找哪些角色的鏈會走到這些角色
   *
   * @param {string} targetEmployeeCode
   * @returns {Promise<{roleIds: string[], roleNames: string[]}>}
   */
  const reverseQuery = async (targetEmployeeCode) => {
    const allRoles = await window.ApprovalRouting.ApiClient.getAllRoles();

    // Step 1：找出 targetEmployee 是 holder 的角色 ID
    const holderRoleIds = new Set();
    for (const [roleId, rec] of allRoles) {
      const holderType = rec[RF.HOLDER_TYPE].value;
      let codes = [];

      if (holderType === HT.USER) {
        codes = (rec[RF.HOLDER_USER].value ?? []).map((u) => u.code);
      } else {
        // GROUP：這裡為效能考量不即時解析群組，僅標記需人工確認
        // 完整版在 tools/03-reverse-query.js 展開群組成員
        const groupVal = rec[RF.HOLDER_GROUP].value ?? [];
        if (groupVal.length > 0) {
          holderRoleIds.add(`GROUP:${groupVal[0].code}`);
          continue;
        }
      }

      if (codes.includes(targetEmployeeCode)) {
        holderRoleIds.add(roleId);
      }
    }

    return {
      roleIds: [...holderRoleIds],
      roleNames: [...holderRoleIds].map((id) => allRoles.get(id)?.[RF.ROLE_NAME]?.value ?? id),
    };
  };

  // -------------------------------------------------------------------
  // 掛到全域（對外 API）
  // -------------------------------------------------------------------
  window.ApprovalRouting = window.ApprovalRouting || {};

  // 主要對外介面
  window.ApprovalRouting.buildChain            = buildChain;
  window.ApprovalRouting.buildChainForCurrentUser = buildChainForCurrentUser;

  // 進階對外介面（工具/試點 App 使用）
  window.ApprovalRouting.Engine = Object.freeze({
    buildChain,
    buildChainForCurrentUser,
    validateChain,
    simulateChain,
    reverseQuery,
  });
})();
