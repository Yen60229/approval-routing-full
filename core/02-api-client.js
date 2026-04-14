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
 *   - 角色表（~80 筆）：全量快取，整個頁面生命週期只查一次
 *   - 員工起點（~500 筆）：按需查詢 + 單筆快取，避免重複 API 呼叫
 *   - 快取 key 統一用字串，Map 存取 O(1)
 *
 * 【變更履歷】
 *   2026-04-14  Jimmy/Claude  初版建立
 */
(() => {
  'use strict';

  const { APP_ID, ROLE_FIELDS: RF, ENTRY_FIELDS: EF, CHECKBOX } =
    window.ApprovalRouting.Config;

  // --- 快取 ---
  /** @type {Map<string, Object>} roleId → role record */
  const roleCache = new Map();
  /** @type {boolean} 角色表是否已全量載入 */
  let roleCacheLoaded = false;

  /** @type {Map<string, Object>} employeeCode → entry record */
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
   * 全量載入啟用中的角色到 roleCache
   * 已載入則直接 return（不重複查詢）
   */
  const loadAllRoles = async () => {
    if (roleCacheLoaded) return;

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

    roleCacheLoaded = true;
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
   * 強制清除角色快取（測試模擬器用）
   */
  const clearRoleCache = () => {
    roleCache.clear();
    roleCacheLoaded = false;
  };

  // --- 員工起點對照表 ---

  /**
   * 依員工代碼查起點角色 ID（單筆快取）
   * @param {string} employeeCode - kintone 使用者代碼
   * @returns {Promise<string|null>} entry_role_id 或 null
   */
  const getEntryRoleId = async (employeeCode) => {
    if (entryCache.has(employeeCode)) {
      return entryCache.get(employeeCode);
    }

    const resp = await api('/k/v1/records', 'GET', {
      app: APP_ID.EMPLOYEE_ENTRY,
      query: `${EF.EMPLOYEE} in ("${employeeCode}") and ${EF.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}") limit 1`,
      fields: [EF.ENTRY_ROLE_ID],
    });

    const entryRoleId = resp.records[0]?.[EF.ENTRY_ROLE_ID]?.value ?? null;
    entryCache.set(employeeCode, entryRoleId);
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
    getEntryRoleId,
    getCurrentUserEntryRoleId,
    getGroupMembers,
  });
})();
