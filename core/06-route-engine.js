/**
 * P8 路由引擎 — buildChainForForm()：依表單路由設定表（form_route_config）逐段展開簽核鏈
 *
 * 【影響的欄位】
 *   - approver_chain（子表格）：展開結果，由標準 adapter 寫入各申請 App
 *
 * 【依賴】
 *   - core/01-config.js（Config：ROUTE_FIELDS / ROUTE_STEP_FIELDS / 段類型與簽核模式選項）
 *   - core/02-api-client.js（ApiClient：getRouteConfig / getEntryRoleId / ensureFresh）
 *   - core/03-chain-builder.js（Engine：walkSegment / finalizeChain / buildChain）
 *
 * 【設計】
 *   一條路由 = 若干「段」的有序拼接（docs/06 §2）：
 *     - 員工鏈段：沿申請人起點角色走 Linked List，走到指定 title_level 為止（含），
 *                 中途可跳過指定職稱層級（skip_title_levels）
 *     - 指定角色段：固定 role_id，與申請人無關
 *   查無路由或未啟用 → fallback 走現行 buildChain() 全鏈，已接入的 App 一行都不用改。
 *   循環偵測用同一個 visited Set 跨段共用（防職能段又指回個人段造成重複）。
 *   Phase 2（解析 holder）與 Phase 3（組裝子表格）直接複用 03 的 finalizeChain，不重寫。
 *
 * 【變更履歷】
 *   2026-08-31  Jimmy/Claude  初版（P8 Phase B）。docs/06 §4 兩個待決點採提案傾向：
 *                              連續兩關同一人保留兩關、個人段起點即截止職稱則個人段為空
 *   2026-09-01  Jimmy/Claude  修段接續兩個 bug：
 *                              ① 續接的員工鏈段傳 isEntrySegment:false，第一關命中截止職稱
 *                                 不再被當成「申請人自己」丟掉
 *                              ② personalCursor 區分 undefined／null，前段已到終點時明確報錯，
 *                                 不再退回起點重走而誤報「偵測到循環」
 */
(() => {
  'use strict';

  const {
    ROUTE_FIELDS: RCF,
    ROUTE_STEP_FIELDS: RSF,
    SEGMENT_TYPE_OPTIONS: SEG,
    STEP_SIGNING_MODE_OPTIONS: SSM,
  } = window.ApprovalRouting.Config;

  const { getRole, getRouteConfig, getEntryRoleId, ensureFresh } =
    window.ApprovalRouting.ApiClient;

  const { walkSegment, finalizeChain } = window.ApprovalRouting.Engine;

  // -------------------------------------------------------------------
  // 內部工具
  // -------------------------------------------------------------------

  /**
   * 把子表格一列的 step_signing_mode 轉成 assembleChainStep 的覆寫值
   * @param {string} raw - 子表格欄位原值
   * @returns {string|null} null＝沿用角色表快照
   */
  const toSigningOverride = (raw) =>
    raw && raw !== SSM.INHERIT ? raw : null;

  /**
   * 取子表格一列的欄位值（容錯：欄位不存在時回預設）
   */
  const cell = (row, code, fallback = '') => row.value[code]?.value ?? fallback;

  // -------------------------------------------------------------------
  // 對外 API
  // -------------------------------------------------------------------

  /**
   * 依表單路由設定建構簽核鏈
   *
   * @param {string} employeeCode - 申請人的 kintone 使用者代碼
   * @param {number|string} formAppId - 申請 App 的 kintone App ID
   * @param {Object} [options]
   * @param {boolean} [options.forceFresh=false]
   *   true 時強制重新載入角色／起點／路由三個快取；正式 submit 前建議設 true
   * @returns {Promise<{ ok: boolean, chain: Object[], error: string|null }>}
   *   契約與 buildChain 完全相同
   */
  const buildChainForForm = async (employeeCode, formAppId, { forceFresh = false } = {}) => {
    try {
      if (forceFresh) await ensureFresh();

      // 1. 查路由設定；查無或未啟用 → fallback 全鏈（向下相容）
      const routeConfig = await getRouteConfig(formAppId);
      if (!routeConfig) {
        return window.ApprovalRouting.buildChain(employeeCode);
      }

      const stepRows = (routeConfig[RCF.ROUTE_STEPS]?.value ?? [])
        .slice() // 不動快取記錄
        .sort((a, b) => Number(cell(a, RSF.STEP_NO, 0)) - Number(cell(b, RSF.STEP_NO, 0)));

      if (stepRows.length === 0) {
        return { ok: false, chain: [], error: `表單 ${formAppId} 的路由設定沒有任何關卡` };
      }

      // 2. 逐段展開
      const visited = new Set();                 // 跨段共用，偵測跨段循環
      const steps = [];                          // { role, signingModeOverride }
      let entryRoleId;                           // undefined = 尚未查詢（惰性）
      // 員工鏈段的續接游標，三種狀態要分得清楚：
      //   undefined = 還沒有任何員工鏈段 → 下一個員工鏈段從申請人起點開始
      //   string    = 前一段結束後的「下一關」→ 續接
      //   null      = 前一段已走到簽核鏈終點 → 後面不該再有員工鏈段（設定錯誤）
      // 用 `?? 起點` 併掉 null 會讓它默默回頭重走申請人的鏈，撞上 visited 後
      // 報成「偵測到循環」，維護者會往完全錯的方向查。
      let personalCursor;

      const resolveEntry = async () => {
        if (entryRoleId === undefined) entryRoleId = await getEntryRoleId(employeeCode);
        return entryRoleId;
      };

      for (let i = 0; i < stepRows.length; i++) {
        const row = stepRows[i];
        const segType = cell(row, RSF.SEGMENT_TYPE);
        const rawMode = cell(row, RSF.STEP_SIGNING_MODE);
        const override = toSigningOverride(rawMode);
        const stepLabel = `第 ${i + 1} 段`;

        if (segType === SEG.EMPLOYEE_CHAIN) {
          // 「全員會簽」的位置必須固定，員工鏈段位置浮動 → 產生器無法生成對應的 ALL 狀態（docs/06 §5.4）
          if (rawMode === SSM.ALL) {
            return { ok: false, chain: [], error: `${stepLabel}（員工鏈段）不可指定「全員會簽」，該模式僅限指定角色段` };
          }

          const isEntrySegment = personalCursor === undefined;

          if (!isEntrySegment && personalCursor === null) {
            return {
              ok: false, chain: [],
              error: `${stepLabel}（員工鏈段）：前面的員工鏈段已走到簽核鏈終點，後面不能再接員工鏈段。` +
                     `請改用指定角色段，或調整前一段的「簽到職稱為止」。`,
            };
          }

          const start = isEntrySegment ? await resolveEntry() : personalCursor;
          if (!start) {
            return { ok: false, chain: [], error: `員工 ${employeeCode} 未設定起點角色` };
          }

          const stopAt = cell(row, RSF.STOP_AT_TITLE_LEVEL) || null;
          const skip = cell(row, RSF.SKIP_TITLE_LEVELS, []) || [];

          const seg = await walkSegment({
            startRoleId: start, visited,
            stopAtTitleLevel: stopAt, skipTitleLevels: skip,
            isEntrySegment,
          });
          if (!seg.ok) {
            return { ok: false, chain: [], error: `${stepLabel}：${seg.error}` };
          }

          for (const role of seg.roleRecords) {
            steps.push({ role, signingModeOverride: override });
          }
          personalCursor = seg.nextRoleId;

        } else if (segType === SEG.FIXED_ROLE) {
          const roleId = cell(row, RSF.ROLE_ID);
          if (!roleId) {
            return { ok: false, chain: [], error: `${stepLabel}（指定角色段）未指定角色` };
          }
          if (visited.has(roleId)) {
            return { ok: false, chain: [], error: `${stepLabel}：角色 ${roleId} 在路由中重複出現（跨段循環）` };
          }

          const role = await getRole(roleId);
          if (!role) {
            return { ok: false, chain: [], error: `${stepLabel}：指定角色 ${roleId} 不存在或未啟用` };
          }

          visited.add(roleId);
          steps.push({ role, signingModeOverride: override });

        } else {
          return { ok: false, chain: [], error: `${stepLabel}：未知的段類型「${segType}」` };
        }
      }

      if (steps.length === 0) {
        return { ok: false, chain: [], error: `表單 ${formAppId} 的路由展開後沒有任何簽核關卡，請檢查 stop_at_title_level 設定` };
      }

      // 3. 解析 holder → 擋空簽核者 → 組裝子表格（複用 03 的 finalizeChain）
      return finalizeChain(steps);

    } catch (err) {
      return { ok: false, chain: [], error: err.message ?? String(err) };
    }
  };

  /**
   * 建構目前登入使用者在指定表單的簽核鏈
   * @param {number|string} formAppId
   * @param {Object} [options] - 同 buildChainForForm
   */
  const buildChainForFormCurrentUser = (formAppId, options) =>
    buildChainForForm(kintone.getLoginUser().code, formAppId, options);

  // -------------------------------------------------------------------
  // 掛到全域
  // -------------------------------------------------------------------
  window.ApprovalRouting = window.ApprovalRouting || {};
  window.ApprovalRouting.buildChainForForm = buildChainForForm;
  window.ApprovalRouting.RouteEngine = Object.freeze({
    buildChainForForm,
    buildChainForFormCurrentUser,
  });
})();
