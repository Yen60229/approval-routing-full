/**
 * 涵蓋率檢查工具 — 找出「使用中但尚未納入簽核系統」的使用者，並可就地補設定
 *
 * 在角色定義表（685）或員工起點對照表（686）的列表頁加入「未設定名單」按鈕，
 * 掃描後以報告呈現六類問題，並提供快速處理：
 *   A. 未設定起點 — 使用中、但 686 沒有起點記錄的人（無法送單，最優先處理）
 *        → 勾選多人 + 選一個起點角色 → 批量建立 686 記錄
 *   B. 不具簽核身分 — 使用中、但不在任何角色的 holder_user、也不在任何簽核群組的人
 *        → 勾選多人 + 選一個「指定個人」角色 → 批量加入該角色的 holder_user
 *          （同名角色視為同一關卡，會一併寫入所有同名記錄，維持一致性；
 *            群組型角色的成員仍由 IT 在 cybozu 後台維護，本工具不碰）
 *   C. 已停用仍有起點 — kintone 帳號已停用、686 起點記錄卻仍啟用中
 *        → 勾選多人 → 批量取消「啟用中」（保留記錄不刪除）
 *   D. 已停用仍是簽核者 — 帳號已停用卻仍掛在角色的 holder_user 上，
 *      流程跑到該關會卡死（停用帳號無法登入簽核）
 *        → 勾選多人 → 批量取消該角色的「啟用中」（與 C 區一致）；
 *          **holder_user 一律不動**——簽核者名單是人工維護的資產，誤刪無法自動復原。
 *          若該角色還有其他在職簽核者，停用會一併影響他們，確認視窗會醒目警告。
 *          停用帳號若在「簽核群組」內，工具無法處理，列為提醒請 IT 至後台移除
 *   E. 姓名格式異常 — 姓名未同時具備中文與英文的帳號（只有中文、只有英文，
 *      或純數字／代號／符號），多為系統、測試、整合用帳號或姓名尚未補齊者
 *        → 純檢視分頁（可篩選、匯出 CSV），且已自 A～D 排除，
 *          避免這些帳號每次掃描都佔據待處理清單
 *   F. 角色沒有簽核者 — 啟用中、holder_type 是「指定個人」、卻沒指定任何簽核者的角色
 *        → 勾選多筆 → 批量取消「啟用中」讓壞掉的關卡退場（記錄保留）
 *          「鏈上游」欄顯示有幾個角色的 next_role_id 指向它；有上游者停用會使那些鏈
 *          建立失敗（角色快取只載入啟用中的記錄），確認視窗會醒目警告
 *
 * 【影響的欄位】
 *   - 686 employee / entry_role_id / is_active：A 區批量建立寫入；C 區取消啟用中
 *   - 685 holder_user：只有 B 區會寫入，且一律「附加」（不覆蓋、不移除既有簽核者）
 *   - 685 is_active：D 區與 F 區取消勾選（停用整筆角色記錄）
 *
 * 【依賴】
 *   - core/01-config.js（Config）
 *   - core/04-utils.js（Utils）
 *   - User API：/v1/users、/v1/organizations、/v1/organization/users、/v1/group/users
 *     （路徑不帶 /k、直接傳給 kintone.api，與 04-chain-preview 實測可行的方式一致）
 *
 * 【變更履歷】
 *   2026-07-12  Jimmy/Claude  初版建立
 *   2026-07-12  Jimmy/Claude  新增 C/D 區：已停用帳號的反向清理（停用起點記錄、
 *                             自 holder_user 移除），並提醒 IT 處理群組內的停用帳號
 *   2026-08-19  Jimmy/Claude  A/B 區底部「選擇角色」由原生下拉改為可打字搜尋的選擇器
 *                             （角色數量多時下拉難找），支援關鍵字過濾與 ↑↓/Enter 選取
 *   2026-08-19  Jimmy/Claude  新增 E 區：姓名未同時具備中文與英文的帳號獨立歸類，
 *                             並自 A～D 排除
 *   2026-08-19  Jimmy/Claude  各分頁人員清單新增「職稱」欄（取自 kintone 組織設定），
 *                             可一併搜尋，CSV 匯出同步加欄
 *   2026-08-19  Jimmy/Claude  D 區改為只取消角色的「啟用中」，不再刪除 holder_user
 *                             （簽核者名單誤刪無法自動復原，工具一律不碰）
 *   2026-08-19  Jimmy/Claude  新增 F 區：找出沒有簽核者的啟用角色，可批量取消啟用中；
 *                             同時警示會斷掉幾條簽核鏈
 *   2026-08-19  Jimmy/Claude  C/D 區標示「疑似回任」：停用帳號若有同名的使用中帳號，
 *                             提示應改指到新帳號，而非只是把舊設定停用
 */
(() => {
  'use strict';

  const { APP_ID, ROLE_FIELDS: RF, ENTRY_FIELDS: EF, CHECKBOX, HOLDER_TYPE_OPTIONS: HT } =
    window.ApprovalRouting.Config;
  const { safeHandler, kintoneApi, showWarning } = window.ApprovalRouting.Utils;

  const CONFIG = Object.freeze({
    BTN_ID:      'ar-coverage-check-btn',
    OVERLAY_ID:  'ar-coverage-overlay',
    USER_PAGE:   100,   // User API 分頁大小上限
    RECORD_PAGE: 500,   // records API 單次上限
    WRITE_BATCH: 100,   // records 批量寫入上限
    ORG_PARALLEL: 10,   // 組織成員查詢的並行數（控制瞬間 API 量）
  });

  const UNGROUPED_LABEL = '（未分類）';

  // 姓名「正常」的判定：中文字與英文字母「兩者都要有」（例：王小明 Jimmy Wang）。
  // 只有中文、只有英文、或兩者皆無（純數字、代號、符號…）都算格式異常，
  // 統一歸到 E 區單獨檢視，不干擾 A～D 的判讀。
  // 中文涵蓋：基本區 U+4E00–9FFF、擴充 A 區、相容表意文字；英文含全形字母
  const CJK_RE   = /[㐀-䶿一-鿿豈-﫿]/;
  const LATIN_RE = /[A-Za-zＡ-Ｚａ-ｚ]/;
  const isOddName = (u) => {
    const name = u.name || '';
    return !(CJK_RE.test(name) && LATIN_RE.test(name));
  };

  // ═══════════════════════════════════════════════════════════════════
  // 資料讀取
  // ═══════════════════════════════════════════════════════════════════

  /** 陣列切批 */
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

  /** kintone records 通用分頁撈全量（offset 適用：兩表資料量在數百～千級） */
  const fetchRecordsAll = async (app, fields, condition) => {
    const all = [];
    let offset = 0;
    while (true) {
      const resp = await kintoneApi('/k/v1/records', 'GET', {
        app,
        fields,
        query: `${condition} limit ${CONFIG.RECORD_PAGE} offset ${offset}`,
      });
      all.push(...resp.records);
      if (resp.records.length < CONFIG.RECORD_PAGE) break;
      offset += CONFIG.RECORD_PAGE;
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
   * 建立 使用者帳號 → 所屬單位 / 職稱 的對照
   *
   * 作法：撈全部組織 → 逐組織撈成員（並行分批），一人可屬多個組織。
   * kintone 的職稱掛在「人 × 組織」上（userTitles[].title），兼任者可能有多個職稱，
   * 一併收集去重，讓報告能直接看出這人是不是主管，不用再回後台查。
   *
   * @returns {Promise<{orgMap: Map<string, string[]>, titleMap: Map<string, string[]>}>}
   */
  const fetchUserOrgMap = async () => {
    const orgs = await fetchUserApiAll('/v1/organizations', {}, (r) => r.organizations);
    const orgMap = new Map();
    const titleMap = new Map();

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

          if (!orgMap.has(u.code)) orgMap.set(u.code, []);
          orgMap.get(u.code).push(org.name);

          const title = entry.title?.name || '';
          if (!title) continue;
          if (!titleMap.has(u.code)) titleMap.set(u.code, []);
          const list = titleMap.get(u.code);
          if (!list.includes(title)) list.push(title);
        }
      }));
    }
    return { orgMap, titleMap };
  };

  /**
   * 685 啟用角色的簽核者資料
   * @returns {Promise<{holderCodes: Set<string>, roles: Array}>}
   *   holderCodes：具簽核身分的帳號集合（holder_user ∪ 各群組成員）
   *   roles：啟用角色清單（含 recordId 與現有 holder_user，供 B 區快速指派）
   */
  const fetchRoleCoverage = async () => {
    const records = await fetchRecordsAll(
      APP_ID.ROLE_DEFINITION,
      ['$id', RF.ROLE_ID, RF.ROLE_NAME, RF.HOLDER_TYPE, RF.HOLDER_USER, RF.HOLDER_GROUP,
       RF.UNIT_NAME, RF.NEXT_ROLE_ID],
      `${RF.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}")`,
    );

    const holderCodes = new Set();
    const groupNameByCode = new Map();   // 群組代碼 → 顯示名稱（供停用帳號提醒使用）
    const roles = [];

    for (const rec of records) {
      const holderType = rec[RF.HOLDER_TYPE]?.value || '';
      const holderUsers = (rec[RF.HOLDER_USER]?.value || []).map((u) => u.code);
      holderUsers.forEach((c) => holderCodes.add(c));
      (rec[RF.HOLDER_GROUP]?.value || []).forEach((g) => groupNameByCode.set(g.code, g.name || g.code));

      roles.push({
        recordId: rec.$id.value,
        roleId: rec[RF.ROLE_ID]?.value || '',
        roleName: rec[RF.ROLE_NAME]?.value || '',
        unitName: rec[RF.UNIT_NAME]?.value || '',
        nextRoleId: rec[RF.NEXT_ROLE_ID]?.value || '',
        holderType,
        holderUsers,
      });
    }

    // 展開所有簽核群組的成員（並行，群組數量級：數十）；保留逐群組名單供停用檢查
    const groupMembers = new Map();      // 群組代碼 → 成員帳號[]
    for (const part of chunk([...groupNameByCode.keys()], CONFIG.ORG_PARALLEL)) {
      await Promise.all(part.map(async (code) => {
        const members = await fetchUserApiAll('/v1/group/users', { code }, (r) => r.users);
        const codes = members.map((u) => u?.code).filter(Boolean);
        groupMembers.set(code, codes);
        codes.forEach((c) => holderCodes.add(c));
      }));
    }

    return { holderCodes, roles, groupMembers, groupNameByCode };
  };

  /** 686 啟用中的起點記錄（含記錄編號，供 C 區停用清理使用） */
  const fetchEntryRecords = async () => {
    const records = await fetchRecordsAll(
      APP_ID.EMPLOYEE_ENTRY,
      ['$id', EF.EMPLOYEE],
      `${EF.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}")`,
    );
    const codes = new Set();
    const recordIdsByCode = new Map();
    for (const rec of records) {
      for (const u of rec[EF.EMPLOYEE]?.value || []) {
        codes.add(u.code);
        if (!recordIdsByCode.has(u.code)) recordIdsByCode.set(u.code, []);
        recordIdsByCode.get(u.code).push(rec.$id.value);
      }
    }
    return { codes, recordIdsByCode };
  };

  /** 主掃描：組出報告資料模型 */
  const runScan = async () => {
    const [{ actives, inactives }, { orgMap, titleMap }, roleCoverage, entryData] = await Promise.all([
      fetchAllUsers(),
      fetchUserOrgMap(),
      fetchRoleCoverage(),
      fetchEntryRecords(),
    ]);

    const jobTitleOf = (code) => (titleMap.get(code) || []).join('、');

    // 離職又回鍋的同事：舊帳號已停用、新帳號使用中，姓名相同但登入名稱不同。
    // 停用狀態一律以 code 判定（見 fetchAllUsers 的 valid 過濾），這裡只是額外
    // 用姓名找出「疑似同一人的新帳號」，提示 HR 該把設定改指到新帳號而非單純停用。
    const activeCodesByName = new Map();
    for (const u of actives) {
      const key = (u.name || '').trim();
      if (!key) continue;
      if (!activeCodesByName.has(key)) activeCodesByName.set(key, []);
      activeCodesByName.get(key).push(u.code);
    }
    const rehiredNote = (u) => {
      const others = (activeCodesByName.get((u.name || '').trim()) || [])
        .filter((c) => c !== u.code);
      return others.length ? `疑似回任 → 使用中帳號：${others.join('、')}` : '';
    };

    const decorate = (u) => ({
      ...u,
      units: orgMap.get(u.code) || [UNGROUPED_LABEL],
      jobTitle: jobTitleOf(u.code),
    });

    // E：姓名不含中文也不含英文者先抽離，A～D 只處理「像真人」的帳號，
    //    避免系統／測試帳號長期掛在清單上、每次掃描都要重新略過
    const normalActives   = actives.filter((u) => !isOddName(u));
    const normalInactives = inactives.filter((u) => !isOddName(u));
    const oddNames = [
      ...actives.filter(isOddName).map((u) => ({ ...decorate(u), status: '使用中' })),
      ...inactives.filter(isOddName).map((u) => ({ ...decorate(u), status: '已停用' })),
    ].map((u) => ({
      ...u,
      // 第三欄兼作狀態欄：狀態排在最前面，上方的篩選下拉就能直接依狀態挑
      units: [u.status, ...u.units],
    }));

    // C：帳號已停用、686 起點記錄卻仍啟用中（帶記錄編號供批量停用）
    const staleEntries = normalInactives
      .filter((u) => entryData.codes.has(u.code))
      .map((u) => ({
        ...decorate(u),
        note: rehiredNote(u),
        recordIds: entryData.recordIdsByCode.get(u.code) || [],
      }));

    // D：帳號已停用、仍掛在角色的 holder_user 上（第三欄改列「擔任角色」方便定位）
    const staleHolders = normalInactives
      .map((u) => {
        const held = roleCoverage.roles.filter((r) => r.holderUsers.includes(u.code));
        return held.length
          ? {
              ...u,
              jobTitle: jobTitleOf(u.code),
              note: rehiredNote(u),
              units: [...new Set(held.map((r) => r.roleName))],
            }
          : null;
      })
      .filter(Boolean);

    // F：啟用中、holder_type 是「指定個人」、卻沒有指定任何簽核者的角色。
    //    流程跑到這關沒人能簽，屬於壞掉的關卡，直接取消「啟用中」讓它退場。
    //    同時算出「有幾個角色的 next_role_id 指向它」，停用前要知道會斷掉幾條鏈。
    const inboundCount = new Map();
    roleCoverage.roles.forEach((r) => {
      if (!r.nextRoleId) return;
      inboundCount.set(r.nextRoleId, (inboundCount.get(r.nextRoleId) || 0) + 1);
    });

    const emptyRoles = roleCoverage.roles
      .filter((r) => r.holderType === HT.USER && r.holderUsers.length === 0)
      .map((r) => {
        const inbound = inboundCount.get(r.roleId) || 0;
        return {
          ...r,
          code: r.roleId,
          name: r.roleName,
          jobTitle: inbound ? `${inbound} 條鏈指向` : '',
          units: [r.unitName || r.roleName.split('_')[0] || UNGROUPED_LABEL],
          inbound,
        };
      })
      .sort((a, b) => b.inbound - a.inbound || a.name.localeCompare(b.name, 'zh-Hant'));

    // 簽核群組內的停用帳號：工具無法改群組成員，列為提醒請 IT 處理
    const inactiveNameByCode = new Map(inactives.map((u) => [u.code, u.name]));
    const groupWarnings = [];
    for (const [gCode, members] of roleCoverage.groupMembers) {
      const bad = members.filter((c) => inactiveNameByCode.has(c))
        .map((c) => inactiveNameByCode.get(c));
      if (bad.length) {
        groupWarnings.push(`${roleCoverage.groupNameByCode.get(gCode) || gCode}：${bad.join('、')}`);
      }
    }

    return {
      totalActive: actives.length,
      totalInactive: inactives.length,
      noEntry:  normalActives.filter((u) => !entryData.codes.has(u.code)).map(decorate),
      noHolder: normalActives.filter((u) => !roleCoverage.holderCodes.has(u.code)).map(decorate),
      staleEntries,
      staleHolders,
      oddNames,
      emptyRoles,
      // D 區判斷「這個角色是否還有活著的簽核者」用
      inactiveCodes: new Set(inactives.map((u) => u.code)),
      groupWarnings,
      roles: roleCoverage.roles,
    };
  };

  // ═══════════════════════════════════════════════════════════════════
  // 寫入動作
  // ═══════════════════════════════════════════════════════════════════

  /** A 區：批量建立 686 起點記錄 */
  const createEntries = async (userCodes, roleId) => {
    for (const part of chunk(userCodes, CONFIG.WRITE_BATCH)) {
      await kintoneApi('/k/v1/records', 'POST', {
        app: APP_ID.EMPLOYEE_ENTRY,
        records: part.map((code) => ({
          [EF.EMPLOYEE]:      { value: [{ code }] },
          [EF.ENTRY_ROLE_ID]: { value: roleId },
          [EF.IS_ACTIVE]:     { value: [CHECKBOX.ACTIVE] },
        })),
      });
    }
  };

  /**
   * B 區：把使用者「附加」到指定角色名稱的 holder_user
   * 同名角色視為同一關卡，一併更新所有同名的「指定個人」記錄，維持一致性
   */
  const assignHolders = async (userCodes, roleName, roles) => {
    const targets = roles.filter(
      (r) => r.roleName === roleName && r.holderType === HT.USER,
    );
    const updates = targets.map((r) => ({
      id: r.recordId,
      record: {
        [RF.HOLDER_USER]: {
          // 既有成員 + 新成員去重後附加，不覆蓋原設定
          value: [...new Set([...r.holderUsers, ...userCodes])].map((code) => ({ code })),
        },
      },
    }));

    for (const part of chunk(updates, CONFIG.WRITE_BATCH)) {
      await kintoneApi('/k/v1/records', 'PUT', {
        app: APP_ID.ROLE_DEFINITION,
        records: part,
      });
    }
    return targets.length;
  };

  /** C 區：批量停用 686 起點記錄（取消勾選「啟用中」，記錄保留不刪除） */
  const deactivateEntries = async (recordIds) => {
    const updates = recordIds.map((id) => ({
      id,
      record: { [EF.IS_ACTIVE]: { value: [] } },
    }));
    for (const part of chunk(updates, CONFIG.WRITE_BATCH)) {
      await kintoneApi('/k/v1/records', 'PUT', { app: APP_ID.EMPLOYEE_ENTRY, records: part });
    }
  };

  /**
   * D 區前置計算：選定的停用帳號掛在哪些角色上，停用這些角色會影響誰
   *
   * 只取消勾選「啟用中」，holder_user 一律原封不動——簽核者名單是人工維護的資產，
   * 誤刪無法自動復原，所以本工具不碰。
   *
   * @returns {{updates: Array, roleNames: string[], shared: Array<{roleName: string, others: number}>}}
   *   updates  ：要送出的 PUT 內容（只含 is_active）
   *   roleNames：將被停用的角色名稱（去重）
   *   shared   ：這些角色裡還有其他（未停用）簽核者的，停用會一併影響他們，需醒目警告
   */
  const planRoleDeactivation = (userCodes, roles, inactiveCodes) => {
    const picked = new Set(userCodes);
    const targets = roles.filter((r) => r.holderUsers.some((c) => picked.has(c)));

    const shared = [];
    const updates = targets.map((r) => {
      // 扣掉所有已停用帳號後還剩幾位「活著」的簽核者
      const others = r.holderUsers.filter((c) => !inactiveCodes.has(c)).length;
      if (others > 0) shared.push({ roleName: r.roleName, others });
      return {
        id: r.recordId,
        record: { [RF.IS_ACTIVE]: { value: [] } },
      };
    });

    return {
      updates,
      roleNames: [...new Set(targets.map((r) => r.roleName))],
      shared,
    };
  };

  /** D 區：批量停用角色記錄（取消勾選「啟用中」，簽核者名單完全不動） */
  const deactivateRoles = async (updates) => {
    for (const part of chunk(updates, CONFIG.WRITE_BATCH)) {
      await kintoneApi('/k/v1/records', 'PUT', { app: APP_ID.ROLE_DEFINITION, records: part });
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // 報告 UI（自訂全螢幕覆蓋層；確認與結果用 SweetAlert）
  // ═══════════════════════════════════════════════════════════════════

  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /** 匯出目前清單為 CSV（含 BOM 讓 Excel 正確顯示中文）；欄位標題隨分頁而異 */
  const exportCsv = (rows, filename, labels = {}) => {
    const {
      code: codeLabel = '帳號',
      name: nameLabel = '姓名',
      title: titleLabel = '職稱',
      group: groupLabel = '單位',
    } = labels;
    const lines = [`${codeLabel},${nameLabel},${titleLabel},${groupLabel}`,
      ...rows.map((u) => `"${u.code}","${u.name}","${u.jobTitle || ''}","${u.units.join('、')}"`)];
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  /**
   * 可輸入搜尋的角色選擇器（取代原生 select）
   *
   * 角色多達數十筆時，用原生下拉逐一往下找很花眼力；改為打字即時過濾，
   * 並支援 ↑↓ 移動、Enter 選取、Esc 取消。清單向「上」展開，
   * 因為選擇器位在報告視窗底部，往下開會被裁切。
   *
   * @param {Array<{unit: string, items: Array<{value: string, label: string}>}>} groups
   *        依單位分組的選項（與原 optgroup 結構相同）
   * @param {Function} onChange - 選取值變動時回呼（用來更新執行按鈕的啟用狀態）
   * @returns {{el: HTMLElement, getValue: Function, getLabel: Function}}
   */
  const buildRoleCombo = (groups, onChange) => {
    const options = groups.flatMap((g) => g.items.map((it) => ({ ...it, unit: g.unit })));

    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative; display:inline-block;';

    const input = document.createElement('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.placeholder = `輸入關鍵字搜尋角色…（共 ${options.length} 個）`;
    input.style.cssText =
      'font-size:14px; padding:8px 10px; min-width:300px; box-sizing:border-box; ' +
      'border:1px solid #ccc; border-radius:6px;';

    const panel = document.createElement('div');
    panel.style.cssText =
      'position:absolute; bottom:calc(100% + 4px); left:0; min-width:340px; max-height:300px; ' +
      'overflow-y:auto; background:#fff; border:1px solid #ccc; border-radius:6px; ' +
      'box-shadow:0 4px 16px rgba(0,0,0,.18); z-index:10; display:none;';

    let selected = null;   // { value, label }；未選為 null
    let matches = [];      // 目前清單中依序排列的可選項
    let active = -1;       // 鍵盤游標位置（對應 matches 索引）

    /** 關鍵字命中處加粗，讓眼睛一眼落在對的位置 */
    const highlight = (label, kw) => {
      const i = kw ? label.toLowerCase().indexOf(kw.toLowerCase()) : -1;
      if (i < 0) return esc(label);
      return esc(label.slice(0, i)) +
        `<strong style="color:#1a6ea8;">${esc(label.slice(i, i + kw.length))}</strong>` +
        esc(label.slice(i + kw.length));
    };

    /** 依 active 重繪選取樣式；keyboard 為 true 時把游標項捲進視野 */
    const paint = (keyboard = false) => {
      for (const el of panel.querySelectorAll('[data-idx]')) {
        const on = Number(el.dataset.idx) === active;
        el.style.background = on ? '#e0e7ff' : '';
        el.style.fontWeight = on ? '600' : '400';
        if (on && keyboard) el.scrollIntoView({ block: 'nearest' });
      }
    };

    /** 依關鍵字重繪清單（比對角色名稱與單位，並保留單位分組標題） */
    const renderPanel = (keyword) => {
      const kw = keyword.trim();
      const k = kw.toLowerCase();
      matches = k
        ? options.filter((o) => o.label.toLowerCase().includes(k) || o.unit.toLowerCase().includes(k))
        : options;
      active = matches.findIndex((o) => o.value === selected?.value);

      panel.innerHTML = '';
      if (!matches.length) {
        const empty = document.createElement('div');
        empty.textContent = '找不到符合的角色';
        empty.style.cssText = 'padding:12px; color:#999; font-size:14px;';
        panel.appendChild(empty);
        return;
      }

      let unit = null;
      matches.forEach((o, idx) => {
        if (o.unit !== unit) {
          unit = o.unit;
          const header = document.createElement('div');
          header.textContent = unit;
          header.style.cssText =
            'padding:6px 12px; font-size:12px; font-weight:700; color:#555; ' +
            'background:#f5f5f5; position:sticky; top:0; z-index:1;';
          panel.appendChild(header);
        }
        const item = document.createElement('div');
        item.dataset.idx = String(idx);
        item.innerHTML = highlight(o.label, kw);
        item.style.cssText = 'padding:8px 12px 8px 20px; font-size:14px; cursor:pointer;';
        // mousedown 先於 blur 觸發，preventDefault 確保選取完成後才失焦
        item.addEventListener('mousedown', (e) => { e.preventDefault(); choose(idx); });
        item.addEventListener('mouseenter', () => { active = idx; paint(); });
        panel.appendChild(item);
      });
      paint();
    };

    const open = (keyword) => { renderPanel(keyword); panel.style.display = 'block'; };
    const close = () => { panel.style.display = 'none'; };

    const choose = (idx) => {
      const o = matches[idx];
      if (!o) return;
      selected = { value: o.value, label: o.label };
      input.value = o.label;
      close();
      onChange();
    };

    input.addEventListener('focus', () => {
      input.select();       // 已有選取時直接打字即可重選
      open('');             // 聚焦先列全部，方便瀏覽
    });

    input.addEventListener('input', () => {
      // 文字被改動即視為尚未選定，避免按鈕誤亮
      if (selected && input.value !== selected.label) {
        selected = null;
        onChange();
      }
      open(input.value);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (panel.style.display === 'none') open(input.value);
        if (!matches.length) return;
        const step = e.key === 'ArrowDown' ? 1 : -1;
        active = (active + step + matches.length) % matches.length;
        paint(true);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (panel.style.display !== 'none' && active >= 0) choose(active);
      } else if (e.key === 'Escape') {
        close();
        input.value = selected?.label || '';
      }
    });

    input.addEventListener('blur', () => {
      // 延遲讓 mousedown 先完成選取，再還原成最後一次有效選取
      setTimeout(() => {
        close();
        input.value = selected?.label || '';
      }, 200);
    });

    wrap.append(input, panel);
    return {
      el: wrap,
      getValue: () => selected?.value || '',
      getLabel: () => selected?.label || '',
    };
  };

  /**
   * 渲染單一分頁（A～E 共用）：工具列（第三欄篩選 + 搜尋 + 全選）、
   * 人員表格、底部動作列（角色選擇〔選配〕 + 執行按鈕 + 匯出 CSV）
   * @param {string} groupLabel  - 第三欄標題（A/B/C 用「單位」、D 用「擔任角色」、
   *                               E 用「狀態／單位」），資料一律放在 users[].units
   * @param {Array|null} roleOptions - 底部角色選擇器的選項；null 表示此分頁不需要選角色
   * @param {Function|null} onAction - null 表示這是純檢視分頁（E 區），
   *                                   不顯示勾選欄與執行按鈕，只能篩選與匯出
   */
  const buildTab = ({
    key, users, groupLabel = '單位', roleOptions = null, actionLabel = '', onAction = null, onExport,
    // F 區列的是「角色」不是「人」，欄位標題可覆寫
    nameLabel = '姓名', codeLabel = '帳號', titleLabel = '職稱',
  }) => {
    const root = document.createElement('div');
    const selectable = Boolean(onAction);

    // ── 工具列 ──
    const unitSet = [...new Set(users.flatMap((u) => u.units))].sort();
    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'display:flex; gap:12px; align-items:center; margin-bottom:10px; flex-wrap:wrap;';
    toolbar.innerHTML = `
      <label style="font-size:14px;">${esc(groupLabel)}：
        <select data-role="unit" style="font-size:14px; padding:6px;">
          <option value="">全部（${users.length} 人）</option>
          ${unitSet.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
        </select>
      </label>
      <input data-role="search" type="text" placeholder="搜尋${esc(nameLabel)}、${esc(codeLabel)}或${esc(titleLabel)}…"
             style="font-size:14px; padding:6px 10px; border:1px solid #ccc; border-radius:4px; min-width:200px;">
      ${selectable
        ? '<label style="font-size:14px;"><input type="checkbox" data-role="check-all"> 全選（目前篩選結果）</label>'
        : ''}
      <span data-role="count" style="font-size:13px; color:#666;"></span>
    `;

    // ── 表格 ──
    const listWrap = document.createElement('div');
    listWrap.style.cssText = 'flex:1; overflow-y:auto; border:1px solid #e0e0e0; border-radius:6px;';
    const table = document.createElement('table');
    table.style.cssText = 'width:100%; border-collapse:collapse; font-size:14px;';
    table.innerHTML = `
      <thead>
        <tr style="background:#f5f5f5; position:sticky; top:0;">
          ${selectable ? '<th style="padding:8px; width:36px;"></th>' : ''}
          <th style="padding:8px; text-align:left;">${esc(nameLabel)}</th>
          <th style="padding:8px; text-align:left;">${esc(codeLabel)}</th>
          <th style="padding:8px; text-align:left;">${esc(titleLabel)}</th>
          <th style="padding:8px; text-align:left;">${esc(groupLabel)}</th>
        </tr>
      </thead>
      <tbody></tbody>`;
    listWrap.appendChild(table);
    const tbody = table.querySelector('tbody');

    const checked = new Set();   // 已勾選帳號（跨篩選保留）
    let visible = users;

    const renderRows = () => {
      const unit = toolbar.querySelector('[data-role="unit"]').value;
      const kw = toolbar.querySelector('[data-role="search"]').value.trim();
      visible = users.filter((u) =>
        (!unit || u.units.includes(unit)) &&
        (!kw || u.name.includes(kw) || u.code.includes(kw) || (u.jobTitle || '').includes(kw)));

      tbody.innerHTML = visible.map((u) => `
        <tr style="border-top:1px solid #eee;">
          ${selectable ? `<td style="padding:6px 8px; text-align:center;">
            <input type="checkbox" data-code="${esc(u.code)}" ${checked.has(u.code) ? 'checked' : ''}>
          </td>` : ''}
          <td style="padding:6px 8px;">${esc(u.name)}${u.note
            ? `<br><span style="display:inline-block; margin-top:3px; padding:1px 7px; border-radius:4px; background:#dcfce7; color:#166534; font-size:12px; font-weight:700;">${esc(u.note)}</span>`
            : ''}</td>
          <td style="padding:6px 8px; color:#666;">${esc(u.code)}</td>
          <td style="padding:6px 8px;">${u.jobTitle
            ? `<span style="display:inline-block; padding:1px 8px; border-radius:4px; background:#eef2ff; border:1px solid #c7d2fe; color:#3730a3; font-weight:600;">${esc(u.jobTitle)}</span>`
            : '<span style="color:#bbb;">—</span>'}</td>
          <td style="padding:6px 8px;">${esc(u.units.join('、'))}</td>
        </tr>`).join('') ||
        `<tr><td colspan="${selectable ? 5 : 4}" style="padding:16px; color:#999; text-align:center;">沒有符合的人員</td></tr>`;
      updateCount();
    };

    const updateCount = () => {
      toolbar.querySelector('[data-role="count"]').textContent = selectable
        ? `顯示 ${visible.length} 人／已勾選 ${checked.size} 人`
        : `顯示 ${visible.length} 人`;
      if (!actionBtn) return;
      // 有角色選擇器的分頁（A/B）要「勾了人 + 選了角色」才亮；C/D 勾了人就亮
      actionBtn.disabled = checked.size === 0 || (roleCombo && !roleCombo.getValue());
      actionBtn.style.opacity = actionBtn.disabled ? '0.5' : '1';
    };

    tbody.addEventListener('change', (e) => {
      const code = e.target.dataset?.code;
      if (!code) return;
      e.target.checked ? checked.add(code) : checked.delete(code);
      updateCount();
    });
    toolbar.querySelector('[data-role="unit"]').addEventListener('change', renderRows);
    toolbar.querySelector('[data-role="search"]').addEventListener('input', renderRows);
    toolbar.querySelector('[data-role="check-all"]')?.addEventListener('change', (e) => {
      visible.forEach((u) => e.target.checked ? checked.add(u.code) : checked.delete(u.code));
      renderRows();
    });

    // ── 底部動作列 ──
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex; gap:12px; align-items:center; margin-top:12px; flex-wrap:wrap;';

    const roleCombo = roleOptions ? buildRoleCombo(roleOptions, () => updateCount()) : null;

    const actionBtn = selectable ? document.createElement('button') : null;
    if (actionBtn) {
      actionBtn.textContent = actionLabel;
      actionBtn.style.cssText =
        'font-size:15px; padding:10px 24px; background:#3498db; color:#fff; border:none; border-radius:6px; cursor:pointer;';
      actionBtn.addEventListener('click', () =>
        onAction([...checked], roleCombo?.getValue() || '', roleCombo?.getLabel() || ''));
    }

    const exportBtn = document.createElement('button');
    exportBtn.textContent = '匯出 CSV';
    exportBtn.style.cssText =
      'font-size:14px; padding:10px 18px; background:#fff; color:#333; border:1px solid #ccc; border-radius:6px; cursor:pointer; margin-left:auto;';
    exportBtn.addEventListener('click', () => onExport(visible));

    if (roleCombo) footer.append(roleCombo.el);
    if (actionBtn) footer.append(actionBtn);
    footer.append(exportBtn);
    root.style.cssText = 'display:flex; flex-direction:column; height:100%;';
    root.append(toolbar, listWrap, footer);
    root.dataset.tab = key;
    renderRows();
    return root;
  };

  /** 由角色清單組出選擇器選項（依單位分組、同名去重；filter 可再限縮類型） */
  const buildRoleOptions = (roles, { userTypeOnly = false, valueBy = 'roleId' } = {}) => {
    const seen = new Set();
    const groups = new Map();
    for (const r of roles) {
      if (userTypeOnly && r.holderType !== HT.USER) continue;
      if (seen.has(r.roleName)) continue;
      seen.add(r.roleName);
      const unit = r.roleName.split('_')[0] || UNGROUPED_LABEL;
      if (!groups.has(unit)) groups.set(unit, []);
      groups.get(unit).push({
        value: valueBy === 'roleId' ? r.roleId : r.roleName,
        label: r.roleName,
      });
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b, 'zh-Hant'))
      .map(([unit, items]) => ({ unit, items }));
  };

  /** 顯示報告覆蓋層 */
  const showReport = (model, rescan) => {
    document.getElementById(CONFIG.OVERLAY_ID)?.remove();

    const overlay = document.createElement('div');
    overlay.id = CONFIG.OVERLAY_ID;
    overlay.style.cssText =
      // z-index 必須低於 SweetAlert2 的 1060，確認/結果視窗才能疊在報告上方
      'position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:1050; display:flex; align-items:center; justify-content:center;';

    const panel = document.createElement('div');
    panel.style.cssText =
      'background:#fff; border-radius:10px; width:min(960px, 94vw); height:min(720px, 92vh); ' +
      'display:flex; flex-direction:column; padding:20px 24px; box-shadow:0 8px 40px rgba(0,0,0,.25);';

    panel.innerHTML = `
      <div style="display:flex; align-items:center; margin-bottom:4px;">
        <h2 style="font-size:18px; margin:0;">簽核系統涵蓋率檢查</h2>
        <span style="font-size:13px; color:#666; margin-left:12px;">使用中帳號 ${model.totalActive} 人／已停用 ${model.totalInactive} 人</span>
        <button data-role="close" style="margin-left:auto; font-size:20px; border:none; background:none; cursor:pointer;">✕</button>
      </div>
      <div data-role="tabs" style="display:flex; gap:8px; margin:10px 0; flex-wrap:wrap;"></div>
      <div data-role="body" style="flex:1; overflow:hidden;"></div>
    `;

    const tabsEl = panel.querySelector('[data-role="tabs"]');
    const bodyEl = panel.querySelector('[data-role="body"]');
    panel.querySelector('[data-role="close"]').addEventListener('click', () => overlay.remove());

    // ── A 分頁：未設定起點 ──
    const tabA = buildTab({
      key: 'A',
      users: model.noEntry,
      roleOptions: buildRoleOptions(model.roles, { valueBy: 'roleId' }),
      actionLabel: '建立起點設定',
      onAction: async (codes, roleId, roleLabel) => {
        if (!codes.length || !roleId) return;
        const ok = (await Swal.fire({
          icon: 'question',
          title: `建立 ${codes.length} 筆起點設定？`,
          html: `起點角色：<strong>${esc(roleLabel)}</strong><br>對象：${codes.length} 人`,
          showCancelButton: true, confirmButtonText: '確定建立', cancelButtonText: '取消',
        })).isConfirmed;
        if (!ok) return;

        Swal.fire({ title: '建立中…', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        await createEntries(codes, roleId);
        await Swal.fire({ icon: 'success', title: `已建立 ${codes.length} 筆起點設定`, timer: 1800, showConfirmButton: false });
        rescan(); // 重新掃描刷新報告
      },
      onExport: (rows) => exportCsv(rows, `未設定起點_${new Date().toISOString().slice(0, 10)}.csv`),
    });

    // ── B 分頁：不具簽核身分 ──
    const tabB = buildTab({
      key: 'B',
      users: model.noHolder,
      roleOptions: buildRoleOptions(model.roles, { userTypeOnly: true, valueBy: 'roleName' }),
      actionLabel: '加入為簽核者',
      onAction: async (codes, roleName, roleLabel) => {
        if (!codes.length || !roleName) return;
        const ok = (await Swal.fire({
          icon: 'question',
          title: `將 ${codes.length} 人加入簽核者？`,
          html: `角色：<strong>${esc(roleLabel)}</strong>（附加到現有簽核者之後，不會移除任何人）`,
          showCancelButton: true, confirmButtonText: '確定加入', cancelButtonText: '取消',
        })).isConfirmed;
        if (!ok) return;

        Swal.fire({ title: '寫入中…', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        const touched = await assignHolders(codes, roleName, model.roles);
        await Swal.fire({
          icon: 'success',
          title: `已將 ${codes.length} 人加入「${roleName}」`,
          text: touched > 1 ? `（同名角色共 ${touched} 筆記錄已同步更新）` : undefined,
          timer: 2200, showConfirmButton: false,
        });
        rescan();
      },
      onExport: (rows) => exportCsv(rows, `不具簽核身分_${new Date().toISOString().slice(0, 10)}.csv`),
    });

    // ── C 分頁：已停用仍有起點 ──
    const tabC = buildTab({
      key: 'C',
      users: model.staleEntries,
      actionLabel: '停用起點設定',
      onAction: async (codes) => {
        const targets = model.staleEntries.filter((u) => codes.includes(u.code));
        const recordIds = targets.flatMap((u) => u.recordIds);
        if (!recordIds.length) return;
        const ok = (await Swal.fire({
          icon: 'question',
          title: `停用 ${recordIds.length} 筆起點設定？`,
          html: '這些員工的 kintone 帳號已停用。<br>只會取消勾選「啟用中」，記錄保留、不會刪除。',
          showCancelButton: true, confirmButtonText: '確定停用', cancelButtonText: '取消',
        })).isConfirmed;
        if (!ok) return;

        Swal.fire({ title: '停用中…', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        await deactivateEntries(recordIds);
        await Swal.fire({ icon: 'success', title: `已停用 ${recordIds.length} 筆起點設定`, timer: 1800, showConfirmButton: false });
        rescan();
      },
      onExport: (rows) => exportCsv(rows, `已停用仍有起點_${new Date().toISOString().slice(0, 10)}.csv`),
    });

    // ── D 分頁：已停用仍是簽核者 ──
    const tabD = buildTab({
      key: 'D',
      users: model.staleHolders,
      groupLabel: '擔任角色',
      actionLabel: '停用該角色',
      onAction: async (codes) => {
        const { updates, roleNames, shared } =
          planRoleDeactivation(codes, model.roles, model.inactiveCodes);
        if (!updates.length) return;

        // 角色底下還有活著的簽核者時，停用會連他們一起關掉，必須先講清楚
        const sharedHtml = shared.length
          ? `<div style="color:#c0392b; font-weight:bold; margin-top:10px; text-align:left;">
               注意：以下角色還有其他在職簽核者，停用後他們也會一起失效：<br>
               ${esc(shared.map((s) => `${s.roleName}（另有 ${s.others} 人）`).join('、'))}
             </div>`
          : '';

        const ok = (await Swal.fire({
          icon: 'warning',
          title: `停用 ${updates.length} 筆角色記錄？`,
          html:
            `<div style="text-align:left;">` +
            `對象角色：<strong>${esc(roleNames.join('、'))}</strong><br>` +
            `只會取消勾選「啟用中」，<strong>簽核者名單不會有任何變動</strong>。` +
            `</div>${sharedHtml}`,
          showCancelButton: true, confirmButtonText: '確定停用', cancelButtonText: '取消',
        })).isConfirmed;
        if (!ok) return;

        Swal.fire({ title: '停用中…', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        await deactivateRoles(updates);
        await Swal.fire({ icon: 'success', title: `已停用 ${updates.length} 筆角色記錄`, timer: 2000, showConfirmButton: false });
        rescan();
      },
      onExport: (rows) => exportCsv(rows, `已停用仍是簽核者_${new Date().toISOString().slice(0, 10)}.csv`, { group: '擔任角色' }),
    });

    // ── E 分頁：姓名格式異常（純檢視，不提供批量動作）──
    const tabE = buildTab({
      key: 'E',
      users: model.oddNames,
      groupLabel: '狀態／單位',
      onExport: (rows) => exportCsv(rows, `姓名格式異常_${new Date().toISOString().slice(0, 10)}.csv`, { group: '狀態／單位' }),
    });

    // ── F 分頁：角色沒有簽核者（啟用中 + 指定個人 + holder_user 空白）──
    const tabF = buildTab({
      key: 'F',
      users: model.emptyRoles,
      nameLabel: '角色名稱',
      codeLabel: '角色代碼',
      titleLabel: '鏈上游',
      groupLabel: '單位',
      actionLabel: '取消啟用中',
      onAction: async (codes) => {
        const targets = model.emptyRoles.filter((r) => codes.includes(r.code));
        if (!targets.length) return;

        // 有上游指向的角色停用後，那些鏈會直接斷掉（快取只載入啟用中的角色）
        const linked = targets.filter((r) => r.inbound > 0);
        const linkedHtml = linked.length
          ? `<div style="color:#c0392b; font-weight:bold; margin-top:10px; text-align:left;">
               注意：以下角色是別條簽核鏈的中繼站，停用後那些鏈會直接建立失敗（送單時就會被擋下來）：<br>
               ${esc(linked.map((r) => `${r.name}（${r.inbound} 條）`).join('、'))}<br>
               請一併把上游角色的「下一關」改指到別處。
             </div>`
          : '';

        const ok = (await Swal.fire({
          icon: 'question',
          title: `停用 ${targets.length} 筆角色？`,
          html:
            `<div style="text-align:left;">這些角色是「指定個人」但沒有指定任何簽核者，` +
            `流程跑到這關沒人能簽。<br>只會取消勾選「啟用中」，記錄保留、不會刪除。</div>${linkedHtml}`,
          showCancelButton: true, confirmButtonText: '確定停用', cancelButtonText: '取消',
        })).isConfirmed;
        if (!ok) return;

        Swal.fire({ title: '停用中…', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        await deactivateRoles(targets.map((r) => ({
          id: r.recordId,
          record: { [RF.IS_ACTIVE]: { value: [] } },
        })));
        await Swal.fire({ icon: 'success', title: `已停用 ${targets.length} 筆角色`, timer: 1800, showConfirmButton: false });
        rescan();
      },
      onExport: (rows) => exportCsv(
        rows,
        `角色沒有簽核者_${new Date().toISOString().slice(0, 10)}.csv`,
        { code: '角色代碼', name: '角色名稱', title: '鏈上游', group: '單位' },
      ),
    });

    const tabFNote = document.createElement('div');
    tabFNote.style.cssText =
      'background:#fff3cd; border:1px solid #f0c36d; border-radius:6px; padding:10px 14px; margin-bottom:10px; font-size:13px;';
    tabFNote.innerHTML =
      '<strong>這些角色是「指定個人」，卻沒有指定任何簽核者</strong>，流程跑到這一關沒有人能簽。<br>' +
      '「鏈上游」是有幾個角色的「下一關」指向它——有數字的請先改掉上游指向，' +
      '再停用；否則那些人送單會在建立簽核鏈時就被擋下（訊息：角色不存在或未啟用）。<br>' +
      '若這一關其實還需要，請改到 B 分頁把人指派進去，不要停用。';
    tabF.prepend(tabFNote);

    const tabENote = document.createElement('div');
    tabENote.style.cssText =
      'background:#eef5fb; border:1px solid #b8d6ec; border-radius:6px; padding:10px 14px; margin-bottom:10px; font-size:13px;';
    tabENote.innerHTML =
      '<strong>這些帳號的姓名沒有「中文 + 英文」都具備</strong>（只有中文、只有英文，或純數字／代號／符號），' +
      '多半是系統／測試／整合用帳號，或姓名尚未依規則補齊。<br>' +
      '已自 A～D 各區排除，避免每次掃描都要重複略過；若其中有真人，' +
      '請 IT 至 cybozu 後台把姓名補成「王小明 Jimmy Wang」的格式，下次掃描就會回到正常區。';
    tabE.prepend(tabENote);

    // 簽核群組內的停用帳號：工具無法改群組成員，插入提醒橫幅請 IT 至 cybozu 後台處理
    if (model.groupWarnings.length) {
      const warn = document.createElement('div');
      warn.style.cssText =
        'background:#fff3cd; border:1px solid #f0c36d; border-radius:6px; padding:10px 14px; margin-bottom:10px; font-size:13px;';
      warn.innerHTML =
        '<strong>以下簽核群組內有已停用的帳號</strong>（群組成員請 IT 至 cybozu 後台移除，本工具無法代勞）：<br>' +
        model.groupWarnings.map((w) => `・${esc(w)}`).join('<br>');
      tabD.prepend(warn);
    }

    // ── 分頁切換 ──
    const tabs = [
      { key: 'A', label: `A. 未設定起點（${model.noEntry.length} 人）`, el: tabA, hint: '這些人目前無法送單' },
      { key: 'B', label: `B. 不具簽核身分（${model.noHolder.length} 人）`, el: tabB, hint: '多數基層同仁本來就不簽核，此區用於確認主管沒被漏掉' },
      { key: 'C', label: `C. 已停用仍有起點（${model.staleEntries.length} 人）`, el: tabC, hint: '帳號已停用但起點記錄仍啟用中，建議停用避免誤導' },
      { key: 'D', label: `D. 已停用仍是簽核者（${model.staleHolders.length} 人）`, el: tabD, hint: '帳號已停用卻仍是簽核者，流程跑到該關會卡住；本區只會取消該角色的「啟用中」，不會動簽核者名單' },
      { key: 'E', label: `E. 姓名格式異常（${model.oddNames.length} 人）`, el: tabE, hint: '姓名未同時具備中文與英文，多為系統／測試／整合帳號或姓名未補齊；已自 A～D 排除，僅供人工確認' },
      { key: 'F', label: `F. 角色沒有簽核者（${model.emptyRoles.length} 筆）`, el: tabF, hint: '啟用中、指定個人、卻沒有指定任何簽核者的角色，流程跑到這關會卡死' },
    ];
    const switchTo = (key) => {
      bodyEl.innerHTML = '';
      const t = tabs.find((x) => x.key === key);
      bodyEl.appendChild(t.el);
      tabs.forEach((x) => {
        const btn = tabsEl.querySelector(`[data-key="${x.key}"]`);
        btn.style.background = x.key === key ? '#3498db' : '#eee';
        btn.style.color = x.key === key ? '#fff' : '#333';
      });
    };
    tabsEl.innerHTML = tabs.map((t) => `
      <button data-key="${t.key}" title="${esc(t.hint)}"
              style="font-size:14px; padding:8px 18px; border:none; border-radius:6px; cursor:pointer;">
        ${esc(t.label)}
      </button>`).join('');
    tabsEl.addEventListener('click', (e) => {
      if (e.target.dataset?.key) switchTo(e.target.dataset.key);
    });

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    switchTo('A');
  };

  // ═══════════════════════════════════════════════════════════════════
  // 進入點
  // ═══════════════════════════════════════════════════════════════════

  const runTool = async () => {
    Swal.fire({
      title: '掃描中…',
      html: '正在比對全公司使用者與兩張表的設定，約需數秒',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading(),
    });
    const model = await runScan();
    Swal.close();
    showReport(model, runTool);
  };

  kintone.events.on(['app.record.index.show'], safeHandler(async (event) => {
    if (document.getElementById(CONFIG.BTN_ID)) return event;

    const btn = document.createElement('button');
    btn.id = CONFIG.BTN_ID;
    btn.textContent = '未設定名單';
    btn.style.cssText =
      'font-size:14px; padding:8px 20px; margin-left:8px; background:#8e44ad; color:#fff; border:none; border-radius:4px; cursor:pointer;';
    btn.addEventListener('click', async () => {
      try {
        await runTool();
      } catch (err) {
        console.error('[ApprovalRouting] 涵蓋率檢查錯誤', err);
        Swal.close();
        await showWarning('掃描失敗', err.message);
      }
    });

    const headerSpace = kintone.app.getHeaderMenuSpaceElement?.() ||
                        document.querySelector('.gaia-argoui-app-index-toolbar');
    if (headerSpace) headerSpace.appendChild(btn);
    return event;
  }));
})();
