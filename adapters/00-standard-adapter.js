/**
 * 標準 adapter（P8 Phase D）— 一支 JS 掛在所有申請 App 上
 *
 * 新表單接入 = 建一筆 form_route_config + 埋 4 個規約欄位 + 掛這支 + 跑一次產生器。
 * 本檔完全不認得任何特定表單：走哪條鏈由路由表決定，簽核者是誰由角色表決定。
 *
 * 【三個掛載點】
 *   1. submit      在「草稿」重算簽核鏈，寫入子表格 + total_steps + current_approvers
 *   2. process.proceed  依 nextStatus 推進 current_step、best-effort 寫下一關執行者
 *   3. detail.show      安全網：實際執行者與應簽的人不一致時，用「更新執行者 API」補正
 *
 * 【影響的欄位】（每個申請 App 都要埋，見 Config.ADAPTER_FIELDS）
 *   - approver_chain    子表格：簽核鏈快照（含 expected_signers / signing_mode / signed_by）
 *   - current_approvers 使用者選擇（多選）：目前這關該簽的人。原生流程「指定欄位」的來源
 *   - current_step      數值：目前第幾關。0＝尚未進入簽核（草稿／駁回）
 *   - total_steps       數值：鏈總長，供狀態轉移的 filterCond 分流（docs/06 §5.2）
 *
 * 【依賴】
 *   - core/01-config.js（Config：ADAPTER_FIELDS / CHAIN_FIELDS / STATUS_TEMPLATE / ACTION_TEMPLATE）
 *   - core/02-api-client.js（ApiClient：getRole / getRouteConfig）
 *   - core/03-chain-builder.js（Engine：resolveHolders）
 *   - core/04-utils.js（Utils）
 *   - core/06-route-engine.js（buildChainForForm）
 *
 * 【兩個查證過、會決定行為對錯的 kintone 事實】
 *   1. **全員會簽時 proceed 會在狀態不變的情況下觸發**（每個人按一次都觸發，
 *      直到最後一人才換狀態）。所以推進 current_step 必須由 `event.nextStatus` 決定，
 *      不能看「動作被觸發了」——後者會讓會簽關卡每有一人簽名就跳一關。
 *   2. **執行者＝「指定欄位」時，kintone 用「按鈕按下前」的欄位值解析執行者**。
 *      所以 proceed 內寫 current_approvers 是 best-effort，權威機制是
 *      `PUT /k/v1/record/assignees`（detail.show 安全網呼叫）。詳見 docs/06 §5.3。
 *
 * 【變更履歷】
 *   2026-09-01  Jimmy/Claude  初版（P8 Phase D）
 */
(() => {
  'use strict';

  const {
    ADAPTER_FIELDS: AF,
    CHAIN_FIELDS: CF,
    ROUTE_FIELDS: RTF,
    STATUS_TEMPLATE: TPL,
    ACTION_TEMPLATE: ACT,
  } = window.ApprovalRouting.Config;

  const { getRole, getRouteConfig } = window.ApprovalRouting.ApiClient;
  const { safeHandler, kintoneApi, showWarning } = window.ApprovalRouting.Utils;

  /** 自動補正的重試上限：連續補正失敗代表有別的問題，不要無限重整頁面 */
  const MAX_AUTO_FIX = 2;

  // -------------------------------------------------------------------
  // 純函式：狀態與記錄的解讀（可測，無 I/O）
  // -------------------------------------------------------------------

  /**
   * 找出內建欄位（狀態、執行者）。**用型別找不用欄位代碼找**——
   * 內建欄位的代碼隨 kintone 語言設定而異（狀態／ステータス／Status），
   * 寫死任何一個都會在別的語言環境靜默失效。
   * @param {Object} record
   * @param {string} type - 'STATUS' | 'STATUS_ASSIGNEE'
   * @returns {Object|null} 欄位物件
   */
  const findBuiltIn = (record, type) => {
    for (const key of Object.keys(record ?? {})) {
      if (record[key]?.type === type) return record[key];
    }
    return null;
  };

  /** 這個 App 有沒有埋齊規約欄位。缺欄位就整支停用，不要半殘地跑 */
  const hasAdapterFields = (record) =>
    Object.values(AF).every((code) => record?.[code] !== undefined);

  /**
   * 決定 proceed 之後記錄該長什麼樣
   *
   * 純函式：把「狀態怎麼變」翻譯成「current_step 與執行者該是什麼」，
   * 不碰 API、不碰 DOM，所有分支都測得到。
   *
   * @param {Object} p
   * @param {string} p.fromStatus
   * @param {string} p.toStatus
   * @param {number} p.currentStep - 記錄上目前的 current_step
   * @param {number} p.totalSteps
   * @returns {{
   *   kind: 'stay'|'advance'|'terminal'|'reset'|'blocked',
   *   nextStep: number|null,      // 要寫進 current_step 的值；null＝不動
   *   approverStep: number|null,  // 要解析第幾關的簽核者當執行者；null＝清空
   *   error: string|null
   * }}
   */
  const planProceed = ({ fromStatus, toStatus, currentStep, totalSteps }) => {
    // 全員會簽尚未簽完：kintone 會在狀態不變的情況下觸發 proceed。
    // 這時只記錄簽名，絕不推進——推進了會讓會簽關卡每有一人簽就跳一關。
    if (fromStatus === toStatus) {
      return { kind: 'stay', nextStep: null, approverStep: null, error: null };
    }

    const fromStep = TPL.parseApproving(fromStatus);
    const toStep = TPL.parseApproving(toStatus);

    // 併發防護：兩個「任一人簽」的簽核者同時按核准時，慢的那個記錄上的
    // current_step 已經被快的那個推走了。currentStep 為 0 視為「還沒被設定過」
    // （adapter 上線前就存在的舊單），不擋，讓它順勢補上。
    if (fromStep !== null && currentStep !== 0 && currentStep !== fromStep) {
      return {
        kind: 'blocked', nextStep: null, approverStep: null,
        error: `這張單已經被其他簽核者處理過了（目前在第 ${currentStep} 關，你看到的是第 ${fromStep} 關）。請重新整理頁面確認最新狀態。`,
      };
    }

    if (toStep !== null) {
      return { kind: 'advance', nextStep: toStep, approverStep: toStep, error: null };
    }

    // 回到草稿（再申請）或被駁回：執行者由狀態設定決定（申請人），欄位清空
    if (toStatus === TPL.DRAFT || toStatus === TPL.REJECTED) {
      return { kind: 'reset', nextStep: 0, approverStep: null, error: null };
    }

    // 終態（核准／作廢）：關卡指標停在最後簽過的那一關，執行者清空
    return {
      kind: 'terminal',
      nextStep: toStatus === TPL.APPROVED ? (totalSteps || fromStep || 0) : (fromStep ?? currentStep),
      approverStep: null,
      error: null,
    };
  };

  /**
   * 比較兩組使用者代碼是不是同一組人（順序無關）
   * @param {string[]} a
   * @param {string[]} b
   */
  const sameMembers = (a, b) => {
    if (a.length !== b.length) return false;
    const s = new Set(a);
    return b.every((c) => s.has(c));
  };

  /** 取子表格第 n 關（1-based）的列 */
  const chainRow = (record, n) =>
    (record?.[AF.APPROVER_CHAIN]?.value ?? [])[n - 1] ?? null;

  // -------------------------------------------------------------------
  // 即時解析
  // -------------------------------------------------------------------

  /**
   * 解析第 n 關「現在」該是誰簽
   *
   * 走角色表即時解析，不用子表格裡的 expected_signers 快照——
   * 「跑到那一關才解析」是本專案存在的理由（見對話脈絡 §二、§四）：
   * IT 改了群組成員、HR 換了角色上的人，在途單跑到那關要拿到新的人。
   *
   * @param {Object} record
   * @param {number} n - 1-based 關卡序
   * @returns {Promise<{ok: boolean, holders: string[], error: string|null}>}
   */
  const resolveStepApprovers = async (record, n) => {
    const row = chainRow(record, n);
    if (!row) return { ok: false, holders: [], error: `簽核鏈上沒有第 ${n} 關` };

    const roleId = row.value?.[CF.ROLE_ID]?.value;
    if (!roleId) return { ok: false, holders: [], error: `第 ${n} 關沒有記錄角色代碼` };

    const role = await getRole(roleId);
    if (!role) return { ok: false, holders: [], error: `第 ${n} 關的角色（${roleId}）已不存在或未啟用` };

    const holders = await window.ApprovalRouting.Engine.resolveHolders(role);
    if (holders.length === 0) {
      const name = row.value?.[CF.STEP_NAME]?.value || roleId;
      return { ok: false, holders: [], error: `第 ${n} 關「${name}」目前沒有任何簽核者，請聯絡 HR` };
    }
    return { ok: true, holders, error: null };
  };

  const toUserValue = (codes) => codes.map((code) => ({ code }));

  // -------------------------------------------------------------------
  // 1. submit — 在草稿重算簽核鏈
  // -------------------------------------------------------------------

  kintone.events.on(
    ['app.record.create.submit', 'app.record.edit.submit',
     'mobile.app.record.create.submit', 'mobile.app.record.edit.submit'],
    safeHandler(async (event) => {
      const rec = event.record;
      if (!hasAdapterFields(rec)) {
        console.warn('[ApprovalRouting] 這個 App 沒有埋齊 adapter 規約欄位，adapter 停用。需要：', Object.values(AF));
        return event;
      }

      // 只在草稿重算。已經在跑的單子重算會讓鏈跟已經簽過的關卡對不上
      const status = findBuiltIn(rec, 'STATUS')?.value;
      if (status && status !== TPL.DRAFT) return event;

      const appId = kintone.app.getId() ?? kintone.mobile.app.getId();
      const applicant = kintone.getLoginUser().code;

      // forceFresh：這是正式送出，不能用可能過期的快取
      const { ok, chain, error } = await window.ApprovalRouting.buildChainForForm(
        applicant, appId, { forceFresh: true }
      );

      if (!ok) {
        event.error = `無法建立簽核鏈：${error}`;
        await showWarning('無法建立簽核鏈', `${error}\n\n請聯絡 HR 或 IT 確認角色設定。`);
        return event;
      }

      // 鏈比已部署的狀態數還長 → 單子會卡在最後一關出不去。
      // 這在組織長高之後一定會發生（多一層主管就多一關），擋在送出當下，
      // 比讓使用者送出後卡住、再回頭查為什麼好得多。
      const routeConfig = await getRouteConfig(appId);
      const maxDepth = Number(routeConfig?.[RTF.MAX_DEPTH]?.value || 0);
      if (maxDepth > 0 && chain.length > maxDepth) {
        const msg =
          `這張單需要 ${chain.length} 關簽核，但目前流程只部署到 ${maxDepth} 關，送出後會卡在最後一關。\n` +
          `請 IT 到表單路由設定表重新執行「產生流程設定」後再送出。`;
        event.error = msg;
        await showWarning('簽核關卡數超過已部署的流程', msg);
        return event;
      }

      rec[AF.APPROVER_CHAIN].value = chain;
      rec[AF.TOTAL_STEPS].value = String(chain.length);
      // 0＝還沒進簽核。送出動作（草稿→簽核中(1)）才會把它推到 1
      rec[AF.CURRENT_STEP].value = '0';
      // 先把第 1 關的人放好：kintone 解析「指定欄位」執行者時讀的是按鈕按下**前**
      // 的欄位值，所以送出鈕按下時這裡必須已經是第 1 關的簽核者
      rec[AF.CURRENT_APPROVERS].value = chain[0][CF.EXPECTED_SIGNERS].value;

      return event;
    })
  );

  // -------------------------------------------------------------------
  // 2. process.proceed — 依 nextStatus 推進
  // -------------------------------------------------------------------

  kintone.events.on(
    ['app.record.detail.process.proceed', 'mobile.app.record.detail.process.proceed'],
    safeHandler(async (event) => {
      const rec = event.record;
      if (!hasAdapterFields(rec)) return event;

      const fromStatus = event.status?.value ?? '';
      const toStatus = event.nextStatus?.value ?? '';
      const currentStep = Number(rec[AF.CURRENT_STEP]?.value || 0);
      const totalSteps = Number(rec[AF.TOTAL_STEPS]?.value || 0);

      const plan = planProceed({ fromStatus, toStatus, currentStep, totalSteps });

      if (plan.kind === 'blocked') {
        event.error = plan.error;
        return event;
      }

      // 記下是誰簽的。全員會簽時每個人各觸發一次 proceed，這裡會逐一累加
      if (event.action?.value === ACT.APPROVE) {
        const signedStep = TPL.parseApproving(fromStatus);
        const row = signedStep === null ? null : chainRow(rec, signedStep);
        if (row?.value?.[CF.SIGNED_BY]) {
          const actor = kintone.getLoginUser().code;
          const already = (row.value[CF.SIGNED_BY].value ?? []).map((u) => u.code);
          if (!already.includes(actor)) {
            row.value[CF.SIGNED_BY].value = toUserValue([...already, actor]);
          }
          row.value[CF.SIGNED_AT].value = new Date().toISOString();
        }
      }

      // 全員會簽尚未簽完：只留簽名，不推進
      if (plan.kind === 'stay') return event;

      if (plan.nextStep !== null) rec[AF.CURRENT_STEP].value = String(plan.nextStep);

      if (plan.approverStep === null) {
        rec[AF.CURRENT_APPROVERS].value = [];
        return event;
      }

      // best-effort：多數情況這個寫入會被採用；被吃掉時由 detail.show 安全網補正
      const resolved = await resolveStepApprovers(rec, plan.approverStep);
      if (!resolved.ok) {
        event.error = `無法決定下一關的簽核者：${resolved.error}`;
        return event;
      }
      rec[AF.CURRENT_APPROVERS].value = toUserValue(resolved.holders);

      return event;
    })
  );

  // -------------------------------------------------------------------
  // 3. detail.show — 安全網：用「更新執行者 API」補正
  // -------------------------------------------------------------------

  /** 這筆記錄這輪已經自動補正幾次（跨頁面重整用 sessionStorage 記） */
  const fixCountKey = (appId, recordId) => `ar-assignee-fix-${appId}-${recordId}`;

  const bumpFixCount = (appId, recordId) => {
    try {
      const key = fixCountKey(appId, recordId);
      const n = Number(sessionStorage.getItem(key) || 0) + 1;
      sessionStorage.setItem(key, String(n));
      return n;
    } catch (_) {
      return 1; // 無痕模式等取不到 sessionStorage：允許補正，但失去循環保護
    }
  };

  const clearFixCount = (appId, recordId) => {
    try { sessionStorage.removeItem(fixCountKey(appId, recordId)); } catch (_) { /* 忽略 */ }
  };

  kintone.events.on(
    ['app.record.detail.show', 'mobile.app.record.detail.show'],
    safeHandler(async (event) => {
      const rec = event.record;
      if (!hasAdapterFields(rec)) return event;

      const appId = event.appId ?? kintone.app.getId();
      const recordId = rec.$id?.value;

      const status = findBuiltIn(rec, 'STATUS')?.value;
      const step = TPL.parseApproving(status);
      if (step === null) {
        // 不在簽核中（草稿／核准／駁回／作廢）→ 沒有要補正的執行者
        clearFixCount(appId, recordId);
        return event;
      }

      const assigneeField = findBuiltIn(rec, 'STATUS_ASSIGNEE');
      const actual = (assigneeField?.value ?? []).map((u) => u.code);

      const resolved = await resolveStepApprovers(rec, step);
      if (!resolved.ok) {
        console.warn('[ApprovalRouting] 安全網無法解析執行者：', resolved.error);
        return event;
      }

      if (sameMembers(actual, resolved.holders)) {
        clearFixCount(appId, recordId); // 一致就重置計數，之後真的出問題還有額度
        return event;
      }

      const tries = bumpFixCount(appId, recordId);
      if (tries > MAX_AUTO_FIX) {
        console.warn('[ApprovalRouting] 執行者補正已連續失敗，停止自動補正以免無限重整。');
        await showWarning(
          '這張單的執行者可能不正確',
          `系統偵測到目前的執行者與應簽的人不一致，自動補正沒有成功。\n` +
          `應簽：${resolved.holders.join('、')}\n請聯絡 IT 協助。`
        );
        return event;
      }

      // 帶 revision：兩個「任一人簽」的簽核者同時開頁面時，只有一個會成功，
      // 另一個拿到衝突就重讀重試一次
      const fixed = await updateAssigneesWithRetry(appId, recordId, resolved.holders, rec.$revision?.value);
      if (!fixed.ok) {
        console.warn('[ApprovalRouting] 更新執行者 API 失敗：', fixed.error);
        return event;
      }

      // 欄位鏡像同步（顯示用 + 原生流程的 fallback 來源）
      try {
        await kintoneApi('/k/v1/record', 'PUT', {
          app: appId, id: recordId,
          record: { [AF.CURRENT_APPROVERS]: { value: toUserValue(resolved.holders) } },
        });
      } catch (err) {
        console.warn('[ApprovalRouting] current_approvers 鏡像同步失敗（執行者本身已更新）：', err?.message || err);
      }

      // 執行者是在頁面載入時由伺服器算出來的，不重整的話正確的人看不到按鈕。
      // 補正成功後下一次載入會比對一致、不再重整，天然收斂。
      location.reload();
      return event;
    })
  );

  /**
   * 呼叫更新執行者 API，revision 衝突時重讀重試一次
   * @param {number|string} appId
   * @param {string} recordId
   * @param {string[]} assignees
   * @param {string} revision
   */
  const updateAssigneesWithRetry = async (appId, recordId, assignees, revision) => {
    const call = (rev) =>
      kintoneApi('/k/v1/record/assignees', 'PUT', {
        app: appId, id: recordId, assignees,
        ...(rev ? { revision: rev } : {}),
      });

    try {
      await call(revision);
      return { ok: true, error: null };
    } catch (err) {
      try {
        // 重讀最新 revision 再試一次；第二次仍失敗就放棄，交給下一次載入
        const fresh = await kintoneApi('/k/v1/record', 'GET', { app: appId, id: recordId });
        await call(fresh.record?.$revision?.value);
        return { ok: true, error: null };
      } catch (err2) {
        return { ok: false, error: err2?.message || String(err2) };
      }
    }
  };

  // 供測試（純函式部分）
  window.ApprovalRouting = window.ApprovalRouting || {};
  window.ApprovalRouting.AdapterInternals = Object.freeze({
    planProceed,
    findBuiltIn,
    hasAdapterFields,
    sameMembers,
    chainRow,
  });
})();
