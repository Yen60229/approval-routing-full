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
 */
(() => {
  'use strict';

  const { APP_ID, ROLE_FIELDS: RF, ENTRY_FIELDS: EF, CHECKBOX } =
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
   * 角色與起點兩個快取一起清——buildChain 兩者都會用到，
   * 只清一邊等於沒清（docs/05 評估 #1）。
   *
   * @returns {Promise<void>}
   */
  const ensureFresh = async () => {
    clearRoleCache();
    clearEntryCache();
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
    getGroupMembers,
  });
})();
