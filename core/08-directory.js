/**
 * 後台人事資料存取層 — cybozu User API 的使用者／組織／職務，與 685 選項的對應
 *
 * 抽出來的原因：tools/05（涵蓋率檢查）與 tools/11（人事異動對照）都要
 * 「全公司使用者 + 每個人的所屬組織與職務 + 對應到 685 的 unit_name / title_level」，
 * 兩邊各寫一份的話，對應規則一旦調整就會有一支悄悄跟不上（CLAUDE.md 4.3：禁止重複實作）。
 *
 * 【與 05 的差別】除了 05 原本就要的 orgMap / titleMap（各自攤平去重），
 * 這裡多回一份 **identityMap**：保留「單位 × 職務」的配對。
 * 異動比對非看配對不可——兼任者可能是 A 單位的課長、同時是 B 單位的擔當，
 * 攤平之後「單位有沒有對上」與「職稱有沒有對上」就對不回同一個身分了。
 *
 * 【影響的欄位】
 *   - 無（唯讀；只讀 685 的表單設定取下拉選項）
 *
 * 【依賴】
 *   - core/01-config.js（Config）
 *   - core/04-utils.js（Utils.kintoneApi）
 *   - User API：/v1/users、/v1/organizations、/v1/organization/users
 *     （路徑不帶 /k，直接傳給 kintone.api，與 core/02 的 getGroupMembers 同一種寫法）
 *
 * 【變更履歷】
 *   2026-09-01  Jimmy/Claude  自 tools/05 抽出共用；新增 identityMap（單位×職務配對）
 */
(() => {
  'use strict';

  const { APP_ID, ROLE_FIELDS: RF } = window.ApprovalRouting.Config;
  const { kintoneApi } = window.ApprovalRouting.Utils;

  const CONFIG = Object.freeze({
    USER_PAGE:    100,   // User API 分頁大小上限
    ORG_PARALLEL: 10,    // 組織成員查詢的並行數（控制瞬間 API 量）
  });

  const chunk = (arr, size) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };

  /**
   * User API 通用分頁撈全量（offset + size 迴圈直到不足一頁）
   * @param {string} path - 如 '/v1/users'
   * @param {Object} params - 額外參數（code 等）
   * @param {Function} pluck - 從單頁回應取出項目陣列
   * @returns {Promise<Array>}
   */
  const fetchUserApiAll = async (path, params, pluck) => {
    const all = [];
    let offset = 0;
    while (true) {
      const resp = await kintone.api(path, 'GET', { ...params, offset, size: CONFIG.USER_PAGE });
      const items = pluck(resp) || [];
      all.push(...items);
      if (items.length < CONFIG.USER_PAGE) break;
      offset += CONFIG.USER_PAGE;
    }
    return all;
  };

  /** 全公司使用者，依「使用狀態」分為使用中與已停用兩組 */
  const fetchAllUsers = async () => {
    const users = await fetchUserApiAll('/v1/users', {}, (r) => r.users);
    const shape = (u) => ({ code: u.code, name: u.name || u.code });
    return {
      actives:   users.filter((u) => u.valid !== false).map(shape),
      inactives: users.filter((u) => u.valid === false).map(shape),
    };
  };

  /**
   * 建立 使用者帳號 → 所屬單位 / 職務 的對照
   *
   * 作法：撈全部組織 → 逐組織撈成員（並行分批），一人可屬多個組織。
   * kintone 的職務掛在「人 × 組織」上（userTitles[].title），所以同一個人在不同組織
   * 可以有不同職務。三份對照都由同一次掃描產生，不會多打一輪 API。
   *
   * @returns {Promise<{
   *   orgMap: Map<string, string[]>,      // 帳號 → 單位名稱（去重前的出現順序）
   *   titleMap: Map<string, string[]>,    // 帳號 → 職務名稱（去重）
   *   identityMap: Map<string, Array<{unit: string, title: string}>>  // 帳號 → 單位×職務配對
   * }>}
   */
  const fetchDirectory = async () => {
    const orgs = await fetchUserApiAll('/v1/organizations', {}, (r) => r.organizations);
    const orgMap = new Map();
    const titleMap = new Map();
    const identityMap = new Map();

    for (const part of chunk(orgs, CONFIG.ORG_PARALLEL)) {
      await Promise.all(part.map(async (org) => {
        // 回應格式為 { userTitles: [{ user, title }] }，保守起見也相容 users 形式
        const entries = await fetchUserApiAll(
          '/v1/organization/users',
          { code: org.code },
          (r) => (r.userTitles ? r.userTitles : (r.users || []).map((u) => ({ user: u, title: null }))),
        );
        for (const entry of entries) {
          const u = entry?.user;
          if (!u?.code) continue;
          const title = entry.title?.name || '';

          if (!orgMap.has(u.code)) orgMap.set(u.code, []);
          orgMap.get(u.code).push(org.name);

          if (!identityMap.has(u.code)) identityMap.set(u.code, []);
          identityMap.get(u.code).push({ unit: org.name, title });

          if (!title) continue;
          if (!titleMap.has(u.code)) titleMap.set(u.code, []);
          const list = titleMap.get(u.code);
          if (!list.includes(title)) list.push(title);
        }
      }));
    }
    return { orgMap, titleMap, identityMap };
  };

  /**
   * 685 的表單設定：unit_name / title_level 的下拉選項，以及 role_name 是不是計算欄位
   *
   * 用 REST API 而不是 kintone.app.getFormFields()——後者拿的是「目前這個 App」的欄位，
   * 這些工具在 685 與 686 兩張表都掛著，從 686 開會拿到 686 的欄位。
   *
   * 讀不到就回空選項（不是丟例外）：這只影響「就地新建／改單位職稱」這類附加功能，
   * 沒必要讓整份報告開不起來。
   *
   * @returns {Promise<{unitOptions: string[], titleOptions: string[],
   *                    roleNameIsCalc: boolean, error: string}>}
   */
  const fetchRoleFormFields = async () => {
    try {
      const resp = await kintoneApi('/k/v1/app/form/fields.json', 'GET',
        { app: APP_ID.ROLE_DEFINITION });
      const props = resp.properties || {};
      const optionsOf = (code) => Object.values(props[code]?.options || {})
        .sort((a, b) => Number(a.index) - Number(b.index))
        .map((o) => o?.label)
        .filter(Boolean);

      return {
        unitOptions:  optionsOf(RF.UNIT_NAME),
        titleOptions: optionsOf(RF.TITLE_LEVEL),
        // 計算欄位不接受寫入，新建記錄一律不要帶 role_name
        roleNameIsCalc: (props[RF.ROLE_NAME]?.type || '') === 'CALC',
        error: '',
      };
    } catch (err) {
      console.warn('[ApprovalRouting] 讀取 685 表單設定失敗，需要選項的功能停用', err);
      return {
        unitOptions: [], titleOptions: [], roleNameIsCalc: true,
        error: err?.message || String(err),
      };
    }
  };

  /**
   * 由 kintone 職務推測對應的 title_level 選項
   *
   * 比對順序（職稱通常落在字串結尾，所以先比結尾）：
   *   1. 完全相同           職務「課長」       → 課長
   *   2. 以選項結尾，取最長   職務「資訊本部長」 → 本部長（不是「部長」）
   *   3. 包含選項，取最靠後   職務「總經理室 擔當」→ 擔當（不是「總經理」）
   * 都沒中就回空字串，不亂猜，交給 HR 自己選。
   *
   * @returns {{value: string, exact: boolean}} value 為空表示無法對應
   */
  const guessTitleLevel = (jobTitle, options = []) => {
    const raw = String(jobTitle || '').trim();
    if (!raw || !options.length) return { value: '', exact: false };

    const exact = options.find((opt) => opt === raw);
    if (exact) return { value: exact, exact: true };

    const bySuffix = options
      .filter((opt) => opt && raw.endsWith(opt))
      .sort((a, b) => b.length - a.length)[0];
    if (bySuffix) return { value: bySuffix, exact: false };

    const byPosition = options
      .filter((opt) => opt && raw.includes(opt))
      .sort((a, b) => (raw.lastIndexOf(b) - raw.lastIndexOf(a)) || (b.length - a.length))[0];

    return byPosition ? { value: byPosition, exact: false } : { value: '', exact: false };
  };

  /**
   * 由 kintone 組織名稱對應 685 的 unit_name 選項
   *
   * 單位只接受完全相同（去頭尾空白）——組織名稱像「倉儲（TEPZ）」這種帶括號的，
   * 用模糊比對很容易配到隔壁單位，配錯就是整組人的簽核鏈都跑錯地方。
   *
   * @returns {string} 對不上時回空字串，由 HR 自己挑
   */
  const guessUnitName = (orgName, options = []) => {
    const raw = String(orgName || '').trim();
    return options.find((opt) => opt.trim() === raw) || '';
  };

  window.ApprovalRouting = window.ApprovalRouting || {};
  window.ApprovalRouting.Directory = Object.freeze({
    fetchUserApiAll,
    fetchAllUsers,
    fetchDirectory,
    fetchRoleFormFields,
    guessTitleLevel,
    guessUnitName,
  });
})();
