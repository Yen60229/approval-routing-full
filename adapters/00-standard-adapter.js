/**
 * 標準 adapter（P8 Phase D）— 一支 JS 掛在所有申請 App 上
 *
 * 新表單接入 = 建一筆 form_route_config + 埋 6 個規約欄位 + 掛這支 + 跑一次部署。
 * 本檔完全不認得任何特定表單：走哪條鏈由路由表決定，簽核者是誰由角色表決定。
 *
 * 【三個掛載點】
 *   1. submit           在「草稿」重算簽核鏈，寫入子表格與四個指標欄位
 *   2. process.proceed  推進 current_step、算出下一站、best-effort 寫執行者
 *   3. detail.show      安全網：實際執行者與應簽的人不一致時，用「更新執行者 API」補正
 *
 * 【影響的欄位】（每個申請 App 都要埋，見 Config.ADAPTER_FIELDS）
 *   - approver_chain    子表格：簽核鏈快照（含 expected_signers / signing_mode / step_state / signed_by）
 *   - current_approvers 使用者選擇（多選）：目前這關該簽的人。原生流程「指定欄位」的來源
 *   - current_step      數值：目前第幾關。0＝尚未進入簽核（草稿／駁回）
 *   - total_steps       數值：鏈總長，顯示「第 3 / 5 關」用
 *   - next_state        文字：按下「同意」之後要去哪個狀態 ← 狀態轉移的 filterCond 讀它
 *   - reject_state      文字：按下「駁回」之後要去哪個狀態 ← 同上
 *
 * 【為什麼需要 next_state / reject_state】
 * 狀態不再編號（固定 7 個，靠自迴圈跑完任意長度的鏈），所以光看「簽核中」
 * 無從得知下一站是主管、經辦、會簽還是已簽完。由 adapter 先算好寫進欄位，
 * kintone 的 filterCond 讀它決定往哪走。
 *
 * 【依賴】
 *   - core/01-config.js（Config）
 *   - core/02-api-client.js（ApiClient.getRole）
 *   - core/03-chain-builder.js（Engine.resolveHolders）
 *   - core/04-utils.js（Utils）
 *   - core/06-route-engine.js（buildChainForForm）
 *
 * 【兩個查證過、會決定行為對錯的 kintone 事實】
 *   1. **全員會簽時 proceed 會在狀態不變的情況下觸發**（每個人按一次都觸發，
 *      直到最後一人才換狀態）。而自迴圈讓「狀態不變」也可能是正常推進，
 *      兩者無法用狀態分辨 → 改用「簽名是否已覆蓋所有執行者」判定，見 isFinalSignature。
 *   2. **執行者＝「指定欄位」時，kintone 用「按鈕按下前」的欄位值解析執行者**。
 *      所以 proceed 內寫 current_approvers 是 best-effort，權威機制是
 *      `PUT /k/v1/record/assignees`（detail.show 安全網呼叫）。詳見 docs/06 §5.3。
 *
 * 【變更履歷】
 *   2026-09-01  Jimmy/Claude  初版（P8 Phase D，簽核中(1..K) 編號模型）
 *   2026-09-01  Jimmy/Claude  改為固定狀態 + 自迴圈模型：current_step 成為唯一的關卡真相
 *                              （狀態名不再帶關卡序），新增 next_state / reject_state 兩個
 *                              給 filterCond 讀的欄位，會簽完成與否改用 signed_by 覆蓋率判定
 */
(() => {
  'use strict';

  const {
    ADAPTER_FIELDS: AF,
    CHAIN_FIELDS: CF,
    ROUTE_FIELDS: RTF,
    STATUS_TEMPLATE: ST,
    APPROVING_STATES,
    ACTION_TEMPLATE: ACT,
    SIGNING_MODE_OPTIONS: SM,
    REJECT_TARGET_OPTIONS: RT,
  } = window.ApprovalRouting.Config;

  const { getRole, getRouteConfig } = window.ApprovalRouting.ApiClient;
  const { safeHandler, kintoneApi, showWarning } = window.ApprovalRouting.Utils;

  /** 自動補正的重試上限：連續補正失敗代表有別的問題，不要無限重整頁面 */
  const MAX_AUTO_FIX = 2;

  // -------------------------------------------------------------------
  // 純函式：記錄的解讀（可測，無 I/O）
  // -------------------------------------------------------------------

  /**
   * 找出內建欄位（狀態、執行者）。**用型別找不用欄位代碼找**——
   * 內建欄位的代碼隨 kintone 語言設定而異（狀態／ステータス／Status），
   * 寫死任何一個都會在別的語言環境靜默失效。
   * @param {Object} record
   * @param {string} type - 'STATUS' | 'STATUS_ASSIGNEE'
   * @returns {Object|null}
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

  /** 取子表格第 n 關（1-based）的列 */
  const chainRow = (record, n) =>
    (record?.[AF.APPROVER_CHAIN]?.value ?? [])[n - 1] ?? null;

  const chainLength = (record) => (record?.[AF.APPROVER_CHAIN]?.value ?? []).length;

  /** 比較兩組使用者代碼是不是同一組人（順序無關） */
  const sameMembers = (a, b) => {
    if (a.length !== b.length) return false;
    const s = new Set(a);
    return b.every((c) => s.has(c));
  };

  /**
   * 按下「同意」之後要去的狀態：下一關的 step_state，沒有下一關就是「核決」
   * @param {Object[]} chain - approver_chain 的 value 陣列
   * @param {number} step - 目前第幾關（1-based）
   */
  const nextStateAfter = (chain, step) =>
    step < chain.length ? (chain[step]?.value?.[CF.STEP_STATE]?.value || ST.APPROVING) : ST.DECIDED;

  /**
   * 按下「駁回」之後要去的狀態
   * 退回上一關且已有上一關 → 上一關的 step_state；否則回「駁回」（上一關就是申請人本人）
   */
  const rejectStateAt = (chain, step, rejectTarget) => {
    if (rejectTarget === RT.PREV_STEP && step > 1) {
      return chain[step - 2]?.value?.[CF.STEP_STATE]?.value || ST.APPROVING;
    }
    return ST.REJECTED;
  };

  /**
   * 這一次「同意」是不是該關的最後一個簽名
   *
   * 自迴圈帶來的歧義：`會簽中 → 會簽中` 可能是「會簽還沒簽完」，也可能是
   * 「這一關簽完了，而下一關剛好也是會簽」——兩者的狀態轉移一模一樣，
   * 分辨不了。所以不看狀態，看**簽名是否已覆蓋所有執行者**。
   *
   * 任一人簽的關卡永遠是 true（一個人按下去就結束）。
   *
   * @param {Object} row - 該關的子表格列
   * @param {string[]} assignees - 目前記錄上的實際執行者
   * @param {string} actor - 這次按下按鈕的人
   */
  const isFinalSignature = (row, assignees, actor) => {
    if ((row?.value?.[CF.SIGNING_MODE]?.value || SM.ANY) !== SM.ALL) return true;
    const signed = new Set((row?.value?.[CF.SIGNED_BY]?.value ?? []).map((u) => u.code));
    signed.add(actor);
    // 執行者名單取不到時保守處理：當成還沒簽完，寧可停著也不要跳關
    if (assignees.length === 0) return false;
    return assignees.every((code) => signed.has(code));
  };

  /**
   * 決定 proceed 之後 current_step 該是多少
   *
   * 純函式：把「按了什麼」翻譯成「關卡指標怎麼動」，不碰 API、不碰 DOM。
   * **不看狀態名**——固定狀態模型下狀態名不帶關卡序，current_step 才是唯一真相。
   *
   * @param {Object} p
   * @param {string} p.action        event.action.value
   * @param {number} p.currentStep   記錄上目前的 current_step
   * @param {number} p.chainLen      鏈總長
   * @param {boolean} p.finalSignature  這次是不是該關的最後一個簽名
   * @param {string} p.rejectTarget  路由表的 reject_target
   * @returns {{ kind: 'stay'|'advance'|'reset'|'terminal'|'blocked', nextStep: number, error: string|null }}
   */
  const planProceed = ({ action, currentStep, chainLen, finalSignature, rejectTarget }) => {
    const stay = { kind: 'stay', nextStep: currentStep, error: null };

    if (action === ACT.SUBMIT) {
      return { kind: 'advance', nextStep: 1, error: null };
    }

    if (action === ACT.REAPPLY) {
      return { kind: 'reset', nextStep: 0, error: null };
    }

    if (action === ACT.CANCEL) {
      return { kind: 'terminal', nextStep: currentStep, error: null };
    }

    if (action === ACT.REJECT) {
      const back = rejectTarget === RT.PREV_STEP && currentStep > 1 ? currentStep - 1 : 0;
      return { kind: back > 0 ? 'advance' : 'reset', nextStep: back, error: null };
    }

    if (action === ACT.APPROVE) {
      if (currentStep < 1 || currentStep > chainLen) {
        return {
          kind: 'blocked', nextStep: currentStep,
          error: `簽核鏈的關卡指標異常（目前 ${currentStep}，鏈長 ${chainLen}）。請重新整理頁面；若持續發生請聯絡 IT。`,
        };
      }
      // 全員會簽尚未簽完：只記簽名，不推進
      if (!finalSignature) return stay;
      return currentStep >= chainLen
        ? { kind: 'terminal', nextStep: chainLen, error: null }
        : { kind: 'advance', nextStep: currentStep + 1, error: null };
    }

    // 不認得的動作（各表單自訂的）：不干預
    return stay;
  };

  // -------------------------------------------------------------------
  // 即時解析
  // -------------------------------------------------------------------

  /**
   * 解析第 n 關「現在」該是誰簽
   *
   * 走角色表即時解析，不用子表格裡的 expected_signers 快照——
   * 「跑到那一關才解析」是本專案存在的理由（見對話脈絡 §二、§四）：
   * IT 改了群組成員、HR 換了角色上的人，在途單跑到那關要拿到新的人。
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

  /** 取該申請 App 的 reject_target 設定（查不到時預設退回申請人） */
  const getRejectTarget = async (appId) => {
    try {
      const cfg = await getRouteConfig(appId);
      return cfg?.[RTF.REJECT_TARGET]?.value || RT.APPLICANT;
    } catch (_) {
      return RT.APPLICANT;
    }
  };

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
      if (status && status !== ST.DRAFT) return event;

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

      rec[AF.APPROVER_CHAIN].value = chain;
      rec[AF.TOTAL_STEPS].value = String(chain.length);
      // 0＝還沒進簽核。送出動作（草稿→第 1 關）才會把它推到 1
      rec[AF.CURRENT_STEP].value = '0';
      // 先把第 1 關的人與去向放好：kintone 解析「指定欄位」執行者、以及動作的 filterCond，
      // 讀的都是按鈕按下**前**的欄位值，所以送出鈕按下時這些必須已經是第 1 關的內容
      rec[AF.CURRENT_APPROVERS].value = chain[0][CF.EXPECTED_SIGNERS].value;
      rec[AF.NEXT_STATE].value = chain[0][CF.STEP_STATE].value;
      rec[AF.REJECT_STATE].value = ST.REJECTED;

      return event;
    })
  );

  // -------------------------------------------------------------------
  // 2. process.proceed — 推進關卡指標並算出下一站
  // -------------------------------------------------------------------

  kintone.events.on(
    ['app.record.detail.process.proceed', 'mobile.app.record.detail.process.proceed'],
    safeHandler(async (event) => {
      const rec = event.record;
      if (!hasAdapterFields(rec)) return event;

      const appId = event.appId ?? kintone.app.getId();
      const action = event.action?.value ?? '';
      const currentStep = Number(rec[AF.CURRENT_STEP]?.value || 0);
      const chain = rec[AF.APPROVER_CHAIN]?.value ?? [];
      const actor = kintone.getLoginUser().code;
      const assignees = (findBuiltIn(rec, 'STATUS_ASSIGNEE')?.value ?? []).map((u) => u.code);

      const row = chainRow(rec, currentStep);
      const finalSignature = action === ACT.APPROVE ? isFinalSignature(row, assignees, actor) : true;

      const rejectTarget = await getRejectTarget(appId);
      const plan = planProceed({
        action, currentStep, chainLen: chain.length, finalSignature, rejectTarget,
      });

      if (plan.kind === 'blocked') {
        event.error = plan.error;
        return event;
      }

      // 記下是誰簽的。全員會簽時每個人各觸發一次 proceed，這裡會逐一累加
      if (action === ACT.APPROVE && row?.value?.[CF.SIGNED_BY]) {
        const already = (row.value[CF.SIGNED_BY].value ?? []).map((u) => u.code);
        if (!already.includes(actor)) {
          row.value[CF.SIGNED_BY].value = toUserValue([...already, actor]);
        }
        row.value[CF.SIGNED_AT].value = new Date().toISOString();
      }

      // 會簽未完成：只留簽名，指標與去向都不動
      if (plan.kind === 'stay') return event;

      rec[AF.CURRENT_STEP].value = String(plan.nextStep);

      // 終態（核決／作廢）或退出簽核（駁回到申請人／再申請）：沒有下一關要指
      if (plan.kind === 'terminal' || plan.nextStep < 1) {
        rec[AF.CURRENT_APPROVERS].value = [];
        rec[AF.NEXT_STATE].value = '';
        rec[AF.REJECT_STATE].value = ST.REJECTED;
        return event;
      }

      // 寫下一關的執行者與去向。best-effort：被吃掉時由 detail.show 安全網補正
      const resolved = await resolveStepApprovers(rec, plan.nextStep);
      if (!resolved.ok) {
        event.error = `無法決定下一關的簽核者：${resolved.error}`;
        return event;
      }
      rec[AF.CURRENT_APPROVERS].value = toUserValue(resolved.holders);
      rec[AF.NEXT_STATE].value = nextStateAfter(chain, plan.nextStep);
      rec[AF.REJECT_STATE].value = rejectStateAt(chain, plan.nextStep, rejectTarget);

      return event;
    })
  );

  // -------------------------------------------------------------------
  // 3. detail.show — 安全網：用「更新執行者 API」補正
  // -------------------------------------------------------------------

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

  /**
   * 呼叫更新執行者 API，revision 衝突時重讀重試一次
   */
  const updateAssigneesWithRetry = async (appId, recordId, assignees, revision) => {
    const call = (rev) =>
      kintoneApi('/k/v1/record/assignees.json', 'PUT', {
        app: appId, id: recordId, assignees,
        ...(rev ? { revision: rev } : {}),
      });

    try {
      await call(revision);
      return { ok: true, error: null };
    } catch (err) {
      try {
        const fresh = await kintoneApi('/k/v1/record.json', 'GET', { app: appId, id: recordId });
        await call(fresh.record?.$revision?.value);
        return { ok: true, error: null };
      } catch (err2) {
        return { ok: false, error: err2?.message || String(err2) };
      }
    }
  };

  kintone.events.on(
    ['app.record.detail.show', 'mobile.app.record.detail.show'],
    safeHandler(async (event) => {
      const rec = event.record;
      if (!hasAdapterFields(rec)) return event;

      const appId = event.appId ?? kintone.app.getId();
      const recordId = rec.$id?.value;

      const status = findBuiltIn(rec, 'STATUS')?.value;
      const step = Number(rec[AF.CURRENT_STEP]?.value || 0);

      // 不在簽核狀態（草稿／駁回／核決／作廢）→ 沒有要補正的執行者
      if (!APPROVING_STATES.includes(status) || step < 1 || step > chainLength(rec)) {
        clearFixCount(appId, recordId);
        return event;
      }

      const actual = (findBuiltIn(rec, 'STATUS_ASSIGNEE')?.value ?? []).map((u) => u.code);

      const resolved = await resolveStepApprovers(rec, step);
      if (!resolved.ok) {
        console.warn('[ApprovalRouting] 安全網無法解析執行者：', resolved.error);
        return event;
      }

      // 順便檢查兩個給 filterCond 讀的欄位——它們錯了，按下按鈕會走到錯的狀態
      const chain = rec[AF.APPROVER_CHAIN].value;
      const rejectTarget = await getRejectTarget(appId);
      const wantNext = nextStateAfter(chain, step);
      const wantReject = rejectStateAt(chain, step, rejectTarget);
      const routingStale =
        rec[AF.NEXT_STATE].value !== wantNext || rec[AF.REJECT_STATE].value !== wantReject;

      if (sameMembers(actual, resolved.holders) && !routingStale) {
        clearFixCount(appId, recordId); // 一致就重置計數，之後真的出問題還有額度
        return event;
      }

      const tries = bumpFixCount(appId, recordId);
      if (tries > MAX_AUTO_FIX) {
        console.warn('[ApprovalRouting] 補正已連續失敗，停止以免無限重整。');
        await showWarning(
          '這張單的簽核設定可能不正確',
          `系統偵測到目前的執行者或流程去向與應有的不一致，自動補正沒有成功。\n` +
          `應簽：${resolved.holders.join('、')}\n請聯絡 IT 協助。`
        );
        return event;
      }

      // 帶 revision：兩個簽核者同時開頁面時，只有一個會成功，另一個衝突後重讀重試
      if (!sameMembers(actual, resolved.holders)) {
        const fixed = await updateAssigneesWithRetry(appId, recordId, resolved.holders, rec.$revision?.value);
        if (!fixed.ok) {
          console.warn('[ApprovalRouting] 更新執行者 API 失敗：', fixed.error);
          return event;
        }
      }

      // 欄位鏡像同步（顯示用 + 原生流程的 fallback 來源 + filterCond 的依據）
      try {
        await kintoneApi('/k/v1/record.json', 'PUT', {
          app: appId, id: recordId,
          record: {
            [AF.CURRENT_APPROVERS]: { value: toUserValue(resolved.holders) },
            [AF.NEXT_STATE]:        { value: wantNext },
            [AF.REJECT_STATE]:      { value: wantReject },
          },
        });
      } catch (err) {
        console.warn('[ApprovalRouting] 欄位鏡像同步失敗：', err?.message || err);
      }

      // 執行者是在頁面載入時由伺服器算出來的，不重整的話正確的人看不到按鈕。
      // 補正成功後下一次載入會比對一致、不再重整，天然收斂。
      location.reload();
      return event;
    })
  );

  // 供測試（純函式部分）
  window.ApprovalRouting = window.ApprovalRouting || {};
  window.ApprovalRouting.AdapterInternals = Object.freeze({
    planProceed,
    isFinalSignature,
    nextStateAfter,
    rejectStateAt,
    findBuiltIn,
    hasAdapterFields,
    sameMembers,
    chainRow,
  });
})();
