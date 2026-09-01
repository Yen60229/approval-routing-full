/**
 * 流程管理狀態圖產生器（P8 Phase C）— 把統一的簽核流程部署到申請 App
 *
 * 掛在表單路由設定表（App 736）清單頁。管線（docs/06 §5.5）：
 *   ① GET 正式環境 status.json 備份（可下載）
 *   ② generate  ← 固定 7 狀態模板，唯一因表單而異的是「可作廢群組」
 *   ③ validate  ← from/to 存在、非終態有出路、同名動作不可都沒條件…
 *   ④ PUT /k/v1/preview/app/status.json（只寫測試環境，帶 revision）
 *   ⑤ 人工在 kintone 畫面確認
 *   ⑥ POST /k/v1/preview/app/deploy.json → 輪詢至 SUCCESS
 *   ⑦ 回寫 deployed_at / deployed_hash
 *
 * 【狀態圖為什麼可以是常數】
 * kintone 允許動作的「執行前」與「執行後」是同一個狀態（Jimmy 2026-09-01 實測確認），
 * 所以 N 關的鏈可以在同一個狀態上自迴圈 N 次，每次由 adapter 換執行者。
 * 「最大鏈深 K」因此消失——不必算 K、不必 max_depth、組織長高不必重新部署，
 * 而且每個申請 App 的 status.json 逐字元相同。
 *
 * 走哪一條自迴圈由記錄上的 `next_state` / `reject_state` 決定：狀態不編號之後，
 * 光看「簽核中」不知道下一站是主管、經辦、會簽還是已簽完，所以由 adapter 先算好
 * 寫進欄位，kintone 的 filterCond 讀它決定往哪走。
 *
 * 【影響的欄位】
 *   - 736 deployed_at / deployed_hash：部署成功後回寫
 *   - 目標申請 App 的流程管理設定（狀態與動作）：整份覆寫
 *
 * 【依賴】
 *   - core/01-config.js（Config）
 *   - core/02-api-client.js（ApiClient.ensureFresh）
 *   - core/04-utils.js（Utils）
 *
 * 【kintone 平台事實（查證後記錄，全部影響本檔設計）】
 *   1. `assignee.type` 的 ONE 是「**指定**一人處理」不是「任一人」。任一人簽＝`ANY`、
 *      全員會簽＝`ALL`。名字會騙人，改這裡前請重看這條註解。
 *   2. 使用者選擇欄位當執行者用 `entity.type = FIELD_ENTITY`（code＝欄位代碼）。
 *      `CUSTOM_FIELD` 是另一回事，不要用。
 *   3. 同一個 from 可以有多條**同名**動作，用互不重疊的 filterCond 分流——這是
 *      kintone 的標準手法。唯一禁忌是其中兩條的 filterCond 同時為空。
 *   4. 只能刪除「沒有任何記錄處於該狀態」的狀態，而且刪掉的狀態名不能再用。
 *      本模板是常數，不會因表單而增減狀態，所以這條限制只在「從舊的編號模型
 *      遷移過來」時會踩到——舊的「簽核中(n)」狀態上若還有在途單，部署會失敗。
 *   5. 目標狀態上有「已指定執行者的記錄」時，該狀態的執行者指定方式無法變更
 *      （GAIA_IL35）。有在途單時重新部署可能失敗，UI 會事先警告。
 *   6. **index 0 的初始狀態，`assignee.type` 只能是 `ONE`**（2026-09-01 實測，官方文件未載明）。
 *      填 ANY 會被拒：「初始狀態下，執行者的type只能指定為『ONE』。」
 *   7. **`SECONDARY` 動作的 `executableUser` 是必填**（同上實測）。沒有可執行群組時
 *      不能只是省略它，會回「此項必填。」——本檔改為直接不產生該動作。
 *
 * 【變更履歷】
 *   2026-09-01  Jimmy/Claude  初版（P8 Phase C，簽核中(1..K) 編號模型）
 *   2026-09-01  Jimmy/Claude  改為固定 7 狀態常數模板（Jimmy 確認 kintone 允許自迴圈）：
 *                              刪掉 K 值計算、只增不減、全員會簽位置判定三段邏輯
 *   2026-09-01  Jimmy/Claude  實測 PUT 打出兩條官方文件未載明的平台規則（見上方 6、7）：
 *                              初始狀態 type 固定 ONE、SECONDARY 必須帶 executableUser。
 *                              兩者都補進 validateStatusPayload，PUT 前就擋下
 */
(() => {
  'use strict';

  const {
    ROUTE_FIELDS: RTF,
    ADAPTER_FIELDS: AF,
    STATUS_TEMPLATE: ST,
    APPROVING_STATES,
    TERMINAL_STATES,
    ACTION_TEMPLATE: ACT,
    CHECKBOX,
  } = window.ApprovalRouting.Config;

  const { ensureFresh } = window.ApprovalRouting.ApiClient;
  const { safeHandler, kintoneApi, showWarning, showConfirm, showSuccess } =
    window.ApprovalRouting.Utils;

  /** kintone 的狀態名／動作名長度上限 */
  const NAME_MAX = 64;

  /** 狀態在畫面上的排列順序 */
  const STATE_ORDER = Object.freeze([
    ST.DRAFT, ST.APPROVING, ST.HANDLER, ST.COSIGNING, ST.REJECTED, ST.DECIDED, ST.CANCELLED,
  ]);

  // -------------------------------------------------------------------
  // 純函式：狀態圖產生
  // -------------------------------------------------------------------

  /** 建一個 assignee entity。CREATOR 不帶 code（kintone 回傳時該欄為 null） */
  const entityOf = (type, code) => ({
    entity: code === undefined ? { type } : { type, code },
    includeSubs: false,
  });

  const actionOf = ({ name, from, to, filterCond = '', type = 'PRIMARY', executableUser }) => {
    const a = { name, from, to, filterCond, type };
    if (executableUser) a.executableUser = executableUser;
    return a;
  };

  /** 「這一欄等於某個狀態名」的查詢條件 */
  const fieldIs = (code, value) => `${code} in ("${value}")`;

  /**
   * 產生完整的 status.json payload（純函式，無 I/O）
   *
   * 除了「可作廢群組」之外，產出對每一張表單都完全相同。
   *
   * @param {Object} p
   * @param {Array<{code: string}>} [p.cancelGroups=[]] 可執行作廢的群組；空＝不限定（沿用該狀態的執行者）
   * @returns {{ ok: boolean, payload: Object|null, error: string|null }}
   */
  const buildStatusJson = ({ cancelGroups = [] } = {}) => {
    // ── 狀態 ────────────────────────────────────────────────────────────
    const assigneeOf = (name) => {
      if (name === ST.DRAFT) {
        // ⚠️ kintone 平台規則（2026-09-01 實測）：**index 0 的初始狀態，type 只能是 ONE**。
        //    填 ANY 會被拒：「初始狀態下，執行者的type只能指定為『ONE』。」
        //    只有一個候選人（建立者），所以 ONE 與 ANY 的實際行為相同。
        return { type: 'ONE', entities: [entityOf('CREATOR')] };
      }
      if (name === ST.REJECTED) {
        // 申請人自己：駁回後要能再申請
        return { type: 'ANY', entities: [entityOf('CREATOR')] };
      }
      if (TERMINAL_STATES.includes(name)) {
        // 終態不設執行者：設了會讓那個人的「待處理」清單一直掛著已結案的單
        return { type: 'ANY', entities: [] };
      }
      // 三個簽核狀態：執行者來自 current_approvers 欄位（權威來源是「更新執行者 API」，
      // 這裡是原生流程的 fallback，見 docs/06 §5.3）
      return {
        type: name === ST.COSIGNING ? 'ALL' : 'ANY',
        entities: [entityOf('FIELD_ENTITY', AF.CURRENT_APPROVERS)],
      };
    };

    const states = {};
    STATE_ORDER.forEach((name, i) => {
      states[name] = { name, index: String(i), assignee: assigneeOf(name) };
    });

    // ── 動作 ────────────────────────────────────────────────────────────
    const actions = [];
    const NEXT = AF.NEXT_STATE;
    const REJ = AF.REJECT_STATE;

    // 送出：草稿 → 第 1 關所在的狀態（三種可能，由 next_state 分流）
    for (const to of APPROVING_STATES) {
      actions.push(actionOf({ name: ACT.SUBMIT, from: ST.DRAFT, to, filterCond: fieldIs(NEXT, to) }));
    }

    // 同意：三個簽核狀態各自可去「三個簽核狀態之一」或「核決」。
    // 自迴圈（from === to）就發生在這裡——一條 N 關的鏈靠它跑完，狀態不必編號。
    for (const from of APPROVING_STATES) {
      for (const to of [...APPROVING_STATES, ST.DECIDED]) {
        actions.push(actionOf({ name: ACT.APPROVE, from, to, filterCond: fieldIs(NEXT, to) }));
      }
    }

    // 駁回：退回申請人時 reject_state 恆為「駁回」；退回上一關時是上一關的狀態
    for (const from of APPROVING_STATES) {
      for (const to of [...APPROVING_STATES, ST.REJECTED]) {
        actions.push(actionOf({ name: ACT.REJECT, from, to, filterCond: fieldIs(REJ, to) }));
      }
    }

    actions.push(actionOf({ name: ACT.REAPPLY, from: ST.REJECTED, to: ST.DRAFT }));

    // 作廢：每個非終態都掛一條，收在「⋯」選單，限定群組才能按。
    // ⚠️ kintone 平台規則（2026-09-01 實測）：**SECONDARY 動作的 executableUser 是必填**
    //    （回「此項必填。」）。所以沒有設定可作廢群組時就**不產生作廢動作**——
    //    作廢是不可逆的動作，本來就該限定誰能按，硬給一個「誰都能按」的版本更糟。
    const hasCancel = cancelGroups.length > 0;
    if (hasCancel) {
      const cancelExecutable = { entities: cancelGroups.map((g) => entityOf('GROUP', g.code)) };
      for (const from of [ST.DRAFT, ...APPROVING_STATES, ST.REJECTED]) {
        actions.push(actionOf({
          name: ACT.CANCEL, from, to: ST.CANCELLED,
          type: 'SECONDARY', executableUser: cancelExecutable,
        }));
      }
    }

    return { ok: true, payload: { enable: true, states, actions }, hasCancel, error: null };
  };

  // -------------------------------------------------------------------
  // 純函式：驗證（PUT 之前擋下，不要讓 kintone 回 400 才發現）
  // -------------------------------------------------------------------

  /**
   * @param {Object} payload - buildStatusJson 的產出
   * @returns {string[]} 錯誤訊息（空陣列＝通過）
   */
  const validateStatusPayload = (payload) => {
    const errs = [];
    const states = payload?.states ?? {};
    const actions = payload?.actions ?? [];
    const names = new Set(Object.keys(states));

    if (names.size === 0) errs.push('沒有任何狀態。');
    if (actions.length === 0) errs.push('沒有任何動作。');

    for (const n of names) {
      if (n.length > NAME_MAX) errs.push(`狀態名稱「${n}」超過 ${NAME_MAX} 字。`);
    }
    for (const a of actions) {
      if ((a.name || '').length > NAME_MAX) errs.push(`動作名稱「${a.name}」超過 ${NAME_MAX} 字。`);
    }

    // index 必須從 0 起連續且不重複（kintone 用它排狀態順序）
    const indices = Object.values(states).map((s) => Number(s.index)).sort((x, y) => x - y);
    indices.forEach((v, i) => {
      if (v !== i) errs.push(`狀態的 index 不連續或重複（預期 ${i}，實得 ${v}）。`);
    });

    // kintone 平台規則：index 0 的初始狀態，執行者 type 只能是 ONE
    const first = Object.values(states).find((s) => String(s.index) === '0');
    if (first && first.assignee?.type !== 'ONE') {
      errs.push(`初始狀態「${first.name}」的執行者 type 只能是 ONE（實得 ${first.assignee?.type}）。`);
    }

    // kintone 平台規則：SECONDARY 動作的 executableUser 必填
    for (const a of actions) {
      if (a.type === 'SECONDARY' && !(a.executableUser?.entities ?? []).length) {
        errs.push(`動作「${a.name}」（${a.from}）是 SECONDARY，必須指定 executableUser。`);
      }
    }

    // from / to 必須指向存在的狀態——改狀態名時最容易在這裡斷。
    // 注意：**不檢查 from === to**，自迴圈正是本模型的核心機制。
    for (const a of actions) {
      if (!names.has(a.from)) errs.push(`動作「${a.name}」的來源狀態「${a.from}」不存在。`);
      if (!names.has(a.to))   errs.push(`動作「${a.name}」的目標狀態「${a.to}」不存在。`);
    }

    // 同一 from 的同名動作：允許（這是分歧的標準手法），但不可有兩條都沒有條件
    const byFromName = new Map();
    for (const a of actions) {
      const key = `${a.from} ${a.name}`;
      if (!byFromName.has(key)) byFromName.set(key, []);
      byFromName.get(key).push(a);
    }
    for (const [key, group] of byFromName) {
      if (group.length < 2) continue;
      const [from, name] = key.split(' ');
      const blank = group.filter((a) => !a.filterCond).length;
      if (blank > 1) {
        errs.push(`狀態「${from}」有 ${blank} 條沒有條件的同名動作「${name}」，按鈕行為不可預期。`);
      }
      // 條件重複代表兩條會同時成立，走哪一條不確定
      const conds = group.map((a) => a.filterCond);
      const dupe = conds.find((c, i) => c && conds.indexOf(c) !== i);
      if (dupe) errs.push(`狀態「${from}」的同名動作「${name}」有重複的條件（${dupe}）。`);
    }

    // 每個非終態都要有出路，否則單子會卡死
    const hasOutgoing = new Set(actions.map((a) => a.from));
    for (const n of names) {
      const isTerminal = TERMINAL_STATES.includes(n);
      if (!isTerminal && !hasOutgoing.has(n)) errs.push(`狀態「${n}」沒有任何出路，單子會卡死。`);
      if (isTerminal && hasOutgoing.has(n))   errs.push(`終態「${n}」不應該有向外的動作。`);
      if (isTerminal && (states[n]?.assignee?.entities ?? []).length > 0) {
        errs.push(`終態「${n}」不應該設定執行者。`);
      }
    }

    return errs;
  };

  // -------------------------------------------------------------------
  // 純函式：部署指紋
  // -------------------------------------------------------------------

  /**
   * 把產出的狀態圖壓成一個短雜湊存進 deployed_hash。
   *
   * 舊版是雜湊「路由設定」——因為當時狀態數 K 隨路由變動。現在狀態圖與路由完全無關，
   * 改雜湊狀態圖本身，用途也跟著變成偵測「**模板改版了，這個 App 還沒重新部署**」。
   *
   * @param {Object} payload
   * @returns {string} 8 碼十六進位
   */
  const hashStatusPayload = (payload) => {
    const seed = JSON.stringify({
      states: Object.values(payload.states ?? {}).map((s) => [s.name, s.index, s.assignee?.type,
        (s.assignee?.entities ?? []).map((e) => `${e.entity.type}:${e.entity.code ?? ''}`)]),
      actions: (payload.actions ?? []).map((a) =>
        [a.name, a.from, a.to, a.filterCond, a.type,
         (a.executableUser?.entities ?? []).map((e) => `${e.entity.type}:${e.entity.code ?? ''}`)]),
    });

    // FNV-1a 32-bit：夠短、夠穩、不需要相依套件
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };

  /**
   * 找出舊編號模型殘留的「簽核中(n)」狀態
   *
   * 這些狀態在新模板裡不存在，PUT 時等同要求刪除；只要還有一張在途單停在上面，
   * kintone 就會拒絕整份設定。事先掃出來提醒，比部署失敗後看不懂錯誤訊息好。
   *
   * @param {Object} states - GET status.json 回來的 states
   * @returns {string[]} 舊狀態名
   */
  const findLegacyNumberedStates = (states) =>
    Object.keys(states ?? {}).filter((n) => /^簽核中\(\d+\)$/.test(n));

  // -------------------------------------------------------------------
  // 部署管線
  // -------------------------------------------------------------------

  const getLiveStatus = (appId) => kintoneApi('/k/v1/app/status', 'GET', { app: appId });
  const putPreviewStatus = (body) => kintoneApi('/k/v1/preview/app/status', 'PUT', body);
  const postDeploy = (appId, revision) =>
    kintoneApi('/k/v1/preview/app/deploy', 'POST', { apps: [{ app: appId, revision }] });
  const getDeployStatus = (appId) => kintoneApi('/k/v1/preview/app/deploy', 'GET', { apps: [appId] });

  /** 輪詢部署狀態直到結束。卡在 PROCESSING 時不要重複 POST，等就好 */
  const waitForDeploy = async (appId, { tries = 30, intervalMs = 2000 } = {}) => {
    for (let i = 0; i < tries; i++) {
      const resp = await getDeployStatus(appId);
      const status = resp.apps?.[0]?.status;
      if (status === 'SUCCESS') return { ok: true, status };
      if (status === 'FAIL' || status === 'CANCEL') return { ok: false, status };
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return { ok: false, status: 'TIMEOUT' };
  };

  /** 把備份的 status.json 存成檔案，出事可原樣 PUT 回去 */
  const downloadBackup = (appId, json) => {
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `status-backup-app${appId}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * 對單一路由設定跑完整管線
   * @param {Object} routeConfig
   */
  const runPipeline = async (routeConfig) => {
    const formAppId = routeConfig[RTF.FORM_APP_ID]?.value;
    const formName = routeConfig[RTF.FORM_NAME]?.value || `App ${formAppId}`;

    if (!formAppId) {
      await showWarning('這筆路由設定沒有填「表單 App ID」', '請先補上要套用的申請 App ID。');
      return;
    }
    if (String(formAppId) === String(kintone.app.getId())) {
      await showWarning('表單 App ID 指到路由表自己', '路由表是設定表，不該套用簽核流程。請確認 App ID 填對。');
      return;
    }

    Swal.fire({ title: '讀取現況…', allowOutsideClick: false });
    Swal.showLoading();

    // ① 備份
    let live;
    try {
      live = await getLiveStatus(formAppId);
    } catch (err) {
      Swal.close();
      await showWarning('讀不到目標 App 的流程設定',
        `App ${formAppId}：${err.message || err}\n請確認 App ID 正確、且你有該 App 的管理權限。`);
      return;
    }

    // ② 產生（常數模板，唯一的變數是作廢群組）
    const built = buildStatusJson({ cancelGroups: routeConfig[RTF.CANCEL_GROUPS]?.value ?? [] });
    if (!built.ok) {
      Swal.close();
      await showWarning('產生狀態圖失敗', built.error);
      return;
    }

    // ③ 驗證
    const errs = validateStatusPayload(built.payload);
    if (errs.length > 0) {
      Swal.close();
      await Swal.fire({
        icon: 'error', title: '產出的狀態圖沒通過檢查',
        html: '這是程式的問題，請回報：<br><br>' + errs.map((e) => `• ${esc(e)}`).join('<br>'),
        confirmButtonText: '確定',
      });
      return;
    }

    Swal.close();

    const legacy = findLegacyNumberedStates(live.states);
    const stateCount = Object.keys(built.payload.states).length;

    const go = await Swal.fire({
      icon: 'question',
      title: `要為「${esc(formName)}」部署簽核流程嗎？`,
      html:
        `<div style="text-align:left;font-size:15px">` +
        `<b>${stateCount} 個狀態、${built.payload.actions.length} 條動作</b>` +
        `（${STATE_ORDER.map(esc).join(' ／ ')}）<br>` +
        `這份設定對每一張表單都相同，關卡有幾關都不影響。<br><br>` +
        (built.hasCancel ? '' :
          `<span style="color:#b8860b">⚠️ 這筆路由沒有設定「可作廢群組」，所以<b>不會產生作廢動作</b>。<br>` +
          `kintone 規定 SECONDARY 動作必須指定可執行的人，而作廢不可逆、本來就該限定誰能按。<br>` +
          `需要作廢功能的話，先回路由設定補上群組再部署。</span><br><br>`) +
        (legacy.length > 0
          ? `<span style="color:#c00">⚠️ 這個 App 上還有舊版編號狀態：${legacy.map(esc).join('、')}。<br>` +
            `新模板不含這些狀態，部署等同要刪掉它們——只要還有一張單停在上面，kintone 會拒絕整份設定。<br>` +
            `請先把那些單處理完或改狀態。</span><br><br>`
          : '') +
        `<span style="color:#666">按下「下載備份並繼續」會先把目前的流程設定存成 JSON 檔，` +
        `再寫入<b>測試環境</b>。這一步還不會動到正式環境。</span></div>`,
      showCancelButton: true,
      confirmButtonText: '下載備份並繼續',
      cancelButtonText: '取消',
      width: 720,
    });
    if (!go.isConfirmed) return;

    downloadBackup(formAppId, live);

    // ④ PUT preview（帶 revision 防併發）
    Swal.fire({ title: '寫入測試環境…', allowOutsideClick: false });
    Swal.showLoading();
    try {
      await putPreviewStatus({ app: formAppId, revision: live.revision, ...built.payload });
    } catch (err) {
      Swal.close();
      await showWarning('寫入測試環境失敗',
        `${err.message || err}\n\n如果訊息提到 revision，代表這份設定在你按下按鈕後被別人改過，請重新操作一次。`);
      return;
    }
    Swal.close();

    // ⑤ 人工確認
    const deployOk = await showConfirm(
      '測試環境已更新，要部署到正式環境嗎？',
      `建議先到 App ${formAppId} 的「表單設定 → 流程管理」看一眼再部署。部署後正式環境立即生效。\n\n` +
      `注意：目標狀態上若有在途單且已指定執行者，kintone 會拒絕變更該狀態的執行者設定（GAIA_IL35）。`
    );
    if (!deployOk) {
      await showWarning('已停在測試環境', '設定留在測試環境未部署。你可以稍後從 kintone 畫面手動部署，或按「取消變更」還原。');
      return;
    }

    // ⑥ 部署 + 輪詢
    Swal.fire({ title: '部署中…', html: '請勿關閉視窗', allowOutsideClick: false });
    Swal.showLoading();
    try {
      await postDeploy(formAppId);
    } catch (err) {
      Swal.close();
      await showWarning('部署失敗', String(err.message || err));
      return;
    }

    const deployed = await waitForDeploy(formAppId);
    if (!deployed.ok) {
      Swal.close();
      await showWarning(
        `部署未完成（${deployed.status}）`,
        deployed.status === 'TIMEOUT'
          ? '等待逾時。其他設定變更可能正在排隊，請到 kintone 畫面確認，不要重複部署。'
          : '請到 kintone 畫面查看失敗原因。常見原因：狀態上還有在途單，執行者設定無法變更。'
      );
      return;
    }

    // ⑦ 回寫指紋
    try {
      await kintoneApi('/k/v1/record', 'PUT', {
        app: kintone.app.getId(),
        id: routeConfig.$id.value,
        record: {
          [RTF.DEPLOYED_AT]:   { value: new Date().toISOString() },
          [RTF.DEPLOYED_HASH]: { value: hashStatusPayload(built.payload) },
        },
      });
    } catch (err) {
      await showWarning('流程已部署，但回寫記錄失敗',
        `流程設定本身已經生效。只有 deployed_at / deployed_hash 沒寫進去：${err.message || err}`);
      return;
    }

    await showSuccess('部署完成');
    location.reload();
  };

  // -------------------------------------------------------------------
  // UI：清單頁按鈕
  // -------------------------------------------------------------------

  const fetchAllRouteConfigs = async () => {
    const resp = await kintoneApi('/k/v1/records', 'GET', {
      app: kintone.app.getId(),
      query: `order by ${RTF.FORM_APP_ID} asc limit 500`,
    });
    return resp.records;
  };

  const pickRouteConfig = async (records) => {
    // 模板是常數，指紋只跟作廢群組有關，可以在列表就算出來比對
    const currentHash = (r) =>
      hashStatusPayload(buildStatusJson({ cancelGroups: r[RTF.CANCEL_GROUPS]?.value ?? [] }).payload);

    const rows = records.map((r, i) => {
      const active = (r[RTF.IS_ACTIVE]?.value ?? []).includes(CHECKBOX.ACTIVE);
      const steps = (r[RTF.ROUTE_STEPS]?.value ?? []).length;
      const deployedAt = r[RTF.DEPLOYED_AT]?.value;
      const hash = r[RTF.DEPLOYED_HASH]?.value || '';
      const stale = deployedAt && hash && hash !== currentHash(r);
      return `
        <label style="display:block;padding:10px 12px;border:1px solid #ddd;border-radius:6px;margin-bottom:8px;cursor:pointer;text-align:left;font-size:15px">
          <input type="radio" name="arRoute" value="${i}" style="margin-right:8px">
          <b>${esc(r[RTF.FORM_NAME]?.value || '(未命名)')}</b>
          <span style="color:#888">（App ${esc(r[RTF.FORM_APP_ID]?.value)}）</span>
          ${active ? '' : '<span style="color:#c00">［未啟用］</span>'}
          <br>
          <span style="color:#666;font-size:13px;margin-left:24px">
            ${steps} 段路由｜${deployedAt ? `已部署 ${esc(String(deployedAt).slice(0, 10))}` : '<span style="color:#c00">尚未部署</span>'}
            ${stale ? '｜<span style="color:#c00">設定已改，需重新部署</span>' : ''}
          </span>
        </label>`;
    }).join('');

    const res = await Swal.fire({
      title: '要為哪一張表單部署流程設定？',
      html: `<div style="max-height:420px;overflow:auto">${rows}</div>`,
      showCancelButton: true,
      confirmButtonText: '下一步',
      cancelButtonText: '取消',
      width: 720,
      preConfirm: () => {
        const sel = Swal.getPopup().querySelector('input[name="arRoute"]:checked');
        if (!sel) {
          Swal.showValidationMessage('請選一張表單');
          return false;
        }
        return Number(sel.value);
      },
    });

    return res.isConfirmed ? records[res.value] : null;
  };

  kintone.events.on('app.record.index.show', safeHandler(async (event) => {
    const BTN_ID = 'ar-status-generator-btn';
    if (document.getElementById(BTN_ID)) return event;

    const space = kintone.app.getHeaderMenuSpaceElement();
    if (!space) return event;

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.textContent = '部署流程設定';
    btn.className = 'kintoneplugin-button-normal';
    btn.style.cssText = 'margin-left:8px;font-size:15px;padding:6px 16px;cursor:pointer';

    btn.onclick = safeHandler(async () => {
      await ensureFresh(); // 這是部署不是預覽，快取一律重讀
      const records = await fetchAllRouteConfigs();
      if (records.length === 0) {
        await showWarning('還沒有任何路由設定', '請先新增一筆表單路由設定。');
        return;
      }
      const picked = await pickRouteConfig(records);
      if (picked) await runPipeline(picked);
    });

    space.appendChild(btn);
    return event;
  }));

  // 供測試（純函式部分）
  window.ApprovalRouting = window.ApprovalRouting || {};
  window.ApprovalRouting.StatusGeneratorInternals = Object.freeze({
    buildStatusJson,
    validateStatusPayload,
    hashStatusPayload,
    findLegacyNumberedStates,
    STATE_ORDER,
  });
})();
