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
 * 【核心流程（3 階段）】
 *   1. 走結構：沿 next_role_id 走完整條鏈（純記憶體，O(n) 無 API）
 *   2. 平行解析：用 Promise.all 同時解析所有關卡的 holder（N 次並發 API）
 *   3. 組裝：把角色資料 + holder 結果合併成子表格格式
 *
 * 【變更履歷】
 *   2026-04-14  Jimmy/Claude  初版建立
 *   2026-04-18  Jimmy/Claude  重構為 3 階段，holder 解析改用 Promise.all 平行化
 *                              5 關鏈效能：1500ms → 300ms（估算）
 *   2026-08-31  Jimmy/Claude  P8 前置修復（docs/05 評估報告）：
 *                              #2 解析後有空簽核者的關卡即回 ok:false，不再放行
 *                              #3 assembleChainStep 帶入 signing_mode 快照
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

  const {
    getRole,
    getEntryRoleId,
    getGroupMembers,
    ensureFresh,
  } = window.ApprovalRouting.ApiClient;

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
   * 將角色紀錄 + 已解析 holder 組裝為子表格 step 物件
   * 純函式（無 I/O），可同步執行
   * @param {Object} roleRecord
   * @param {string[]} holders - 已解析的簽核者 code 陣列
   * @param {number} stepNo
   * @returns {Object}
   */
  const assembleChainStep = (roleRecord, holders, stepNo) => ({
    [CF.STEP_NO]:          { value: stepNo },
    [CF.ROLE_ID]:          { value: roleRecord[RF.ROLE_ID].value },
    [CF.STEP_NAME]:        { value: roleRecord[RF.ROLE_NAME].value },
    [CF.EXPECTED_SIGNERS]: { value: holders.map((code) => ({ code })) },
    // 簽核模式快照：P8 流程管理逐關需要它決定行為（任一人簽 / 全員會簽）。
    // 存快照而非跑到時再查角色表，省一次 API 且沒有時間差問題（docs/05 評估 #3）
    [CF.SIGNING_MODE]:     { value: roleRecord[RF.SIGNING_MODE]?.value ?? SM.ANY },
    [CF.SIGNED_BY]:        { value: [] },
    [CF.SIGNED_AT]:        { value: '' },
  });

  /**
   * 找出解析後沒有任何簽核者的關卡（docs/05 評估 #2）
   *
   * 空關卡不能放行：單子會送出成功、鏈也寫得進子表格，但流程跑到該關就卡死，
   * 而且申請人與 HR 都不會收到任何警告。健康檢查只能事後掃，擋不住已送出的單。
   *
   * @param {Object[]} roleRecords - 與 holderLists 同序
   * @param {string[][]} holderLists
   * @returns {string|null} 有空關卡時回錯誤訊息，全部正常回 null
   */
  const findEmptyHolderError = (roleRecords, holderLists) => {
    const idx = holderLists.findIndex((list) => list.length === 0);
    if (idx === -1) return null;
    return `第 ${idx + 1} 關「${roleRecords[idx][RF.ROLE_NAME].value}」目前沒有任何簽核者，請聯絡 HR 確認角色設定`;
  };

  /**
   * 走鏈結構（Phase 1）— 只讀快取、不解析 holder
   *
   * @param {string} entryRoleId
   * @returns {Promise<{ok: boolean, roleRecords: Object[], error: string|null}>}
   */
  const walkChainStructure = async (entryRoleId) => {
    const roleRecords = [];
    const visited = new Set();
    let currentRoleId = entryRoleId;

    for (let step = 1; step <= MAX_DEPTH; step++) {
      if (visited.has(currentRoleId)) {
        return { ok: false, roleRecords, error: `偵測到循環：${currentRoleId} 重複出現` };
      }

      const roleRecord = await getRole(currentRoleId);
      if (!roleRecord) {
        return { ok: false, roleRecords, error: `角色 ${currentRoleId} 不存在或未啟用` };
      }

      visited.add(currentRoleId);
      roleRecords.push(roleRecord);

      const isEnd = (roleRecord[RF.IS_CHAIN_END].value ?? []).includes(CHECKBOX.CHAIN_END);
      if (isEnd) return { ok: true, roleRecords, error: null };

      currentRoleId = roleRecord[RF.NEXT_ROLE_ID].value;
      if (!currentRoleId) {
        return {
          ok: false,
          roleRecords,
          error: `角色 ${roleRecord[RF.ROLE_ID].value} 未設定下一關且未標記終點`,
        };
      }
    }

    return { ok: false, roleRecords, error: `簽核鏈深度超過 ${MAX_DEPTH}，可能存在循環` };
  };

  // -------------------------------------------------------------------
  // 對外 API
  // -------------------------------------------------------------------

  /**
   * 建構簽核鏈（三階段平行化版本）
   *
   * @param {string} employeeCode - 申請人的 kintone 使用者代碼
   * @param {Object} [options]
   * @param {boolean} [options.forceFresh=false]
   *   true 時強制重新載入角色與起點兩個快取；正式 submit 前建議設 true 避免用到過期資料
   * @returns {Promise<{
   *   ok: boolean,
   *   chain: Object[],   // approver_chain 子表格的 value 陣列
   *   error: string|null
   * }>}
   *
   * @example
   * 預覽用（快，可用快取）
   * const { ok, chain } = await ApprovalRouting.buildChain('yamada');
   *
   * Submit 用（慢一點，但保證資料最新）
   * const { ok, chain } = await ApprovalRouting.buildChain('yamada', { forceFresh: true });
   * event.record.approver_chain.value = chain;
   */
  const buildChain = async (employeeCode, { forceFresh = false } = {}) => {
    try {
      if (forceFresh) await ensureFresh();

      // 起點查詢
      const entryRoleId = await getEntryRoleId(employeeCode);
      if (!entryRoleId) {
        return { ok: false, chain: [], error: `員工 ${employeeCode} 未設定起點角色` };
      }

      // Phase 1：走結構（純快取讀取，無 API 呼叫）
      const walked = await walkChainStructure(entryRoleId);
      if (!walked.ok) {
        return { ok: false, chain: [], error: walked.error };
      }

      // Phase 2：平行解析所有 holder（N 次 API 同時發）
      const holderLists = await Promise.all(walked.roleRecords.map(resolveHolders));

      // 空簽核者即擋下，不讓單子帶著死關卡送出
      const emptyError = findEmptyHolderError(walked.roleRecords, holderLists);
      if (emptyError) {
        return { ok: false, chain: [], error: emptyError };
      }

      // Phase 3：組裝（純 CPU，瞬間完成）
      const chain = walked.roleRecords.map((rec, idx) =>
        assembleChainStep(rec, holderLists[idx], idx + 1)
      );

      return { ok: true, chain, error: null };

    } catch (err) {
      return { ok: false, chain: [], error: err.message ?? String(err) };
    }
  };

  /**
   * 建構目前登入使用者的簽核鏈
   * @param {Object} [options] - 同 buildChain
   * @returns {Promise<{ok, chain, error}>}
   */
  const buildChainForCurrentUser = async (options) => {
    const userCode = kintone.getLoginUser().code;
    return buildChain(userCode, options);
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
