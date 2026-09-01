/**
 * API 客戶端 — REST API 封裝 + Cache Map
 *
 * 【影響的欄位】
 *   - 無直接影響，為 chain-builder 提供資料存取層
 *
 * 【依賴】
 *   - core/01-config.js（Config）
 *
 * 【設計說明】
 *   - 角色表（~80 筆）：全量快取，TTL 5 分鐘，Promise singleton 防並發
 *   - 員工起點（~500 筆）：按需查詢 + 單筆快取，避免重複 API 呼叫
 *   - 快取 key 統一用字串，Map 存取 O(1)
 *
 * 【變更履歷】
 *   2026-04-18  Jimmy/Claude  初版建立
 *   2026-04-18  Jimmy/Claude  加入 TTL + Promise singleton 防 race condition
 *   2026-04-18  Jimmy/Claude  新增 clearEntryCache 供測試環境使用
 *   2026-08-31  Jimmy/Claude  entryCache 補 TTL（60 秒）並新增 ensureFresh()
 *                              一次清角色＋起點兩個快取（docs/05 評估 #1）
 *   2026-08-31  Jimmy/Claude  P8 Phase B：新增 form_route_config 全量快取
 *                              （getRouteConfig / clearRouteConfigCache，比照 loadAllRoles
 *                              三道防線）；ensureFresh 一併清路由快取
 *   2026-09-01  Jimmy/Claude  P8 Phase C：新增 getDistinctEntryRoleIds()，
 *                              產生器算 K 值取 686 的 distinct 起點（~80）而非掃全員（~500）
 */
(() => {
  'use strict';

  const { APP_ID, ROLE_FIELDS: RF, ENTRY_FIELDS: EF, ROUTE_FIELDS: RCF, CHECKBOX } =
    window.ApprovalRouting.Config;

  // --- 快取 ---
  /** 角色快取 TTL（毫秒），超過後下次查詢會重新載入 */
  const ROLE_CACHE_TTL_MS = 5 * 60 * 1000;

  /** @type {Map<string, Object>} roleId → role record */
  const roleCache = new Map();
  /** @type {number} 角色快取載入時間戳；0 表示未載入 */
  let roleCacheLoadedAt = 0;
  /** @type {Promise<void>|null} 正在進行中的載入 promise；用來防止並發重複 fetch */
  let roleLoadPromise = null;

  /**
   * 員工起點快取 TTL（毫秒）
   * 比角色表短：起點表是按需單筆查詢，重查成本低，資料新鮮度優先
   */
  const ENTRY_CACHE_TTL_MS = 60 * 1000;

  /** @type {Map<string, {value: string|null, at: number}>} employeeCode → 起點角色 + 寫入時戳 */
  const entryCache = new Map();

  /**
   * 表單路由設定快取 TTL（毫秒）— 比照角色表 5 分鐘（docs/06 §4.1）
   * 路由表約 40-50 筆，全量快取；由 IT／表單窗口在部署期維護，變動頻率低
   */
  const ROUTE_CACHE_TTL_MS = 5 * 60 * 1000;

  /** @type {Map<string, Object>} form_app_id（字串）→ route config record */
  const routeConfigCache = new Map();
  /** @type {number} 路由快取載入時間戳；0 表示未載入 */
  let routeConfigLoadedAt = 0;
  /** @type {Promise<void>|null} 進行中的載入 promise，防並發重複 fetch */
  let routeConfigLoadPromise = null;

  /**
   * 底層 REST API 呼叫
   * @param {string} path
   * @param {string} method
   * @param {Object} body
   */
  const api = (path, method, body) =>
    kintone.api(kintone.api.url(path, true), method, body);

  // --- 角色定義表 ---

  /**
   * 判斷快取是否仍新鮮（在 TTL 內）
   * @returns {boolean}
   */
  const isCacheFresh = () =>
    roleCacheLoadedAt > 0 && Date.now() - roleCacheLoadedAt < ROLE_CACHE_TTL_MS;

  /**
   * 全量載入啟用中的角色到 roleCache
   *
   * 三道防線：
   *   1. 快取仍新鮮 → 直接 return（零 API 呼叫）
   *   2. 有其他呼叫正在 fetch → 複用該 promise（防並發 race condition）
   *   3. 真正執行 fetch → 寫入快取 + 更新時間戳
   */
  const loadAllRoles = () => {
    if (isCacheFresh()) return Promise.resolve();
    if (roleLoadPromise) return roleLoadPromise;

    roleLoadPromise = (async () => {
      try {
        // TTL 過期時，先清舊資料避免混用
        roleCache.clear();

        let offset = 0;
        const limit = 500;

        // kintone 單次最多 500 筆，超過 80 筆用 while 保險
        while (true) {
          const resp = await api('/k/v1/records', 'GET', {
            app: APP_ID.ROLE_DEFINITION,
            query: `${RF.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}") limit ${limit} offset ${offset}`,
          });

          for (const rec of resp.records) {
            roleCache.set(rec[RF.ROLE_ID].value, rec);
          }

          if (resp.records.length < limit) break;
          offset += limit;
        }

        roleCacheLoadedAt = Date.now();
      } finally {
        // 無論成功或失敗都要清掉 promise，失敗時讓下次呼叫可重試
        roleLoadPromise = null;
      }
    })();

    return roleLoadPromise;
  };

  /**
   * 取得單一角色（從快取，未載入時先全量載入）
   * @param {string} roleId
   * @returns {Promise<Object|null>}
   */
  const getRole = async (roleId) => {
    await loadAllRoles();
    return roleCache.get(roleId) ?? null;
  };

  /**
   * 取得所有啟用角色（從快取）
   * @returns {Promise<Map<string, Object>>}
   */
  const getAllRoles = async () => {
    await loadAllRoles();
    return roleCache;
  };

  /**
   * 強制清除角色快取（測試模擬器用 / submit 前用）
   */
  const clearRoleCache = () => {
    roleCache.clear();
    roleCacheLoadedAt = 0;
    roleLoadPromise = null;
  };

  /**
   * 清除員工起點快取（測試環境 / 批量匯入後用）
   */
  const clearEntryCache = () => {
    entryCache.clear();
  };

  /**
   * 強制重新載入角色快取（不含起點快取）
   *
   * ⚠️ 一般情境請改用 `ensureFresh()`。只清角色不清起點，
   *    「保證資料最新」的承諾會在鏈的第一關就落空。
   *
   * @returns {Promise<void>}
   */
  const ensureFreshRoles = async () => {
    clearRoleCache();
    await loadAllRoles();
  };

  /**
   * 強制重新載入所有快取（submit 前確保資料最新）
   *
   * 角色、起點、路由三個快取一起清——buildChain / buildChainForForm 都會用到，
   * 只清一部分等於沒清（docs/05 評估 #1）。路由表在部署期可能剛被重新部署，
   * submit 時也要拿到最新的段設定。
   *
   * @returns {Promise<void>}
   */
  const ensureFresh = async () => {
    clearRoleCache();
    clearEntryCache();
    clearRouteConfigCache();
    await loadAllRoles();
  };

  // --- 員工起點對照表 ---

  /**
   * 依員工代碼查起點角色 ID（單筆快取 + TTL）
   *
   * ⚠️ 快取一定要有 TTL：HR 改了某員工的起點角色後，若快取永不失效，
   *    開著的頁面會一直拿到舊值——而錯的是鏈的第一關，整條鏈都會錯。
   *
   * @param {string} employeeCode - kintone 使用者代碼
   * @returns {Promise<string|null>} entry_role_id 或 null
   */
  const getEntryRoleId = async (employeeCode) => {
    const cached = entryCache.get(employeeCode);
    if (cached && Date.now() - cached.at < ENTRY_CACHE_TTL_MS) {
      return cached.value;
    }

    const resp = await api('/k/v1/records', 'GET', {
      app: APP_ID.EMPLOYEE_ENTRY,
      query: `${EF.EMPLOYEE} in ("${employeeCode}") and ${EF.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}") limit 1`,
      fields: [EF.ENTRY_ROLE_ID],
    });

    const entryRoleId = resp.records[0]?.[EF.ENTRY_ROLE_ID]?.value ?? null;
    entryCache.set(employeeCode, { value: entryRoleId, at: Date.now() });
    return entryRoleId;
  };

  /**
   * 取得目前登入使用者的起點角色 ID
   * @returns {Promise<string|null>}
   */
  const getCurrentUserEntryRoleId = async () => {
    const userCode = kintone.getLoginUser().code;
    return getEntryRoleId(userCode);
  };

  /**
   * 取得「所有被當成起點用到的角色 ID」（去重）
   *
   * 產生器算 K 值（最大鏈深）用。**不要掃 500 名員工各展開一次**——
   * 鏈的深度只取決於從哪個角色起步，500 名員工其實只對應約 80 個 distinct
   * 起點角色，展開次數差 6 倍以上，而結果完全相同。
   *
   * 只取啟用中的起點：已停用的員工不會送單，他們的起點不該撐大 K
   * （K 變大 = 流程狀態變多 = 每個表單都要多部署幾個用不到的狀態）。
   *
   * @returns {Promise<string[]>} 去重後的 entry_role_id，不含空值
   */
  const getDistinctEntryRoleIds = async () => {
    const ids = new Set();
    let offset = 0;
    const limit = 500;

    while (true) {
      const resp = await api('/k/v1/records', 'GET', {
        app: APP_ID.EMPLOYEE_ENTRY,
        query: `${EF.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}") limit ${limit} offset ${offset}`,
        fields: [EF.ENTRY_ROLE_ID],
      });

      for (const rec of resp.records) {
        const id = rec[EF.ENTRY_ROLE_ID]?.value;
        if (id) ids.add(id);
      }

      if (resp.records.length < limit) break;
      offset += limit;
    }

    return [...ids];
  };

  // --- 表單路由設定表（form_route_config, App 3）---

  /**
   * 全量載入啟用中的路由設定到 routeConfigCache
   *
   * 三道防線與 loadAllRoles 相同：
   *   1. 快取仍新鮮（TTL 內）→ 直接 return
   *   2. 有其他呼叫正在 fetch → 複用該 promise（防並發 race condition）
   *   3. 真正執行 fetch → 寫入快取 + 更新時間戳
   *
   * 只載入 is_active =「啟用中」的記錄：未啟用的表單在 getRouteConfig 視同查無，
   * adapter 會走 fallback 全鏈（docs/06 §4）。
   */
  const loadAllRouteConfigs = () => {
    const fresh =
      routeConfigLoadedAt > 0 && Date.now() - routeConfigLoadedAt < ROUTE_CACHE_TTL_MS;
    if (fresh) return Promise.resolve();
    if (routeConfigLoadPromise) return routeConfigLoadPromise;

    routeConfigLoadPromise = (async () => {
      try {
        routeConfigCache.clear();

        let offset = 0;
        const limit = 500;

        while (true) {
          const resp = await api('/k/v1/records', 'GET', {
            app: APP_ID.FORM_ROUTE_CONFIG,
            query: `${RCF.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}") limit ${limit} offset ${offset}`,
          });

          for (const rec of resp.records) {
            // key 統一用字串：form_app_id 是數值欄，adapter 端以 kintone.app.getId() 查詢
            routeConfigCache.set(String(rec[RCF.FORM_APP_ID].value), rec);
          }

          if (resp.records.length < limit) break;
          offset += limit;
        }

        routeConfigLoadedAt = Date.now();
      } finally {
        routeConfigLoadPromise = null;
      }
    })();

    return routeConfigLoadPromise;
  };

  /**
   * 依申請 App ID 取得路由設定（從快取，未載入時先全量載入）
   * @param {number|string} formAppId
   * @returns {Promise<Object|null>} route config record，查無或未啟用時回 null
   */
  const getRouteConfig = async (formAppId) => {
    await loadAllRouteConfigs();
    return routeConfigCache.get(String(formAppId)) ?? null;
  };

  /**
   * 清除路由設定快取（測試環境 / 部署後 / ensureFresh 內用）
   */
  const clearRouteConfigCache = () => {
    routeConfigCache.clear();
    routeConfigLoadedAt = 0;
    routeConfigLoadPromise = null;
  };

  // --- 群組成員 ---

  /**
   * 取得群組成員代碼清單
   * @param {string} groupCode
   * @returns {Promise<string[]>} 成員 code 陣列
   */
  const getGroupMembers = async (groupCode) => {
    const members = await kintone.api(
      kintone.api.url('/k/v1/group/users', true),
      'GET',
      { code: groupCode }
    );
    return members.users.map((u) => u.code);
  };

  // 掛到全域
  window.ApprovalRouting = window.ApprovalRouting || {};
  window.ApprovalRouting.ApiClient = Object.freeze({
    getRole,
    getAllRoles,
    clearRoleCache,
    clearEntryCache,
    ensureFresh,
    ensureFreshRoles,
    getEntryRoleId,
    getCurrentUserEntryRoleId,
    getDistinctEntryRoleIds,
    getRouteConfig,
    clearRouteConfigCache,
    getGroupMembers,
  });
})();
