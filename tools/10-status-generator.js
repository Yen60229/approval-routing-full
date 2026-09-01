/**
 * 流程管理狀態圖產生器（P8 Phase C）— 由路由表產生並部署 status.json
 *
 * 掛在表單路由設定表（App 736）清單頁。一鍵完成 docs/06 §5.5 的部署管線：
 *   ① GET 正式環境 status.json 備份（可下載）
 *   ② 讀該筆 form_route_config
 *   ③ 算 K（最大鏈深）→ generate 完整狀態圖
 *   ④ validate（from/to 存在、filterCond 互補、非終態有出路…）
 *   ⑤ PUT /k/v1/preview/app/status.json（只寫測試環境，帶 revision）
 *   ⑥ 人工在 kintone 畫面確認
 *   ⑦ POST /k/v1/preview/app/deploy.json → 輪詢至 SUCCESS
 *   ⑧ 回寫 max_depth / deployed_at / deployed_hash
 *
 * 【影響的欄位】
 *   - 736 max_depth / deployed_at / deployed_hash：部署成功後回寫
 *   - 目標申請 App 的流程管理設定（狀態與動作）：整份覆寫
 *
 * 【依賴】
 *   - core/01-config.js（Config）
 *   - core/02-api-client.js（ApiClient：getDistinctEntryRoleIds / getRouteConfig / ensureFresh）
 *   - core/04-utils.js（Utils）
 *   - core/06-route-engine.js（RouteEngine.expandRouteSegments）← 需排在本檔之前載入
 *
 * 【kintone 平台限制（查證後記錄，全部影響本檔設計）】
 *   1. `assignee.type` 的 ONE 是「**指定**一人處理」不是「任一人」。任一人簽＝`ANY`、
 *      全員會簽＝`ALL`。名字會騙人，改這裡前請重看這條註解。
 *   2. 使用者選擇欄位當執行者用 `entity.type = FIELD_ENTITY`（code＝欄位代碼）。
 *      `CUSTOM_FIELD` 是另一回事，不要用。
 *   3. 同一個 from 可以有兩條**同名**動作，用互補 filterCond 做 OR 分歧——這是
 *      kintone 的標準手法，也是本設計處理「鏈深度因人而異」的基礎（docs/06 §5.2）。
 *      唯一禁忌是兩條的 filterCond 同時為空（按鈕行為不可預期），validate 會擋。
 *   4. **只能刪除「沒有任何記錄處於該狀態」的狀態**，而且**刪掉的狀態名不能再用**。
 *      所以本產生器 **只增不減**：K 變小時保留既有的多餘狀態（filterCond 會繞過它們，
 *      不影響流程），只提示不刪除。詳見 buildStatusJson 的 effectiveK。
 *   5. 目標狀態上有「已指定執行者的記錄」時，該狀態的**執行者指定方式無法變更**
 *      （GAIA_IL35）。所以有在途單時重新部署可能失敗，UI 會事先警告。
 *
 * 【變更履歷】
 *   2026-09-01  Jimmy/Claude  初版（P8 Phase C）
 */
(() => {
  'use strict';

  const {
    ROUTE_FIELDS: RTF,
    ROUTE_STEP_FIELDS: RSF,
    SEGMENT_TYPE_OPTIONS: SEG,
    STEP_SIGNING_MODE_OPTIONS: SSM,
    ADAPTER_FIELDS: AF,
    CHECKBOX,
  } = window.ApprovalRouting.Config;

  const { getDistinctEntryRoleIds, ensureFresh } = window.ApprovalRouting.ApiClient;
  const { safeHandler, kintoneApi, showWarning, showConfirm, showSuccess } =
    window.ApprovalRouting.Utils;

  // -------------------------------------------------------------------
  // 設定：狀態與動作的命名模板（全公司統一，docs/06 §5.1）
  // -------------------------------------------------------------------

  const TPL = Object.freeze({
    DRAFT:     '草稿',
    APPROVED:  '核准',
    REJECTED:  '駁回',
    CANCELLED: '作廢',
    /** 簽核中的第 n 關。狀態名絕不綁職稱——綁了就回到舊系統把組織寫進設定的老路 */
    approving: (n) => `簽核中(${n})`,
  });

  const ACT = Object.freeze({
    SUBMIT:   '送出',
    APPROVE:  '核准',
    REJECT:   '駁回',
    REAPPLY:  '再申請',
    CANCEL:   '作廢',
  });

  /** K 的硬上限（docs/06 §5.1 建議 10）。超過代表資料有問題，不是真的有人要簽 11 關 */
  const MAX_K = 10;

  /** kintone 的狀態名／動作名長度上限 */
  const NAME_MAX = 64;

  // -------------------------------------------------------------------
  // 純函式：狀態圖產生
  // -------------------------------------------------------------------

  /** 建一個 assignee entity。CREATOR 不帶 code（kintone 回傳時該欄為 null） */
  const entityOf = (type, code) => ({
    entity: code === undefined ? { type } : { type, code },
    includeSubs: false,
  });

  const stateOf = (name, index, type, entities) => ({
    name,
    index: String(index),
    assignee: { type, entities },
  });

  const actionOf = ({ name, from, to, filterCond = '', type = 'PRIMARY', executableUser }) => {
    const a = { name, from, to, filterCond, type };
    if (executableUser) a.executableUser = executableUser;
    return a;
  };

  /**
   * 找出「位置固定」的全員會簽關卡
   *
   * kintone 的 ANY/ALL 是每個狀態**靜態**設定的，不能依記錄切換（docs/06 §5.4）。
   * 所以只有絕對位置可以事先算出來的關卡，才可能生成 ALL 狀態——也就是
   * **前面每一段都是指定角色段**（長度固定為 1）的那些關卡。
   * 一旦前面出現員工鏈段，後面所有關卡的位置就隨申請人浮動，無法靜態指定。
   *
   * @param {Object[]} stepRows - 已依 step_no 排序的子表格列
   * @returns {{ ok: boolean, allPositions: Set<number>, error: string|null }}
   */
  const resolveAllSigningPositions = (stepRows) => {
    const allPositions = new Set();
    let pos = 0;               // 目前已確定的絕對關卡數
    let determinate = true;    // 位置是否仍可靜態決定

    for (let i = 0; i < stepRows.length; i++) {
      const v = stepRows[i].value || {};
      const segType = v[RSF.SEGMENT_TYPE]?.value || '';
      const mode = v[RSF.STEP_SIGNING_MODE]?.value || '';

      if (segType === SEG.EMPLOYEE_CHAIN) {
        if (mode === SSM.ALL) {
          return {
            ok: false, allPositions,
            error: `第 ${i + 1} 段是員工鏈段，不能指定「全員會簽」（該模式僅限指定角色段）。`,
          };
        }
        determinate = false;   // 這一段長度因人而異，之後的位置都浮動了
        continue;
      }

      pos += 1;
      if (mode !== SSM.ALL) continue;

      if (!determinate) {
        return {
          ok: false, allPositions,
          error:
            `第 ${i + 1} 段指定了「全員會簽」，但它前面有員工鏈段，` +
            `這一關落在第幾關會因申請人而異。kintone 的「全員會簽」是每個狀態固定設定的，` +
            `位置會變動就沒辦法產生對應的狀態。請把需要全員會簽的關卡排在所有員工鏈段之前，` +
            `或改用「任一人簽」。`,
        };
      }
      allPositions.add(pos);
    }

    return { ok: true, allPositions, error: null };
  };

  /**
   * 產生完整的 status.json payload（純函式，無 I/O）
   *
   * @param {Object} p
   * @param {Object} p.routeConfig            form_route_config 記錄
   * @param {number} p.k                      本次算出的最大鏈深
   * @param {number} [p.existingApprovingCount=0]
   *   目標 App 目前已部署的「簽核中(n)」狀態數。用來實作**只增不減**：
   *   kintone 不允許刪除「還有記錄停在上面」的狀態，刪掉的狀態名也不能再用，
   *   所以 K 變小時保留舊狀態比刪掉安全得多（多出來的狀態沒有動作指向它，等同不存在）。
   * @returns {{ ok: boolean, payload: Object|null, effectiveK: number, error: string|null }}
   */
  const buildStatusJson = ({ routeConfig, k, existingApprovingCount = 0 }) => {
    const effectiveK = Math.max(k, existingApprovingCount);

    if (effectiveK < 1) {
      return { ok: false, payload: null, effectiveK, error: '最大鏈深 K 小於 1，沒有任何簽核關卡可產生。' };
    }
    if (effectiveK > MAX_K) {
      return {
        ok: false, payload: null, effectiveK,
        error: `最大鏈深 K = ${effectiveK} 超過上限 ${MAX_K}。請檢查角色表是否有異常長鏈，或調整路由的「簽到職稱為止」。`,
      };
    }

    const stepRows = (routeConfig[RTF.ROUTE_STEPS]?.value ?? [])
      .slice()
      .sort((a, b) => Number(a.value?.[RSF.STEP_NO]?.value || 0) - Number(b.value?.[RSF.STEP_NO]?.value || 0));

    const allSign = resolveAllSigningPositions(stepRows);
    if (!allSign.ok) {
      return { ok: false, payload: null, effectiveK, error: allSign.error };
    }

    const rejectTarget = routeConfig[RTF.REJECT_TARGET]?.value || '';
    const cancelGroups = routeConfig[RTF.CANCEL_GROUPS]?.value ?? [];
    const rejectToPrev = rejectTarget === '退回上一關';

    // ── 狀態 ────────────────────────────────────────────────────────────
    const states = {};
    let idx = 0;

    states[TPL.DRAFT] = stateOf(TPL.DRAFT, idx++, 'ANY', [entityOf('CREATOR')]);

    for (let n = 1; n <= effectiveK; n++) {
      const name = TPL.approving(n);
      // 執行者權威來源是「更新執行者 API」；這裡掛欄位當 fallback（docs/06 §5.3）
      states[name] = stateOf(
        name, idx++,
        allSign.allPositions.has(n) ? 'ALL' : 'ANY',
        [entityOf('FIELD_ENTITY', AF.CURRENT_APPROVERS)]
      );
    }

    // 終態不設執行者：設了會讓那個人的「待處理」清單一直掛著已結案的單
    states[TPL.APPROVED]  = stateOf(TPL.APPROVED, idx++, 'ANY', []);
    states[TPL.REJECTED]  = stateOf(TPL.REJECTED, idx++, 'ANY', [entityOf('CREATOR')]);
    states[TPL.CANCELLED] = stateOf(TPL.CANCELLED, idx++, 'ANY', []);

    // ── 動作 ────────────────────────────────────────────────────────────
    const actions = [];
    const total = AF.TOTAL_STEPS;

    actions.push(actionOf({ name: ACT.SUBMIT, from: TPL.DRAFT, to: TPL.approving(1) }));

    for (let n = 1; n <= effectiveK; n++) {
      const from = TPL.approving(n);

      if (n < effectiveK) {
        // 同名動作 + 互補 filterCond：簽核者只看到一顆「核准」，kintone 依鏈長自動走對的路
        actions.push(actionOf({ name: ACT.APPROVE, from, to: TPL.approving(n + 1), filterCond: `${total} > ${n}` }));
        actions.push(actionOf({ name: ACT.APPROVE, from, to: TPL.APPROVED,          filterCond: `${total} <= ${n}` }));
      } else {
        // 最後一關不可能還有下一關（adapter 在 submit 擋掉 chain.length > max_depth），
        // 只有一條出路，filterCond 留空即可
        actions.push(actionOf({ name: ACT.APPROVE, from, to: TPL.APPROVED }));
      }

      // 退回上一關時，第 1 關的「上一關」就是申請人本人 → 一律回駁回狀態
      const rejectTo = rejectToPrev && n > 1 ? TPL.approving(n - 1) : TPL.REJECTED;
      actions.push(actionOf({ name: ACT.REJECT, from, to: rejectTo }));
    }

    actions.push(actionOf({ name: ACT.REAPPLY, from: TPL.REJECTED, to: TPL.DRAFT }));

    // 作廢：每個非終態都掛一條，收在「⋯」選單，限定群組才能按
    const cancelExecutable = cancelGroups.length > 0
      ? { entities: cancelGroups.map((g) => entityOf('GROUP', g.code)) }
      : undefined;

    const nonTerminal = [TPL.DRAFT, ...Array.from({ length: effectiveK }, (_, i) => TPL.approving(i + 1)), TPL.REJECTED];
    for (const from of nonTerminal) {
      actions.push(actionOf({
        name: ACT.CANCEL, from, to: TPL.CANCELLED,
        type: 'SECONDARY', executableUser: cancelExecutable,
      }));
    }

    return { ok: true, payload: { enable: true, states, actions }, effectiveK, error: null };
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

    // 名稱長度
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

    // from / to 必須指向存在的狀態——改狀態名時最容易在這裡斷
    for (const a of actions) {
      if (!names.has(a.from)) errs.push(`動作「${a.name}」的來源狀態「${a.from}」不存在。`);
      if (!names.has(a.to))   errs.push(`動作「${a.name}」的目標狀態「${a.to}」不存在。`);
      if (a.from === a.to)    errs.push(`動作「${a.name}」的來源與目標都是「${a.from}」。`);
    }

    // 同一 from 的同名動作：允許（這是 OR 分歧的標準手法），但不可兩條都沒有條件
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
    }

    // 每個非終態都要有出路，否則單子會卡死在那裡
    const hasOutgoing = new Set(actions.map((a) => a.from));
    const terminals = new Set([TPL.APPROVED, TPL.CANCELLED]);
    for (const n of names) {
      if (!terminals.has(n) && !hasOutgoing.has(n)) errs.push(`狀態「${n}」沒有任何出路，單子會卡死。`);
      if (terminals.has(n) && hasOutgoing.has(n))   errs.push(`終態「${n}」不應該有向外的動作。`);
    }

    // 終態不該有執行者
    for (const n of terminals) {
      if ((states[n]?.assignee?.entities ?? []).length > 0) {
        errs.push(`終態「${n}」不應該設定執行者。`);
      }
    }

    return errs;
  };

  // -------------------------------------------------------------------
  // 純函式：部署指紋
  // -------------------------------------------------------------------

  /**
   * 把路由設定壓成一個短雜湊，存進 deployed_hash。
   * 用途：偵測「路由改了但忘記重跑產生器」——40-50 個表單的規模下這是遲早會
   * 發生的事故，一個欄位就擋掉（docs/06 §5.5）。
   *
   * 只納入會影響狀態圖的欄位；form_name 這種純標示用的改了不算變更。
   *
   * @param {Object} routeConfig
   * @param {number} effectiveK
   * @returns {string} 8 碼十六進位
   */
  const hashRouteConfig = (routeConfig, effectiveK) => {
    const rows = (routeConfig[RTF.ROUTE_STEPS]?.value ?? [])
      .slice()
      .sort((a, b) => Number(a.value?.[RSF.STEP_NO]?.value || 0) - Number(b.value?.[RSF.STEP_NO]?.value || 0))
      .map((r) => {
        const v = r.value || {};
        return [
          v[RSF.STEP_NO]?.value ?? '',
          v[RSF.SEGMENT_TYPE]?.value ?? '',
          v[RSF.STOP_AT_TITLE_LEVEL]?.value ?? '',
          // 複選的順序不穩定，排序後才能得到穩定指紋
          (v[RSF.SKIP_TITLE_LEVELS]?.value ?? []).slice().sort().join(','),
          v[RSF.ROLE_ID]?.value ?? '',
          v[RSF.STEP_SIGNING_MODE]?.value ?? '',
        ].join('|');
      });

    const seed = JSON.stringify({
      k: effectiveK,
      rows,
      reject: routeConfig[RTF.REJECT_TARGET]?.value ?? '',
      cancel: (routeConfig[RTF.CANCEL_GROUPS]?.value ?? []).map((g) => g.code).slice().sort(),
    });

    // FNV-1a 32-bit：夠短、夠穩、不需要相依套件
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };

  /** 數已部署的「簽核中(n)」狀態數（只增不減用） */
  const countApprovingStates = (states) => {
    let n = 0;
    while (states && states[TPL.approving(n + 1)]) n++;
    return n;
  };

  // -------------------------------------------------------------------
  // K 值計算
  // -------------------------------------------------------------------

  /**
   * 算最大鏈深
   *
   * 純職能路由（沒有員工鏈段）→ 長度固定，直接數關卡，不查 686。
   * 有員工鏈段 → 取 686 的 distinct 起點角色各展開一次取最大值（約 80 次記憶體運算，
   * 角色表已全量快取；**不掃 500 名員工**，見 getDistinctEntryRoleIds）。
   *
   * 個別起點展開失敗（斷鏈、孤兒角色等）不中斷計算，收集起來一併回報——
   * 那是資料問題該用健康檢查修，不該讓整個部署卡住。
   *
   * @param {Object} routeConfig
   * @returns {Promise<{ ok: boolean, k: number, skipped: string[], error: string|null }>}
   */
  const computeMaxDepth = async (routeConfig) => {
    const { expandRouteSegments } = window.ApprovalRouting.RouteEngine;

    const stepRows = routeConfig[RTF.ROUTE_STEPS]?.value ?? [];
    const hasEmployeeSegment = stepRows.some(
      (r) => (r.value?.[RSF.SEGMENT_TYPE]?.value || '') === SEG.EMPLOYEE_CHAIN
    );

    if (!hasEmployeeSegment) {
      const r = await expandRouteSegments(routeConfig, {});
      return r.ok
        ? { ok: true, k: r.steps.length, skipped: [], error: null }
        : { ok: false, k: 0, skipped: [], error: r.error };
    }

    const entryRoleIds = await getDistinctEntryRoleIds();
    if (entryRoleIds.length === 0) {
      return { ok: false, k: 0, skipped: [], error: '員工起點對照表沒有任何啟用中的起點角色，算不出最大鏈深。' };
    }

    let k = 0;
    const skipped = [];
    for (const entryRoleId of entryRoleIds) {
      const r = await expandRouteSegments(routeConfig, { entryRoleId });
      if (r.ok) k = Math.max(k, r.steps.length);
      else skipped.push(`${entryRoleId}：${r.error}`);
    }

    if (k === 0) {
      return { ok: false, k: 0, skipped, error: '所有起點角色都展開失敗，請先跑健康檢查修正角色表。' };
    }
    return { ok: true, k, skipped, error: null };
  };

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

  /** 把產出的狀態圖畫成人看得懂的摘要 */
  const renderSummary = ({ payload, effectiveK, computedK, existingCount, skipped }) => {
    const rows = [
      `<b>簽核關卡數 K：${effectiveK}</b>`,
      `狀態：${Object.keys(payload.states).length} 個｜動作：${payload.actions.length} 條`,
    ];
    if (effectiveK > computedK) {
      rows.push(
        `<span style="color:#b8860b">目前算出來只需要 ${computedK} 關，但這個 App 已經部署了 ` +
        `${existingCount} 個簽核狀態。kintone 不允許刪除還有單子停在上面的狀態，` +
        `刪掉的狀態名也不能再用，所以多的狀態保留不動（沒有動作指向它們，等於不存在）。</span>`
      );
    }
    if (skipped.length > 0) {
      rows.push(
        `<span style="color:#b8860b">有 ${skipped.length} 個起點角色展開失敗，未納入 K 值計算：<br>` +
        skipped.slice(0, 5).map((s) => `・${esc(s)}`).join('<br>') +
        (skipped.length > 5 ? `<br>…另外 ${skipped.length - 5} 個` : '') +
        '<br>建議先跑健康檢查修正。</span>'
      );
    }
    return rows.join('<br><br>');
  };

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

    Swal.fire({ title: '計算中…', html: '正在展開所有起點角色，算最大鏈深', allowOutsideClick: false });
    Swal.showLoading();

    // ① 備份 + ② 讀現況
    let live;
    try {
      live = await getLiveStatus(formAppId);
    } catch (err) {
      Swal.close();
      await showWarning('讀不到目標 App 的流程設定', `App ${formAppId}：${err.message || err}\n請確認 App ID 正確、且你有該 App 的管理權限。`);
      return;
    }

    const existingCount = countApprovingStates(live.states);

    // ③ 算 K + 產生
    const kResult = await computeMaxDepth(routeConfig);
    if (!kResult.ok) {
      Swal.close();
      await showWarning('算不出最大鏈深', kResult.error);
      return;
    }

    const built = buildStatusJson({
      routeConfig, k: kResult.k, existingApprovingCount: existingCount,
    });
    if (!built.ok) {
      Swal.close();
      await showWarning('產生狀態圖失敗', built.error);
      return;
    }

    // ④ 驗證
    const errs = validateStatusPayload(built.payload);
    if (errs.length > 0) {
      Swal.close();
      await Swal.fire({
        icon: 'error',
        title: '產出的狀態圖沒通過檢查',
        html: '這是程式的問題，請回報：<br><br>' + errs.map((e) => `• ${esc(e)}`).join('<br>'),
        confirmButtonText: '確定',
      });
      return;
    }

    Swal.close();

    // 人工確認 + 備份
    const go = await Swal.fire({
      icon: 'question',
      title: `要為「${esc(formName)}」產生流程設定嗎？`,
      html:
        renderSummary({ ...built, computedK: kResult.k, existingCount, skipped: kResult.skipped }) +
        '<br><br><span style="color:#666">按下「下載備份並繼續」會先把目前的流程設定存成 JSON 檔，' +
        '再寫入<b>測試環境</b>。這一步還不會動到正式環境。</span>',
      showCancelButton: true,
      confirmButtonText: '下載備份並繼續',
      cancelButtonText: '取消',
      width: 680,
    });
    if (!go.isConfirmed) return;

    downloadBackup(formAppId, live);

    // ⑤ PUT preview（帶 revision 防併發）
    Swal.fire({ title: '寫入測試環境…', allowOutsideClick: false });
    Swal.showLoading();
    try {
      await putPreviewStatus({ app: formAppId, revision: live.revision, ...built.payload });
    } catch (err) {
      Swal.close();
      await showWarning('寫入測試環境失敗', `${err.message || err}\n\n如果訊息提到 revision，代表這份設定在你按下按鈕後被別人改過，請重新操作一次。`);
      return;
    }
    Swal.close();

    // ⑥ 人工確認
    const deployOk = await showConfirm(
      '測試環境已更新，要部署到正式環境嗎？',
      `建議先到 App ${formAppId} 的「表單設定 → 流程管理」看一眼再部署。部署後正式環境立即生效。\n\n` +
      `注意：目標狀態上若有在途單且已指定執行者，kintone 會拒絕變更該狀態的執行者設定（GAIA_IL35）。`
    );
    if (!deployOk) {
      await showWarning('已停在測試環境', '設定留在測試環境未部署。你可以稍後從 kintone 畫面手動部署，或按「取消變更」還原。');
      return;
    }

    // ⑦ 部署 + 輪詢
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

    // ⑧ 回寫指紋
    try {
      await kintoneApi('/k/v1/record', 'PUT', {
        app: kintone.app.getId(),
        id: routeConfig.$id.value,
        record: {
          [RTF.MAX_DEPTH]:     { value: String(built.effectiveK) },
          [RTF.DEPLOYED_AT]:   { value: new Date().toISOString() },
          [RTF.DEPLOYED_HASH]: { value: hashRouteConfig(routeConfig, built.effectiveK) },
        },
      });
    } catch (err) {
      await showWarning(
        '流程已部署，但回寫記錄失敗',
        `流程設定本身已經生效。只有 max_depth / deployed_at / deployed_hash 沒寫進去：${err.message || err}`
      );
      return;
    }

    await showSuccess('部署完成');
    location.reload();
  };

  // -------------------------------------------------------------------
  // UI：清單頁按鈕
  // -------------------------------------------------------------------

  /** 撈全部路由設定（含未啟用的，維護者可能就是要為未啟用的先產一份） */
  const fetchAllRouteConfigs = async () => {
    const resp = await kintoneApi('/k/v1/records', 'GET', {
      app: kintone.app.getId(),
      query: 'order by ' + RTF.FORM_APP_ID + ' asc limit 500',
    });
    return resp.records;
  };

  const pickRouteConfig = async (records) => {
    const rows = records.map((r, i) => {
      const active = (r[RTF.IS_ACTIVE]?.value ?? []).includes(CHECKBOX.ACTIVE);
      const steps = (r[RTF.ROUTE_STEPS]?.value ?? []).length;
      const depth = r[RTF.MAX_DEPTH]?.value || '—';
      const hash = r[RTF.DEPLOYED_HASH]?.value || '';
      const stale = hash && hash !== hashRouteConfig(r, Number(r[RTF.MAX_DEPTH]?.value || 0));
      return `
        <label style="display:block;padding:10px 12px;border:1px solid #ddd;border-radius:6px;margin-bottom:8px;cursor:pointer;text-align:left;font-size:15px">
          <input type="radio" name="arRoute" value="${i}" style="margin-right:8px">
          <b>${esc(r[RTF.FORM_NAME]?.value || '(未命名)')}</b>
          <span style="color:#888">（App ${esc(r[RTF.FORM_APP_ID]?.value)}）</span>
          ${active ? '' : '<span style="color:#c00">［未啟用］</span>'}
          <br>
          <span style="color:#666;font-size:13px;margin-left:24px">
            ${steps} 段路由｜已部署 K=${esc(depth)}
            ${stale ? '｜<span style="color:#c00">路由已改，尚未重新部署</span>' : ''}
          </span>
        </label>`;
    }).join('');

    const res = await Swal.fire({
      title: '要為哪一張表單產生流程設定？',
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
    btn.textContent = '產生流程設定';
    btn.className = 'kintoneplugin-button-normal';
    btn.style.cssText = 'margin-left:8px;font-size:15px;padding:6px 16px;cursor:pointer';

    btn.onclick = safeHandler(async () => {
      await ensureFresh(); // 路由／角色／起點三個快取都要最新，這是部署不是預覽
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
    resolveAllSigningPositions,
    hashRouteConfig,
    countApprovingStates,
    computeMaxDepth,
    TPL,
    ACT,
    MAX_K,
  });
})();
