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
 *   2026-08-31  Jimmy/Claude  P8 Phase B：沿鏈 + 循環偵測抽為 walkSegment（支援
 *                              stop_at_title_level / skip_title_levels 與跨段共用 visited）；
 *                              Phase 2+3 抽為 finalizeChain。兩者都給 core/06-route-engine.js
 *                              複用，不重寫第二套（walkChainStructure 改為薄包裝，行為不變）
 *   2026-09-01  Jimmy/Claude  walkSegment 新增 isEntrySegment：「第一關即截止職稱則不 push」
 *                              （主管送單不用簽自己）只適用於從申請人起點開始的段。
 *                              續接段誤用此規則會無聲吃掉一位上級簽核者
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
   * @param {string|null} [signingModeOverride=null]
   *   非 null 時覆蓋該關的 signing_mode 快照（P8 路由表 step_signing_mode 非「沿用角色表」時用）
   * @returns {Object}
   */
  const assembleChainStep = (roleRecord, holders, stepNo, signingModeOverride = null) => ({
    [CF.STEP_NO]:          { value: stepNo },
    [CF.ROLE_ID]:          { value: roleRecord[RF.ROLE_ID].value },
    [CF.STEP_NAME]:        { value: roleRecord[RF.ROLE_NAME].value },
    [CF.EXPECTED_SIGNERS]: { value: holders.map((code) => ({ code })) },
    // 簽核模式快照：P8 流程管理逐關需要它決定行為（任一人簽 / 全員會簽）。
    // 存快照而非跑到時再查角色表，省一次 API 且沒有時間差問題（docs/05 評估 #3）。
    // 路由表可在段層級覆寫（step_signing_mode），覆寫值優先於角色表設定。
    [CF.SIGNING_MODE]:     { value: signingModeOverride ?? roleRecord[RF.SIGNING_MODE]?.value ?? SM.ANY },
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
   * 沿 Linked List 走一個「段」（Phase 1）— 只讀快取、不解析 holder
   *
   * buildChain 的整鏈走訪與 P8 路由引擎的「員工鏈段」共用這一套沿鏈 + 循環偵測邏輯，
   * 不重寫第二份。差別只在停止條件：
   *   - buildChain：走到 is_chain_end 為止（stopAtTitleLevel = null）
   *   - 員工鏈段：走到某個 title_level 為止（含該角色），中途可跳過指定職稱層級
   *
   * @param {Object} p
   * @param {string} p.startRoleId             起始角色 ID
   * @param {Set<string>} [p.visited]          已走訪角色 ID 集合；路由引擎跨段共用同一個 Set 以偵測跨段循環
   * @param {string|null} [p.stopAtTitleLevel=null]
   *   遇到 title_level 命中的角色即停（含該角色）；null＝走到 is_chain_end 為止
   * @param {string[]} [p.skipTitleLevels=[]]
   *   title_level 命中者照樣沿 next_role_id 往下走，只是不 push 進結果（跳關不是斷鏈，docs/06 §3.1）
   * @param {boolean} [p.isEntrySegment=true]
   *   本段是否從**申請人自己的起點角色**開始。只有這種段才適用「第一關即截止職稱則不 push」
   *   的規則（＝主管送單不用簽自己）。續接段（從前一段的 nextRoleId 往下走）的第一關
   *   是貨真價實的上級簽核者，命中截止職稱仍要納入，否則會無聲少一個人。
   * @param {number} [p.maxDepth=MAX_DEPTH]
   * @returns {Promise<{
   *   ok: boolean,
   *   roleRecords: Object[],
   *   error: string|null,
   *   stoppedBy: 'chain_end'|'stop_title'|null,
   *   nextRoleId: string|null   // 段結束後「下一關」role_id，供路由引擎串接後續員工鏈段
   * }>}
   */
  const walkSegment = async ({
    startRoleId,
    visited = new Set(),
    stopAtTitleLevel = null,
    skipTitleLevels = [],
    isEntrySegment = true,
    maxDepth = MAX_DEPTH,
  }) => {
    const roleRecords = [];
    let currentRoleId = startRoleId;

    for (let step = 1; step <= maxDepth; step++) {
      if (visited.has(currentRoleId)) {
        return { ok: false, roleRecords, error: `偵測到循環：${currentRoleId} 重複出現`, stoppedBy: null, nextRoleId: null };
      }

      const roleRecord = await getRole(currentRoleId);
      if (!roleRecord) {
        return { ok: false, roleRecords, error: `角色 ${currentRoleId} 不存在或未啟用`, stoppedBy: null, nextRoleId: null };
      }

      visited.add(currentRoleId);

      const titleLevel = roleRecord[RF.TITLE_LEVEL]?.value || null;
      const skipped = titleLevel !== null && skipTitleLevels.includes(titleLevel);
      const hitStop = stopAtTitleLevel !== null && titleLevel === stopAtTitleLevel;

      // 「主管送單不用簽自己」：段的第一關就命中截止職稱 → 個人段為空
      // （docs/06 §4 兩個待決點採提案傾向）
      // ⚠️ 僅限「從申請人起點角色開始」的段。續接段的第一關是上級，命中截止職稱仍要簽。
      const dropSelf = isEntrySegment && step === 1 && hitStop;
      if (!skipped && !dropSelf) {
        roleRecords.push(roleRecord);
      }

      const nextRoleId = roleRecord[RF.NEXT_ROLE_ID].value || null;

      if (hitStop) {
        return { ok: true, roleRecords, error: null, stoppedBy: 'stop_title', nextRoleId };
      }

      const isEnd = (roleRecord[RF.IS_CHAIN_END].value ?? []).includes(CHECKBOX.CHAIN_END);
      if (isEnd) {
        if (stopAtTitleLevel !== null) {
          return {
            ok: false, roleRecords, stoppedBy: null, nextRoleId: null,
            error: `員工鏈段設定矛盾：走到終點「${roleRecord[RF.ROLE_NAME].value}」仍未遇到職稱「${stopAtTitleLevel}」`,
          };
        }
        return { ok: true, roleRecords, error: null, stoppedBy: 'chain_end', nextRoleId: null };
      }

      if (!nextRoleId) {
        if (stopAtTitleLevel !== null) {
          return {
            ok: false, roleRecords, stoppedBy: null, nextRoleId: null,
            error: `員工鏈段設定矛盾：角色「${roleRecord[RF.ROLE_NAME].value}」未設定下一關，仍未遇到職稱「${stopAtTitleLevel}」`,
          };
        }
        return {
          ok: false, roleRecords, stoppedBy: null, nextRoleId: null,
          error: `角色 ${roleRecord[RF.ROLE_ID].value} 未設定下一關且未標記終點`,
        };
      }

      currentRoleId = nextRoleId;
    }

    return { ok: false, roleRecords, error: `簽核鏈深度超過 ${maxDepth}，可能存在循環`, stoppedBy: null, nextRoleId: null };
  };

  /**
   * 走完整條鏈（Phase 1）— walkSegment 的薄包裝，行為與重構前完全一致
   * @param {string} entryRoleId
   * @returns {Promise<{ok: boolean, roleRecords: Object[], error: string|null}>}
   */
  const walkChainStructure = (entryRoleId) =>
    walkSegment({ startRoleId: entryRoleId, visited: new Set() });

  /**
   * Phase 2 + 3：平行解析 holder → 擋空簽核者 → 組裝子表格
   * buildChain 與 P8 buildChainForForm 共用同一套組裝邏輯。
   *
   * @param {Array<{role: Object, signingModeOverride: string|null}>} steps
   * @returns {Promise<{ok: boolean, chain: Object[], error: string|null}>}
   */
  const finalizeChain = async (steps) => {
    const roleRecords = steps.map((s) => s.role);

    // Phase 2：平行解析所有 holder（N 次 API 同時發）
    const holderLists = await Promise.all(roleRecords.map(resolveHolders));

    // 空簽核者即擋下，不讓單子帶著死關卡送出（docs/05 評估 #2）
    const emptyError = findEmptyHolderError(roleRecords, holderLists);
    if (emptyError) return { ok: false, chain: [], error: emptyError };

    // Phase 3：組裝（純 CPU，瞬間完成）
    const chain = steps.map((s, idx) =>
      assembleChainStep(s.role, holderLists[idx], idx + 1, s.signingModeOverride)
    );
    return { ok: true, chain, error: null };
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

      // Phase 2 + 3：解析 holder → 擋空 → 組裝（整鏈不覆寫 signing_mode）
      return finalizeChain(
        walked.roleRecords.map((role) => ({ role, signingModeOverride: null }))
      );

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
    // P8 路由引擎（core/06-route-engine.js）複用的共用零件——沿鏈走訪與子表格組裝
    // 只維護這一份，不重寫第二套
    walkSegment,
    finalizeChain,
  });
})();
