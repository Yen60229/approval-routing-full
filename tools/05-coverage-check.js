/**
 * 涵蓋率檢查工具 — 找出「使用中但尚未納入簽核系統」的使用者，並可就地補設定
 *
 * 在角色定義表（685）或員工起點對照表（686）的列表頁「體檢」選單提供「未設定名單」，
 * 掃描後以報告呈現七類問題，並提供快速處理：
 *   A. 未設定起點 — 使用中、但沒有可用起點的人（無法送單，最優先處理）：
 *      686 完全沒有記錄，**或**有記錄卻沒填 entry_role_id（後者一樣送不出單，
 *      getEntryRoleId() 取到的是空值）。「人數」欄可展開看名單、可拆成一人一列
 *      各自指定不同角色（同單位同職稱的人起點通常相同，但不是每次都相同）
 *        → 依「單位＋職稱」分組，一組一列各選起點角色，可**跨多個單位一次建立**
 *          （同單位同職稱的人起點必然相同，所以一組只要選一次；
 *            比對 685 的 unit_name / title_level 自動帶入；配不到的列可就地在 685
 *            新建該角色（一人一筆同名記錄，簽核者就是這組同仁），不必先跑 tools/04；
 *            兼任多單位／多職稱／資料不全者另立一區逐人手選，兩區互斥不會重複建）
 *   B. 不具簽核身分 — 使用中、但不在任何角色的 holder_user、也不在任何簽核群組的人
 *        → 勾選多人 + 選一個「指定個人」角色 → **每人各建一筆新的同名角色記錄**
 *          （holder_user 一筆只掛一個人，所以同一關有幾個簽核者就有幾筆同名記錄；
 *            新記錄的下一關等設定沿用記錄編號最小的那筆同名記錄；
 *            既有記錄一概不動；群組型角色的成員仍由 IT 在 cybozu 後台維護）
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
 *   G. 起點角色設定不完整 — 686 已經指定起點，685 那一關卻沒設好：
 *      角色根本不存在（或已取消啟用中），或角色在、但沒設下一關也沒勾終點
 *        → 沒設下一關者可就地補：一列一個關卡，選好下一關後批量寫回 685
 *          （同名角色是同一關，補的時候同名記錄會一起補，不會只補到其中一筆）
 *          角色不存在者一律紅底、勾不動——新建角色要決定簽核者／單位／職稱，
 *          是人的判斷，工具只把清單列出來，請 HR 到 685 補建或改指到別的角色
 *
 * 【影響的欄位】
 *   - 686 employee / entry_role_id / is_active：A 區批量寫入（每人一筆，起點角色可
 *     逐列不同；已有記錄只是沒填角色的人是**更新原記錄**，不會再建一筆）；
 *     C 區取消啟用中
 *   - 685 記錄本身：B 區新增（每人一筆，holder_user 只掛該人）；既有記錄不修改
 *   - 685 is_active：D 區與 F 區取消勾選（停用整筆角色記錄）
 *   - 685 next_role_id / is_chain_end：A 區與 G 區補設下一關（成對寫入，
 *     同名記錄一起補；A 區與起點建立是同一次動作，不會只設好一邊）
 *   - 685 新增記錄：A 區就地新建配不到的關卡（unit_name / title_level / holder_user /
 *     holder_type / signing_mode / next_role_id / is_active；role_name 是計算欄位不寫）
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
 *   2026-08-19  Jimmy/Claude  B 區改為每人新建一筆角色記錄，不再把人附加進既有記錄。
 *                             舊做法會把勾選的人全部寫進「所有」同名記錄，造成同一人
 *                             被重複掛在同一關的多筆記錄上（tools/06 掃出的滿江紅主因）
 *   2026-08-19  Jimmy/Claude  A 區改為依「單位＋職稱」分組，可跨多個單位一次建立起點。
 *                             原本一次只能選一個起點角色，單位一多就要重複做很多輪。
 *                             自動配對只比 unit_name / title_level 欄位，不拆 role_name
 *   2026-08-19  Jimmy/Claude  審查發現 A/B/C/D/F 五處批量寫入都沒有錯誤處理——寫入失敗
 *                             時轉圈視窗永遠不關、不跳錯誤、也不會 rescan()，而寫入是
 *                             分批送出的，中途失敗代表前面批次已經寫進 kintone、使用者
 *                             卻毫無所知。抽出共用 helper runWriteAction() 統一走
 *                             try/catch/finally：失敗一律關轉圈、跳錯誤並明講「部分可能
 *                             已經寫入，請重新掃描確認」，rescan() 在成功／失敗都會跑；
 *                             既有成功訊息文案、icon、timer 秒數不變
 *   2026-08-19  Jimmy/Claude  最終審查修正：A 分頁確認視窗補上「幾組／幾人」與逐列
 *                             單位－職稱→角色明細，並提示「已指定但未勾選」的列數，
 *                             避免捲軸外的勾選被靜默漏送；runWriteAction 的 rescan()
 *                             補上 await + try/catch，避免重新掃描失敗時轉圈永遠不關；
 *                             下一關不一致的警告改跟著下拉目前值即時判斷（抽出
 *                             isNextRoleConsistent 共用），不再只在自動配對當下判斷一次
 *                             就定死；err.message 一律改用 err?.message || String(err)；
 *                             buildRoleCombo.setValue 找不到對應選項時 console.warn；
 *                             例外區分隔列補充說明紅底代表「尚未指定」而非配對失敗；
 *                             更新過期的 JSDoc（openUp 方向、buildTab 適用分頁）
 *   2026-08-20  Jimmy/Claude  起點與下一關改為同步設定：A 區選好起點角色後，若該關在
 *                             685 還沒設下一關，同一列就要一併指定，兩邊在同一次動作
 *                             寫完（先 685 再 686，中途失敗也不會有人拿到指向斷鏈的
 *                             起點）；新增 G 區收拾既有資料——686 已設起點但 685 缺
 *                             角色或缺下一關的，一列一個關卡批量補齊
 *   2026-08-20  Jimmy/Claude  修正 A 區漏人：原本只看「686 有沒有這個人的記錄」，
 *                             記錄在、entry_role_id 卻空白的人被當成已設定，A 區看不到，
 *                             G 區又因為沒有 role_id 而跳過，兩邊都漏掉。改為以「有沒有
 *                             填角色」判斷，並把寫入改成 upsert：有空白記錄就補填原記錄，
 *                             沒有記錄才新建（686 是一人一筆起點，多建一筆會讓
 *                             getEntryRoleId() 取到哪一筆變成看運氣）
 *   2026-08-20  Jimmy/Claude  A 區「人數」欄可展開看名單、可拆成一人一列各自指定角色
 *                             （原組列只隱藏不刪除，合併回整組可復原）
 *   2026-08-20  Jimmy/Claude  A 區可就地新建 685 角色：配不到現有角色的列，角色清單最前面
 *                             多一個「＋ 在 685 建立這個角色」，選了就地填 unit_name /
 *                             title_level（依組織與職務自動帶入、可手改），送出時先建角色
 *                             再寫起點。一關有幾個人就建幾筆同名記錄各掛一人（§9.5），
 *                             起點指到最先建立的那一筆（與 matchEntryRole 同規則）。
 *                             選到的單位＋職稱若已經有角色會擋下來，請他直接從清單選。
 *                             role_name 目前是計算欄位、不寫入；萬一哪天改回文字欄位，
 *                             分隔符號從既有記錄反推，不像 tools/04 那樣寫死在程式裡
 */
(() => {
  'use strict';

  const { APP_ID, ROLE_FIELDS: RF, ENTRY_FIELDS: EF, CHECKBOX, HOLDER_TYPE_OPTIONS: HT,
          SIGNING_MODE_OPTIONS: SM, ROLE_ID_PREFIX } = window.ApprovalRouting.Config;
  const { safeHandler, kintoneApi, showWarning } = window.ApprovalRouting.Utils;
  // 後台人事資料與單位／職稱對應共用 core/08-directory.js（tools/11 用的是同一份規則）
  const {
    fetchUserApiAll, fetchAllUsers, fetchDirectory, fetchRoleFormFields,
    guessTitleLevel, guessUnitName,
  } = window.ApprovalRouting.Directory;

  const CONFIG = Object.freeze({
    BTN_ID:      'ar-coverage-check-btn',
    OVERLAY_ID:  'ar-coverage-overlay',
    RECORD_PAGE: 500,   // records API 單次上限
    ORG_PARALLEL: 10,   // 簽核群組成員查詢的並行數（控制瞬間 API 量）
    WRITE_BATCH: 100,   // records 批量寫入上限
    MAX_WALK:     50,   // 迴圈偵測的最大步數，與 chain-builder 的深度上限同量級
  });

  const UNGROUPED_LABEL = '（未分類）';

  // 「下一關」選擇器裡代表「這一關就是終點」的特殊值。
  // 用 role_id 不可能長成的樣子，才不會跟真的角色代碼撞在一起。
  const CHAIN_END_VALUE = '__CHAIN_END__';

  // 起點角色選擇器裡代表「這一關在 685 還沒建，順便建起來」的特殊值。
  const CREATE_ROLE_VALUE = '__CREATE_ROLE__';

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
  // 起點鏈完整性（純函式；A 區的同步設定與 G 區的補齊共用同一套判斷）
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 這一筆角色記錄的「下一關」是否已經設定。
   *
   * next_role_id 有值、或勾了「是終點」，兩者任一都算設定完成——終點是刻意的
   * 鏈結尾，不是漏設。兩者皆無才是真正的斷點：鏈走到這一關就無處可去。
   */
  const hasNextStep = (role) =>
    Boolean(role.nextRoleId) || (role.isChainEnd || []).includes(CHECKBOX.CHAIN_END);

  /**
   * 依 role_id 查出「這一關」的下一關設定狀態。
   *
   * 同名角色在本系統視為同一關（tools/07 也是這樣看），所以判斷與補設都以同名
   * 記錄為單位：只要有任何一筆沒設下一關，這一關就算沒設完；補的時候也要把同名
   * 的每一筆一起補上，否則起點指到哪一筆會走出不同的鏈。
   *
   * @returns {{roleName, unitName, nextRoleId, recordIds, missingIds, hasNext, consistent}|null}
   *          找不到對應角色（不存在或已取消啟用中）時回 null
   */
  const inspectNextStep = (roleId, roles) => {
    const picked = roles.find((r) => r.roleId === roleId);
    if (!picked) return null;
    const sameName = roles.filter((r) => r.roleName === picked.roleName);
    const missing = sameName.filter((r) => !hasNextStep(r));
    return {
      roleName:   picked.roleName,
      unitName:   picked.unitName,
      nextRoleId: picked.nextRoleId,
      recordIds:  sameName.map((r) => r.recordId),
      missingIds: missing.map((r) => r.recordId),
      hasNext:    missing.length === 0,
      consistent: new Set(sameName.map((r) => r.nextRoleId)).size <= 1,
    };
  };

  /**
   * 依 role_id 查出該角色的「同名記錄下一關是否一致」。
   *
   * 供自動配對（matchEntryRole）與 A 分頁下拉即時變動（refresh）共用同一份判斷，
   * 避免兩處各抄一份、日後改一邊漏改另一邊。
   *
   * @returns {boolean|null} 找不到對應角色時回 null（呼叫端視為「不顯示警告」）
   */
  const isNextRoleConsistent = (roleId, roles) => inspectNextStep(roleId, roles)?.consistent ?? null;

  /**
   * 從 targetRoleId 沿現有的 next_role_id 往下走，看會不會走回 sourceRoleName 這一關。
   *
   * 這是「把來源的下一關改成 target 之後」的視角：只要 target 的下游碰得到來源，
   * 這條鏈就繞回自己，送單時會在建鏈階段打轉。與 tools/07 的迴圈偵測同一套判斷，
   * 同名角色視為同一關，所以比對用角色名稱而不是 role_id。
   *
   * @param {string} targetRoleId - 打算設成下一關的角色
   * @param {string} sourceRoleName - 來源關卡的角色名稱
   * @param {Map<string, object>} roleById - role_id → 角色（由呼叫端建一次重複使用）
   * @returns {{cycle: boolean, path: string[]}} path 是走過的角色名稱，供訊息指出問題在哪
   */
  const walkBackTo = (targetRoleId, sourceRoleName, roleById) => {
    const path = [];
    let cur = targetRoleId;
    for (let i = 0; i < CONFIG.MAX_WALK && cur; i++) {
      const role = roleById.get(cur);
      if (!role) break;              // 指到不存在／已停用的角色，那是 G 區要處理的問題
      path.push(role.roleName);
      if (role.roleName === sourceRoleName) return { cycle: true, path };
      cur = role.nextRoleId;
    }
    return { cycle: false, path };
  };

  /**
   * 把逐列選好的「下一關」整併成 685 的更新內容。
   *
   * 同一筆角色記錄被兩列指到不同的下一關時，代表選擇互相矛盾——靜默取其中一個，
   * 另一列的人就會走出非預期的鏈，所以回報 conflicts 讓呼叫端整批擋下來。
   * conflicts 非空時 updates 不具意義，呼叫端必須先檢查 conflicts 再決定是否送出。
   *
   * @param {Array<{roleName: string, recordIds: string[], value: string, label: string}>} assignments
   * @returns {{updates: Array, conflicts: Array<{roleName: string, labels: string[]}>}}
   */
  const planNextStepUpdates = (assignments) => {
    const byRecord = new Map();      // 685 recordId → { value, label }
    const conflicts = new Map();     // roleName → Set(下一關名稱)

    for (const a of assignments) {
      for (const id of a.recordIds) {
        const prev = byRecord.get(id);
        if (prev && prev.value !== a.value) {
          if (!conflicts.has(a.roleName)) conflicts.set(a.roleName, new Set([prev.label]));
          conflicts.get(a.roleName).add(a.label);
          continue;
        }
        byRecord.set(id, { value: a.value, label: a.label });
      }
    }

    const updates = [...byRecord.entries()].map(([id, { value }]) => ({
      id,
      // 下一關與「是終點」互斥，一律成對寫入，不留下互相矛盾的狀態
      record: value === CHAIN_END_VALUE
        ? { [RF.NEXT_ROLE_ID]: { value: '' }, [RF.IS_CHAIN_END]: { value: [CHECKBOX.CHAIN_END] } }
        : { [RF.NEXT_ROLE_ID]: { value }, [RF.IS_CHAIN_END]: { value: [] } },
    }));

    return {
      updates,
      conflicts: [...conflicts.entries()]
        .map(([roleName, labels]) => ({ roleName, labels: [...labels] })),
    };
  };

  /**
   * G 區：找出「686 已經指定起點，685 那一關卻還沒設定完整」的角色。
   *
   * 兩種不完整：
   *   missing —— entry_role_id 指到的角色在 685 找不到（沒建、或已取消啟用中），
   *              這些人一送單就會被擋在「角色不存在或未啟用」
   *   no-next —— 角色在，但同名記錄裡有人沒設下一關、也沒勾終點，鏈走到這關就斷
   *
   * 以 role_name 聚合成一列：同名角色是同一關，補一次就解決所有指到它的人。
   * 角色在 685 找不到時聚合不到名稱，改以 role_id 自成一列。
   *
   * 只計入帳號還在使用中的人——起點記錄還在但人已停用是 C 區的範圍，
   * 兩區各自處理，同一件事才不會在兩個地方各講一次。
   *
   * @param {object} opts
   * @param {Array<{recordId: string, code: string, roleId: string}>} opts.entries 686 啟用中的起點記錄
   * @param {Set<string>} opts.activeCodes 使用中的帳號
   * @param {Map<string, string>} opts.nameByCode 帳號 → 姓名
   * @param {Array} opts.roles 685 啟用中的角色
   * @returns {Array} 影響人數多的排前面
   */
  const buildBrokenEntries = ({ entries, activeCodes, nameByCode, roles }) => {
    const roleById = new Map(roles.map((r) => [r.roleId, r]));
    const rows = new Map();          // 聚合鍵 → 列

    for (const e of entries) {
      // 沒填 entry_role_id 的記錄由 A 區處理（那是「還沒設起點」，不是「起點壞掉」）
      if (!e.roleId || !activeCodes.has(e.code)) continue;

      const role = roleById.get(e.roleId);
      const status = role ? inspectNextStep(e.roleId, roles) : null;
      if (status?.hasNext) continue;                      // 這一關是好的，不用列

      // 角色不存在就沒有名稱可聚合，用 role_id 自成一列（前綴避免與角色名稱撞鍵）
      const key = role ? role.roleName : `?${e.roleId}`;
      if (!rows.has(key)) {
        rows.set(key, {
          key,
          problem:    role ? 'no-next' : 'missing',
          roleId:     e.roleId,
          roleName:   role ? role.roleName : '',
          unitName:   role?.unitName || UNGROUPED_LABEL,
          missingIds: status ? status.missingIds : [],
          people:     [],
        });
      }
      rows.get(key).people.push({ code: e.code, name: nameByCode.get(e.code) || e.code });
    }

    return [...rows.values()]
      .map((r) => ({
        ...r,
        peopleCount: r.people.length,
        // exportCsv 用的四個欄位：這一分頁列的是「關卡」，不是人
        code:     r.roleId,
        name:     r.roleName || `（685 找不到：${r.roleId}）`,
        jobTitle: r.problem === 'missing' ? '685 沒有這個角色' : '沒有設下一關',
        units:    [r.unitName],
      }))
      .sort((a, b) => b.peopleCount - a.peopleCount ||
                      a.name.localeCompare(b.name, 'zh-Hant'));
  };

  // ═══════════════════════════════════════════════════════════════════
  // 新建 685 角色（純函式；A 區就地建立時共用）
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 從既有角色反推 role_name 的分隔符號
   *
   * role_name 目前是計算欄位（單位 - 職稱），計算欄位不接受寫入，新建記錄不必也不能
   * 帶這個欄位。但它在專案歷史上曾經是單行文字（公式用過 `_`、畫面上現在是 ` - `），
   * 萬一哪天又被改回文字欄位，分隔符號要能跟著資料走——寫死哪一種都會在下次調整時
   * 悄悄產出格式不對的 role_name（tools/04 目前就還停在 `_`）。
   *
   * @returns {string|null} 反推不出來時回 null，呼叫端就不要寫 role_name
   */
  const deriveRoleNameSeparator = (roles) => {
    const tally = new Map();
    for (const { roleName, unitName, titleLevel } of roles) {
      if (!roleName || !unitName || !titleLevel) continue;
      if (roleName.length < unitName.length + titleLevel.length) continue;
      if (!roleName.startsWith(unitName) || !roleName.endsWith(titleLevel)) continue;
      const sep = roleName.slice(unitName.length, roleName.length - titleLevel.length);
      tally.set(sep, (tally.get(sep) || 0) + 1);
    }
    const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : null;
  };

  /**
   * 組出要新建的 685 角色記錄
   *
   * 同一關有幾個人就建幾筆同名記錄，各掛一人（見 docs/對話脈絡.md §9.5：
   * holder_user 一筆只掛一個人）。role_id 由呼叫端給的流水號起點往下編。
   *
   * 起點（686）一律指到這一關「最先建立」的那一筆，與 matchEntryRole 取記錄編號
   * 最小者是同一個規則——既有角色與新建角色的行為才會一致。
   *
   * @param {Array<{rowId, unitName, titleLevel, memberCodes: string[], nextValue: string}>} specs
   * @param {number} startSeq - role_id 流水號起點
   * @param {{roleNameSeparator?: string|null}} [opts]
   *        roleNameSeparator 給了才寫 role_name；計算欄位一律不要給
   * @returns {{records: Array, roleIdByRow: Map<string, string>}}
   */
  const buildNewRoleRecords = (specs, startSeq, { roleNameSeparator = null } = {}) => {
    let seq = startSeq;
    const records = [];
    const roleIdByRow = new Map();

    for (const spec of specs) {
      const firstRoleId = `${ROLE_ID_PREFIX}${String(seq).padStart(4, '0')}`;

      for (const code of spec.memberCodes) {
        const roleId = `${ROLE_ID_PREFIX}${String(seq++).padStart(4, '0')}`;
        const record = {
          [RF.ROLE_ID]:      { value: roleId },
          [RF.UNIT_NAME]:    { value: spec.unitName },
          [RF.TITLE_LEVEL]:  { value: spec.titleLevel },
          [RF.HOLDER_TYPE]:  { value: HT.USER },
          [RF.HOLDER_USER]:  { value: [{ code }] },
          [RF.HOLDER_GROUP]: { value: [] },
          // 單選必填；沿用 B 區新建記錄的預設，休假時仍可用 kintone 的「執行者」代簽
          [RF.SIGNING_MODE]: { value: SM.ANY },
          [RF.IS_ACTIVE]:    { value: [CHECKBOX.ACTIVE] },
          ...(spec.nextValue === CHAIN_END_VALUE
            ? { [RF.NEXT_ROLE_ID]: { value: '' }, [RF.IS_CHAIN_END]: { value: [CHECKBOX.CHAIN_END] } }
            : { [RF.NEXT_ROLE_ID]: { value: spec.nextValue }, [RF.IS_CHAIN_END]: { value: [] } }),
        };
        if (roleNameSeparator !== null) {
          record[RF.ROLE_NAME] = { value: `${spec.unitName}${roleNameSeparator}${spec.titleLevel}` };
        }
        records.push(record);
      }

      roleIdByRow.set(spec.rowId, firstRoleId);
    }

    return { records, roleIdByRow };
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

  /** kintone records 通用分頁撈全量（offset 適用：兩表資料量在數百～千級） */
  const fetchRecordsAll = async (app, fields, condition) => {
    const all = [];
    let offset = 0;
    while (true) {
      const resp = await kintoneApi('/k/v1/records.json', 'GET', {
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
       RF.UNIT_NAME, RF.NEXT_ROLE_ID, RF.TITLE_LEVEL, RF.IS_CHAIN_END, RF.SIGNING_MODE],
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
        // B 區建新記錄時當範本沿用
        titleLevel: rec[RF.TITLE_LEVEL]?.value || '',
        isChainEnd: rec[RF.IS_CHAIN_END]?.value || [],
        signingMode: rec[RF.SIGNING_MODE]?.value || '',
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

  /** 686 啟用中的起點記錄
   *
   * 「有記錄」與「有起點」是兩件事：記錄在、entry_role_id 卻空白的人一樣送不出單
   * （getEntryRoleId() 取到空值），所以 A 區要看的是 assignedCodes 而不是 codes。
   *
   * @returns {Promise<{codes: Set, assignedCodes: Set, recordIdsByCode: Map,
   *                    blankRecordIdsByCode: Map, entries: Array}>}
   *   codes               ：有起點記錄的帳號（C 區停用清理用）
   *   assignedCodes       ：記錄裡真的填了角色的帳號（A 區判斷誰還沒設）
   *   recordIdsByCode     ：帳號 → 686 記錄編號（C 區停用清理用）
   *   blankRecordIdsByCode：帳號 → 沒填角色的記錄編號（A 區補填原記錄用）
   *   entries             ：一人一列的起點明細，含 entry_role_id（G 區檢查鏈是否完整用）
   */
  const fetchEntryRecords = async () => {
    const records = await fetchRecordsAll(
      APP_ID.EMPLOYEE_ENTRY,
      ['$id', EF.EMPLOYEE, EF.ENTRY_ROLE_ID],
      `${EF.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}")`,
    );
    const codes = new Set();
    const assignedCodes = new Set();
    const recordIdsByCode = new Map();
    const blankRecordIdsByCode = new Map();
    const entries = [];

    const push = (map, key, value) => {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(value);
    };

    for (const rec of records) {
      const roleId = rec[EF.ENTRY_ROLE_ID]?.value || '';
      for (const u of rec[EF.EMPLOYEE]?.value || []) {
        codes.add(u.code);
        push(recordIdsByCode, u.code, rec.$id.value);
        if (roleId) assignedCodes.add(u.code);
        else push(blankRecordIdsByCode, u.code, rec.$id.value);
        entries.push({ recordId: rec.$id.value, code: u.code, roleId });
      }
    }
    return { codes, assignedCodes, recordIdsByCode, blankRecordIdsByCode, entries };
  };

  /** 主掃描：組出報告資料模型 */
  const runScan = async () => {
    const [{ actives, inactives }, { orgMap, titleMap }, roleCoverage, entryData, roleForm] =
      await Promise.all([
        fetchAllUsers(),
        fetchDirectory(),
        fetchRoleCoverage(),
        fetchEntryRecords(),
        fetchRoleFormFields(),
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

    // G：686 已經指定起點，685 那一關卻沒設好（角色不存在、或沒設下一關）。
    //    這一區看的是「關卡」不是人，所以不套用 E 區的姓名格式過濾——
    //    鏈斷掉對系統帳號與真人一視同仁，該補的下一關還是要補。
    const nameByCode = new Map(actives.map((u) => [u.code, u.name]));
    const brokenEntries = buildBrokenEntries({
      entries:     entryData.entries,
      activeCodes: new Set(actives.map((u) => u.code)),
      nameByCode,
      roles:       roleCoverage.roles,
    });

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
      // 「沒有記錄」與「有記錄但沒填角色」都算沒有起點，兩者都送不出單；
      // entryRecordIds 非空代表補填原記錄就好，不必再建一筆
      noEntry: normalActives
        .filter((u) => !entryData.assignedCodes.has(u.code))
        .map((u) => ({
          ...decorate(u),
          entryRecordIds: entryData.blankRecordIdsByCode.get(u.code) || [],
        })),
      noHolder: normalActives.filter((u) => !roleCoverage.holderCodes.has(u.code)).map(decorate),
      staleEntries,
      staleHolders,
      oddNames,
      emptyRoles,
      brokenEntries,
      // D 區判斷「這個角色是否還有活著的簽核者」用
      inactiveCodes: new Set(inactives.map((u) => u.code)),
      groupWarnings,
      roles: roleCoverage.roles,
      // A 區就地新建角色用：下拉選項、role_name 該不該自己組
      roleForm: {
        ...roleForm,
        // 計算欄位不寫；還是文字欄位時才自己組值，分隔符號跟著既有資料走
        roleNameSeparator: roleForm.roleNameIsCalc
          ? null
          : deriveRoleNameSeparator(roleCoverage.roles),
      },
    };
  };

  // ═══════════════════════════════════════════════════════════════════
  // 寫入動作
  // ═══════════════════════════════════════════════════════════════════

  /**
   * A 區：把 {code, roleId, recordIds} 清單拆成「補填既有記錄」與「新建記錄」兩堆
   *
   * recordIds 非空代表這人已經有起點記錄、只是沒填角色 —— 補填原記錄，**不再建一筆**：
   * 686 是一人一筆起點，多建一筆之後查起點取到哪一筆就變成看運氣。
   * 同一人若有多筆空白記錄，全部填成同一個角色 —— 留著空白的那幾筆，
   * getEntryRoleId() 仍可能取到空值，比重複更糟。
   *
   * 同一個帳號在清單裡出現多次時只認第一筆（分區已經互斥，這是最後一道保險）。
   *
   * @param {Array<{code: string, roleId: string, recordIds?: string[]}>} pairs
   * @returns {{creates: Array, updates: Array}} 可直接送進 POST / PUT 的內容
   */
  const planEntryWrites = (pairs) => {
    const byCode = new Map();
    for (const p of pairs) if (!byCode.has(p.code)) byCode.set(p.code, p);

    const creates = [];
    const updates = [];
    for (const { code, roleId, recordIds } of byCode.values()) {
      if (recordIds?.length) {
        for (const id of recordIds) {
          updates.push({ id, record: { [EF.ENTRY_ROLE_ID]: { value: roleId } } });
        }
        continue;
      }
      creates.push({
        [EF.EMPLOYEE]:      { value: [{ code }] },
        [EF.ENTRY_ROLE_ID]: { value: roleId },
        [EF.IS_ACTIVE]:     { value: [CHECKBOX.ACTIVE] },
      });
    }
    return { creates, updates };
  };

  /**
   * A 區：依 planEntryWrites 的分流把起點設定寫進 686
   *
   * 先補填、後新建：兩者互不影響，但先做更新可以讓「已經有記錄的人」最快恢復可送單。
   *
   * @returns {Promise<{created: number, updated: number}>}
   */
  const upsertEntries = async (pairs) => {
    const { creates, updates } = planEntryWrites(pairs);

    for (const part of chunk(updates, CONFIG.WRITE_BATCH)) {
      await kintoneApi('/k/v1/records.json', 'PUT', { app: APP_ID.EMPLOYEE_ENTRY, records: part });
    }
    for (const part of chunk(creates, CONFIG.WRITE_BATCH)) {
      await kintoneApi('/k/v1/records.json', 'POST', { app: APP_ID.EMPLOYEE_ENTRY, records: part });
    }
    return { created: creates.length, updated: updates.length };
  };

  /**
   * 取同名角色當新記錄的範本
   *
   * 一筆角色記錄只掛一個人，所以同一關有幾個簽核者就有幾筆同名記錄。
   * 新記錄的下一關等設定沿用「記錄編號最小」的那筆。
   *
   * @returns {{tpl: object|null, count: number, nextConsistent: boolean, hasNext: boolean}}
   *   nextConsistent：同名記錄的 next_role_id 是否一致（不一致代表資料已經有問題）
   *   hasNext       ：範本本身有沒有設下一關。沒有的話新記錄會沿用同樣的空白設定，
   *                   之後有人以它為起點就會斷鏈，確認視窗要先講一聲
   */
  const pickRoleTemplate = (roleName, roles) => {
    const siblings = roles
      .filter((r) => r.roleName === roleName && r.holderType === HT.USER)
      .sort((a, b) => Number(a.recordId) - Number(b.recordId));
    return {
      tpl: siblings[0] || null,
      count: siblings.length,
      nextConsistent: new Set(siblings.map((r) => r.nextRoleId)).size <= 1,
      hasNext: Boolean(siblings[0]) && hasNextStep(siblings[0]),
    };
  };

  /** 產生 role_id 流水號的起點：現有最大的 ROLE_NNNN 再加 1 */
  const nextRoleSeq = async () => {
    const resp = await kintoneApi('/k/v1/records.json', 'GET', {
      app: APP_ID.ROLE_DEFINITION,
      fields: [RF.ROLE_ID],
      query: `order by ${RF.ROLE_ID} desc limit ${CONFIG.RECORD_PAGE}`,
    });
    let max = 0;
    for (const rec of resp.records) {
      const val = rec[RF.ROLE_ID]?.value || '';
      if (!val.startsWith(ROLE_ID_PREFIX)) continue;
      const num = Number(val.slice(ROLE_ID_PREFIX.length));
      if (Number.isInteger(num) && num > max) max = num;
    }
    return max + 1;
  };

  /**
   * B 區：一人建一筆新的角色記錄
   *
   * holder_user 一筆只能掛一個人，所以「加入為簽核者」是**新增記錄**，
   * 不是把人塞進既有記錄。既有的同名記錄一概不動。
   */
  const createHolderRoles = async (userCodes, roleName, roles) => {
    const { tpl } = pickRoleTemplate(roleName, roles);
    if (!tpl) throw new Error(`找不到「${roleName}」的既有記錄，無法沿用設定。`);

    let seq = await nextRoleSeq();
    const records = userCodes.map((code) => ({
      [RF.ROLE_ID]:      { value: `${ROLE_ID_PREFIX}${String(seq++).padStart(4, '0')}` },
      [RF.ROLE_NAME]:    { value: roleName },
      [RF.UNIT_NAME]:    { value: tpl.unitName },
      [RF.TITLE_LEVEL]:  { value: tpl.titleLevel },
      [RF.HOLDER_TYPE]:  { value: HT.USER },
      [RF.HOLDER_USER]:  { value: [{ code }] },
      [RF.HOLDER_GROUP]: { value: [] },
      [RF.NEXT_ROLE_ID]: { value: tpl.nextRoleId },
      [RF.IS_CHAIN_END]: { value: tpl.isChainEnd },
      // 單選必填，範本沒填就給預設值，避免整批寫入失敗
      [RF.SIGNING_MODE]: { value: tpl.signingMode || SM.ANY },
      [RF.IS_ACTIVE]:    { value: [CHECKBOX.ACTIVE] },
    }));

    for (const part of chunk(records, CONFIG.WRITE_BATCH)) {
      await kintoneApi('/k/v1/records.json', 'POST', {
        app: APP_ID.ROLE_DEFINITION,
        records: part,
      });
    }
    return records.length;
  };

  /** C 區：批量停用 686 起點記錄（取消勾選「啟用中」，記錄保留不刪除） */
  const deactivateEntries = async (recordIds) => {
    const updates = recordIds.map((id) => ({
      id,
      record: { [EF.IS_ACTIVE]: { value: [] } },
    }));
    for (const part of chunk(updates, CONFIG.WRITE_BATCH)) {
      await kintoneApi('/k/v1/records.json', 'PUT', { app: APP_ID.EMPLOYEE_ENTRY, records: part });
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

  /** 分批送出 685 的記錄更新（PUT 單次上限 100 筆） */
  const updateRoleRecords = async (updates) => {
    for (const part of chunk(updates, CONFIG.WRITE_BATCH)) {
      await kintoneApi('/k/v1/records.json', 'PUT', { app: APP_ID.ROLE_DEFINITION, records: part });
    }
    return updates.length;
  };

  /** D 區與 F 區：批量停用角色記錄（取消勾選「啟用中」，簽核者名單完全不動） */
  const deactivateRoles = (updates) => updateRoleRecords(updates);

  /**
   * A 區：一次寫完「685 的下一關」與「686 的起點」
   *
   * 順序刻意是先 685 再 686：起點記錄一建好，那個人馬上就能送單，這時下一關若還
   * 沒補上，他會卡在建立簽核鏈。反過來先補 685，就算第二步失敗，685 也只是被補齊
   * 了設定，不會有人因此送不出單。
   *
   * 要新建的關卡排在最前面：686 的起點得指到新角色的 role_id，角色沒建好就沒得指。
   *
   * @returns {Promise<{created, updated, rolesCreated, rolesUpdated}>}
   */
  const createEntriesWithNextStep = async (pairs, nextUpdates, newRoles = [],
    { roleNameSeparator = null } = {}) => {
    let rolesCreated = 0;
    let resolved = pairs;

    if (newRoles.length) {
      const { records, roleIdByRow } =
        buildNewRoleRecords(newRoles, await nextRoleSeq(), { roleNameSeparator });
      for (const part of chunk(records, CONFIG.WRITE_BATCH)) {
        await kintoneApi('/k/v1/records.json', 'POST',
          { app: APP_ID.ROLE_DEFINITION, records: part });
      }
      rolesCreated = records.length;

      // 回填新角色的 role_id。對不上就中止：與其把人的起點留空，不如讓
      // runWriteAction 報錯並提醒重新掃描，至少 685 那邊的角色是完整的
      resolved = pairs.map((p) => {
        if (p.roleId) return p;
        const roleId = roleIdByRow.get(p.rowId);
        if (!roleId) throw new Error(`新建角色後找不到 ${p.code} 對應的 role_id，起點尚未建立`);
        return { ...p, roleId };
      });
    }

    const rolesUpdated = nextUpdates.length ? await updateRoleRecords(nextUpdates) : 0;
    const { created, updated } = await upsertEntries(resolved);
    return { created, updated, rolesCreated, rolesUpdated };
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
   * 並支援 ↑↓ 移動、Enter 選取、Esc 取消。清單預設向「上」展開（openUp 參數控制），
   * 原本是給報告視窗底部的 B～F 分頁用、避免被視窗下緣裁切；A 分頁每一列都在表格中間，
   * 改由呼叫端傳 openUp: false 向下展開。
   *
   * @param {Array<{unit: string, items: Array<{value: string, label: string}>}>} groups
   *        依單位分組的選項（與原 optgroup 結構相同）
   * @param {Function} onChange - 選取值變動時回呼（用來更新執行按鈕的啟用狀態）
   * @param {{openUp?: boolean, minWidth?: string, alignRight?: boolean}} [opts]
   *   alignRight：清單改為靠右對齊展開。表格最後一欄的下拉若照預設向右長出去，
   *   會被捲動容器裁掉（overflow-y:auto 同時也會裁 x），靠右展開才看得到完整清單。
   * @returns {{el: HTMLElement, getValue: Function, getLabel: Function, setValue: Function}}
   *   setValue：由外部指定選取值（自動配對帶入用），找不到對應選項時視為未選取並 console.warn
   */
  const buildRoleCombo = (groups, onChange,
    { openUp = true, minWidth = '300px', alignRight = false } = {}) => {
    const options = groups.flatMap((g) => g.items.map((it) => ({ ...it, unit: g.unit })));

    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative; display:inline-block;';

    const input = document.createElement('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.placeholder = `輸入關鍵字搜尋角色…（共 ${options.length} 個）`;
    input.style.cssText =
      `font-size:14px; padding:8px 10px; min-width:${minWidth}; box-sizing:border-box; ` +
      'border:1px solid #ccc; border-radius:6px;';

    const panel = document.createElement('div');
    panel.style.cssText =
      `position:absolute; ${alignRight ? 'right' : 'left'}:0; min-width:340px; max-height:300px; ` +
      `${openUp ? 'bottom' : 'top'}:calc(100% + 4px); ` +
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
      /**
       * 由外部指定選取值（自動配對帶入用）。
       * 刻意不觸發 onChange——大量初始化時由呼叫端最後統一刷新一次即可。
       * 傳入的值找不到對應選項時視為未選取。
       */
      setValue: (value) => {
        const o = options.find((x) => x.value === value);
        if (!o && value) {
          // 找不到對應選項時畫面上跟「真的沒有角色可配」長得一模一樣（紅底、勾不動），
          // HR 分不出是資料真的缺角色，還是傳進來的值本身就是錯的，留一筆可查的線索
          console.warn('[ApprovalRouting] buildRoleCombo.setValue 找不到對應選項', value);
        }
        selected = o ? { value: o.value, label: o.label } : null;
        input.value = selected?.label || '';
      },
    };
  };

  /**
   * 可打字搜尋的單層選擇器（無分組版，供純字串清單使用——目前是 A 分頁新建角色時
   * 挑 unit_name / title_level；兩份清單通常只有十來個選項，不需要 buildRoleCombo
   * 的單位分組，但保留同一套打字過濾／↑↓／Enter／Esc 互動，操作手感一致）。
   *
   * @param {string[]} options
   * @param {Function} onChange
   * @param {{minWidth?: string}} [opts]
   * @returns {{el: HTMLElement, getValue: Function, setValue: Function}}
   *   getValue/setValue 的值就是選項字串本身（value === label，沒有分開的代碼）
   */
  const buildFlatCombo = (options, onChange, { minWidth = '160px' } = {}) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative; display:inline-block;';

    const input = document.createElement('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.placeholder = '輸入關鍵字…';
    input.style.cssText =
      `font-size:13px; padding:5px 8px; min-width:${minWidth}; max-width:220px; box-sizing:border-box; ` +
      'border:1px solid #ccc; border-radius:4px;';

    const panel = document.createElement('div');
    panel.style.cssText =
      'position:absolute; top:calc(100% + 3px); left:0; min-width:200px; max-height:220px; ' +
      'overflow-y:auto; background:#fff; border:1px solid #ccc; border-radius:6px; ' +
      'box-shadow:0 4px 14px rgba(0,0,0,.16); z-index:20; display:none;';

    let selected = '';
    let matches = [];
    let active = -1;

    const highlight = (label, kw) => {
      const i = kw ? label.toLowerCase().indexOf(kw.toLowerCase()) : -1;
      if (i < 0) return esc(label);
      return esc(label.slice(0, i)) +
        `<strong style="color:#1a6ea8;">${esc(label.slice(i, i + kw.length))}</strong>` +
        esc(label.slice(i + kw.length));
    };

    const paint = (keyboard = false) => {
      for (const el of panel.querySelectorAll('[data-idx]')) {
        const on = Number(el.dataset.idx) === active;
        el.style.background = on ? '#e0e7ff' : '';
        el.style.fontWeight = on ? '600' : '400';
        if (on && keyboard) el.scrollIntoView({ block: 'nearest' });
      }
    };

    const renderPanel = (keyword) => {
      const kw = keyword.trim();
      const k = kw.toLowerCase();
      matches = k ? options.filter((o) => o.toLowerCase().includes(k)) : options;
      active = matches.indexOf(selected);

      panel.innerHTML = '';
      if (!matches.length) {
        const empty = document.createElement('div');
        empty.textContent = '找不到符合的選項';
        empty.style.cssText = 'padding:10px 12px; color:#999; font-size:13px;';
        panel.appendChild(empty);
        return;
      }

      matches.forEach((label, idx) => {
        const item = document.createElement('div');
        item.dataset.idx = String(idx);
        item.innerHTML = highlight(label, kw);
        item.style.cssText = 'padding:7px 12px; font-size:13px; cursor:pointer;';
        item.addEventListener('mousedown', (e) => { e.preventDefault(); choose(idx); });
        item.addEventListener('mouseenter', () => { active = idx; paint(); });
        panel.appendChild(item);
      });
      paint();
    };

    const open = (kw) => { renderPanel(kw); panel.style.display = 'block'; };
    const close = () => { panel.style.display = 'none'; };

    const choose = (idx) => {
      const label = matches[idx];
      if (label === undefined) return;
      selected = label;
      input.value = label;
      close();
      onChange();
    };

    input.addEventListener('focus', () => { input.select(); open(''); });
    input.addEventListener('input', () => {
      if (selected && input.value !== selected) { selected = ''; onChange(); }
      open(input.value);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (panel.style.display === 'none') open(input.value);
        if (!matches.length) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
        paint(true);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (panel.style.display !== 'none' && active >= 0) choose(active);
      } else if (e.key === 'Escape') {
        close();
        input.value = selected || '';
      }
    });
    input.addEventListener('blur', () => {
      setTimeout(() => { close(); input.value = selected || ''; }, 200);
    });

    wrap.append(input, panel);
    return {
      el: wrap,
      getValue: () => selected,
      setValue: (value) => {
        selected = options.includes(value) ? value : '';
        input.value = selected;
      },
    };
  };

  /**
   * 渲染單一分頁（B～F 共用；A 分頁改走 buildEntryTab，見下方）：
   * 工具列（第三欄篩選 + 搜尋 + 全選）、人員表格、底部動作列（角色選擇〔選配〕 + 執行按鈕 + 匯出 CSV）
   * @param {string} groupLabel  - 第三欄標題（B 用「單位」、C 用「單位」、D 用「擔任角色」、
   *                               E 用「狀態／單位」、F 用「單位」），資料一律放在 users[].units
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
      // 英數字不分大小寫（打 jim 要搜得到 Jim）；中文沒有大小寫，toLowerCase 不影響
      const kw = toolbar.querySelector('[data-role="search"]').value.trim().toLowerCase();
      visible = users.filter((u) =>
        (!unit || u.units.includes(unit)) &&
        (!kw || u.name.toLowerCase().includes(kw) || u.code.toLowerCase().includes(kw) ||
          (u.jobTitle || '').toLowerCase().includes(kw)));

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

  /**
   * A 區人員分流：能明確歸到「單位＋職稱」的走分組，其餘走例外區
   *
   * 同單位同職稱的人起點角色必然相同，所以分組後一組只要選一次角色。
   * 兼任多單位、職稱有多個、沒有職稱、或單位是「（未分類）」的人無法歸類，
   * 一律進例外區逐人手選——把他們硬綁成一組，會逼 HR 給不同狀況的人同一個起點。
   *
   * 兩邊互斥，同一個人只會出現在其中一列，這是「不會建出兩筆起點」的第一道保險。
   *
   * @param {Array} users - A 區人員，需含 code / name / jobTitle / units
   * @returns {{groups: Array<{key, unit, title, members}>, exceptions: Array}}
   */
  const groupNoEntryUsers = (users) => {
    const map = new Map();
    const exceptions = [];

    for (const u of users) {
      const units = u.units || [];
      const title = (u.jobTitle || '').trim();
      const unit = units[0] || '';
      // 職稱以「、」串接多個時，代表這人身兼數職，同樣無法機械式歸類
      if (units.length !== 1 || unit === UNGROUPED_LABEL || !title || title.includes('、')) {
        exceptions.push(u);
        continue;
      }
      // \u0000 不可能出現在單位或職稱裡，拿來當組合鍵的分隔字元最安全
      const key = `${unit}\u0000${title}`;
      if (!map.has(key)) map.set(key, { key, unit, title, members: [] });
      map.get(key).members.push(u);
    }

    const groups = [...map.values()].sort((a, b) =>
      a.unit.localeCompare(b.unit, 'zh-Hant') || a.title.localeCompare(b.title, 'zh-Hant'));
    exceptions.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-Hant'));
    return { groups, exceptions };
  };

  /**
   * 依「單位＋職稱」在啟用角色裡找對應的起點角色
   *
   * 直接比 unit_name / title_level 兩個欄位，不去拆 role_name 字串——
   * role_name 是這兩欄組出來的計算欄位，比原始欄位才不會被分隔符號綁死。
   *
   * 同名角色有多筆是正常的（一筆記錄只掛一個人），固定取記錄編號最小者，
   * 讓每次執行的結果一致。
   *
   * @returns {{roleId, roleName, nextConsistent}|null} 配不到時回 null
   */
  const matchEntryRole = (unit, title, roles) => {
    const hits = roles
      .filter((r) => r.unitName === unit && r.titleLevel === title)
      .sort((a, b) => Number(a.recordId) - Number(b.recordId));
    if (!hits.length) return null;

    const picked = hits[0];
    return {
      roleId: picked.roleId,
      roleName: picked.roleName,
      // 同名記錄的下一關不一致時，起點指到哪一筆會走出不同的鏈，要提醒 HR
      nextConsistent: isNextRoleConsistent(picked.roleId, roles),
    };
  };

  /**
   * A 分頁「下一關」欄的唯讀說明文字（這一關已經設好時才會顯示）
   *
   * @param {object|null} status - inspectNextStep 的結果
   */
  const describeNextStep = (status, roles) => {
    switch (true) {
      case !status:            return '—';
      case !status.nextRoleId: return '（終點）';
      default: {
        const next = roles.find((r) => r.roleId === status.nextRoleId);
        return next ? next.roleName : `未知：${status.nextRoleId}`;
      }
    }
  };

  /**
   * A 分頁：未設定起點（依「單位＋職稱」分組，可跨多個單位一次建立）
   *
   * 主表一組一列，自動配到的角色先帶入，配不到的整列標紅且勾不動；
   * 兼任多單位／多職稱／資料不全者另立一區逐人手選。
   *
   * 起點角色選定後，同一列還會看那一關在 685 有沒有下一關：沒有就在「下一關」欄
   * 就地補選，補齊之前這一列勾不動。686 的起點與 685 的下一關因此一定同時設好，
   * 不會留下「有起點卻沒有下一關」的斷鏈。
   *
   * 配不到現有角色的列（含例外區）在角色清單最前面多一個「＋ 在 685 建立這個角色」，
   * 選了就地填 unit_name / title_level 建起來，不必先跑一趟 tools/04 再回來。
   *
   * 「人數」欄不再只是數字：多人一組時可展開看完整名單，也可按「拆開設定」把整組
   * 拆成一人一列，各自挑不同的角色（原組列不刪除、只隱藏，按「合併回整組」可復原，
   * 不必重新配對一次）。單人列直接顯示姓名，不必再點一次。
   *
   * DOM 只建一次，搜尋與篩選僅切換每列的 display——整個重建會把使用者
   * 已經挑好的角色一起洗掉。
   */
  const buildEntryTab = ({ users, roles, roleOptions, nextOptions, roleForm, onAction, onExport }) => {
    const { groups, exceptions } = groupNoEntryUsers(users);
    // 迴圈偵測每次 refresh 都會用到，對照表建一次重複使用
    const roleById = new Map(roles.map((r) => [r.roleId, r]));

    // 讀不到 685 的下拉選項就不提供就地新建（沒有選項可填，建出來也是壞的）
    const canCreate = Boolean(roleForm?.unitOptions?.length && roleForm?.titleOptions?.length);
    const roleOptionsWithCreate = canCreate
      ? [{ unit: '新建角色', items: [{ value: CREATE_ROLE_VALUE, label: '＋ 在 685 建立這個角色' }] },
         ...roleOptions]
      : roleOptions;

    const rows = [
      ...groups.map((g) => ({
        id: `g:${g.key}`, isException: false,
        unit: g.unit, title: g.title, members: g.members,
        match: matchEntryRole(g.unit, g.title, roles),
      })),
      ...exceptions.map((u) => ({
        id: `u:${u.code}`, isException: true,
        unit: (u.units || []).join('、'), title: u.jobTitle || '', members: [u],
        match: null,   // 單位／職稱本來就不明確，不做自動配對
      })),
    ];

    const root = document.createElement('div');
    root.style.cssText = 'display:flex; flex-direction:column; height:100%;';

    // ── 工具列（分組後列數已大幅減少，不再需要單位篩選下拉）──
    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'display:flex; gap:12px; align-items:center; margin-bottom:10px; flex-wrap:wrap;';
    toolbar.innerHTML = `
      <input data-role="search" type="text" placeholder="搜尋單位、職稱、姓名或帳號…"
             style="font-size:14px; padding:6px 10px; border:1px solid #ccc; border-radius:4px; min-width:240px;">
      <label style="font-size:14px;"><input type="checkbox" data-role="only-unset"> 只看尚未指定</label>
      <label style="font-size:14px;"><input type="checkbox" data-role="check-all"> 全選（目前顯示且已指定）</label>
      <span data-role="count" style="font-size:13px; color:#666; margin-left:auto;"></span>
    `;

    // ── 表格 ──
    const listWrap = document.createElement('div');
    listWrap.style.cssText = 'flex:1; overflow-y:auto; border:1px solid #e0e0e0; border-radius:6px;';
    const table = document.createElement('table');
    table.style.cssText = 'width:100%; border-collapse:collapse; font-size:14px;';
    table.innerHTML = `
      <thead>
        <tr style="background:#f5f5f5; position:sticky; top:0; z-index:2;">
          <th style="padding:8px; width:36px;"></th>
          <th style="padding:8px; text-align:left;">單位</th>
          <th style="padding:8px; text-align:left;">職稱</th>
          <th style="padding:8px; text-align:left; width:150px;">人數 / 成員</th>
          <th style="padding:8px; text-align:left;">起點角色</th>
          <th style="padding:8px; text-align:left;">下一關（685）</th>
        </tr>
      </thead>
      <tbody></tbody>`;
    listWrap.appendChild(table);
    const tbody = table.querySelector('tbody');

    // ── 底部動作列 ──
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex; gap:12px; align-items:center; margin-top:12px; flex-wrap:wrap;';
    const actionBtn = document.createElement('button');
    actionBtn.style.cssText =
      'font-size:15px; padding:10px 24px; background:#3498db; color:#fff; border:none; border-radius:6px; cursor:pointer;';
    const exportBtn = document.createElement('button');
    exportBtn.textContent = '匯出 CSV';
    exportBtn.style.cssText =
      'font-size:14px; padding:10px 18px; background:#fff; color:#333; border:1px solid #ccc; border-radius:6px; cursor:pointer; margin-left:auto;';

    // row.id → { row, tr, combo, cb, warn, ...; split 系列（見 splitGroupRow）：
    //   split=true 代表這一列已經拆成子列，本身隱藏、不參與計數／送出，
    //   ctrlTr 是「已拆分…合併回整組」控制列，childIds 是拆出來的子列 id
    const state = new Map();
    let dividerTr = null;

    /** 依搜尋與篩選切換每列顯示，並更新計數與按鈕狀態 */
    const refresh = () => {
      // 英數字不分大小寫（打 jim 要搜得到 Jim）
      const kw = toolbar.querySelector('[data-role="search"]').value.trim().toLowerCase();
      const onlyUnset = toolbar.querySelector('[data-role="only-unset"]').checked;

      let assigned = 0;
      let pickedRows = 0;
      let pickedPeople = 0;
      let needNextRows = 0;
      let exceptionVisible = false;

      for (const s of state.values()) {
        // 已拆分的組列本身不再代表任何人，永遠隱藏、不進計數——它的成員
        // 已經各自變成獨立的子列，由子列自己算
        if (s.split) { s.tr.style.display = 'none'; continue; }

        const roleId = s.combo.getValue();
        const hasRole = Boolean(roleId);
        const creating = roleId === CREATE_ROLE_VALUE;
        if (hasRole) assigned += 1;

        // 新建模式：就地填 unit_name / title_level，角色名稱由兩者組出來預覽
        if (s.createBox) s.createBox.style.display = creating ? '' : 'none';
        const newUnit  = creating ? s.unitSel.getValue() : '';
        const newTitle = creating ? s.titleSel.getValue() : '';
        const newRoleName = (newUnit && newTitle)
          ? `${newUnit}${roleForm.roleNameSeparator ?? ' - '}${newTitle}`
          : '';
        // 選出來的單位＋職稱若已經有角色，再建一次就是重複的關卡，擋下來請他直接選
        const duplicate = creating && Boolean(newUnit && newTitle) &&
          roles.some((r) => r.unitName === newUnit && r.titleLevel === newTitle);
        const createReady = !creating || (Boolean(newUnit && newTitle) && !duplicate);

        if (s.createNote) {
          s.createNote.textContent = duplicate
            ? `685 已經有「${newRoleName}」，請直接從上面的清單選，不要重複建立`
            : (newRoleName
              ? `角色名稱：${newRoleName}　簽核者：這組 ${s.row.members.length} 人各建一筆`
              : '請選擇單位與職稱');
          s.createNote.style.color = duplicate ? '#c0392b' : '#555';
        }

        // 起點角色選定後，順帶看 685 那一關有沒有下一關；沒有就在同一列補設，
        // 兩邊在同一次動作寫完，不會只設好一邊。
        // 全新的角色一定沒有下一關，一律要求指定。
        const status = (hasRole && !creating) ? inspectNextStep(roleId, roles) : null;
        const needNext = creating || (Boolean(status) && !status.hasNext);
        if (needNext) needNextRows += 1;

        // 換了起點角色就重新帶入預設值：同名記錄若已經有人設過下一關，沿用同一個，
        // HR 只有在「這一關從來沒人設過」時才需要自己挑。新建的角色沒有同名記錄可沿用。
        if (needNext && s.seededFor !== roleId) {
          s.seededFor = roleId;
          const sibling = status &&
            roles.find((r) => r.roleName === status.roleName && hasNextStep(r));
          s.nextCombo.setValue(sibling ? (sibling.nextRoleId || CHAIN_END_VALUE) : '');
        }

        const nextValue = needNext ? s.nextCombo.getValue() : '';
        // 新建的角色還沒有人指向它，不可能繞回自己，省下這次走訪
        const cycle = (status && nextValue && nextValue !== CHAIN_END_VALUE)
          ? walkBackTo(nextValue, status.roleName, roleById)
          : { cycle: false, path: [] };
        const nextReady = !needNext || (Boolean(nextValue) && !cycle.cycle);

        s.nextCombo.el.style.display = needNext ? '' : 'none';
        s.nextNote.style.display = needNext ? '' : 'none';
        s.nextText.style.display = needNext ? 'none' : '';
        s.nextText.textContent = describeNextStep(status, roles);
        switch (true) {
          case cycle.cycle:
            s.nextNote.textContent = `會繞回自己：${cycle.path.join(' → ')}，請改選其他關卡`;
            break;
          case creating:
            s.nextNote.textContent = nextValue
              ? '新角色會直接帶著這個下一關建立'
              : '新角色一定要有下一關，請指定（也可以設為終點）';
            break;
          case Boolean(nextValue):
            s.nextNote.textContent = '這一關在 685 還沒設下一關，會跟起點一起寫入';
            break;
          default:
            s.nextNote.textContent = '這一關在 685 還沒設下一關，請一併指定，才能跟起點一起寫入';
        }
        s.nextNote.style.color = cycle.cycle ? '#c0392b' : '#92400e';

        // 起點沒指定、單位職稱沒填齊、下一關還沒補齊，都不讓勾——
        // 不可能送出只設好一半的資料
        s.cb.disabled = !hasRole || !createReady || !nextReady;
        if (s.cb.disabled && s.cb.checked) s.cb.checked = false;

        // 會一併寫進 685 的列全程標色，HR 一眼看得出這次動作不只動 686
        switch (true) {
          case !hasRole:    s.tr.style.background = '#fdecea'; break;   // 尚未指定起點
          case cycle.cycle: s.tr.style.background = '#fdecea'; break;   // 下一關繞回自己
          case duplicate:   s.tr.style.background = '#fdecea'; break;   // 這個角色已經存在
          case creating:    s.tr.style.background = '#eef6ff'; break;   // 會新建 685 角色
          case needNext:    s.tr.style.background = '#fffbeb'; break;   // 這一關的下一關要一起補
          default:          s.tr.style.background = '';
        }

        // 警告跟著目前選到的角色走：換角色、或在例外區手動挑選都要重新判斷
        s.warn.style.display =
          (status && isNextRoleConsistent(roleId, roles) === false) ? '' : 'none';

        const haystack = [s.row.unit, s.row.title,
          ...s.row.members.map((m) => `${m.name} ${m.code}`)].join(' ').toLowerCase();
        const show = (!kw || haystack.includes(kw)) && (!onlyUnset || !hasRole);
        s.tr.style.display = show ? '' : 'none';
        if (show && s.row.isException) exceptionVisible = true;

        if (s.cb.checked) {
          pickedRows += 1;
          pickedPeople += s.row.members.length;
        }
      }

      if (dividerTr) dividerTr.style.display = exceptionVisible ? '' : 'none';

      toolbar.querySelector('[data-role="count"]').textContent =
        `已指定 ${assigned}/${state.size} 列・已勾選 ${pickedRows} 列（${pickedPeople} 人）` +
        (needNextRows ? `・待補下一關 ${needNextRows} 列` : '');
      actionBtn.textContent = pickedPeople
        ? `一次設定 ${pickedPeople} 人的起點`
        : '一次設定起點';
      actionBtn.disabled = pickedRows === 0;
      actionBtn.style.opacity = actionBtn.disabled ? '0.5' : '1';
    };

    /** 例外區的分隔標題列 */
    const appendDivider = (text) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td colspan="6" style="padding:8px 10px; background:#f7f9fc; border-top:1px solid #e5e7eb; font-size:13px; font-weight:700; color:#555;">${esc(text)}</td>`;
      tbody.appendChild(tr);
      return tr;
    };

    const appendRow = (row, { insertAfter = null } = {}) => {
      const tr = document.createElement('tr');
      tr.style.borderTop = '1px solid #eee';

      const tdCheck = document.createElement('td');
      tdCheck.style.cssText = 'padding:6px 8px; text-align:center;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.addEventListener('change', () => refresh());
      tdCheck.appendChild(cb);

      const tdUnit = document.createElement('td');
      tdUnit.style.cssText = 'padding:6px 8px;';
      tdUnit.textContent = row.unit || '—';

      const tdTitle = document.createElement('td');
      tdTitle.style.cssText = 'padding:6px 8px;';
      tdTitle.innerHTML = row.title
        ? `<span style="display:inline-block; padding:1px 8px; border-radius:4px; background:#eef2ff; border:1px solid #c7d2fe; color:#3730a3; font-weight:600;">${esc(row.title)}</span>`
        : '<span style="color:#bbb;">—</span>';

      const tdCount = document.createElement('td');
      tdCount.style.cssText = 'padding:6px 8px; text-align:left;';
      // 滑過去看得到這組是誰，送出前可以確認（多人時另有可展開的名單）
      tdCount.title = row.members.map((m) => `${m.name}（${m.code}）`).join('\n');

      const countLine = document.createElement('div');
      countLine.style.cssText = 'font-weight:600;';
      countLine.textContent = `${row.members.length} 人`;
      tdCount.appendChild(countLine);

      if (row.members.length > 1) {
        // 多人一組：預設收合，展開才看得到完整名單，表格才不會被撐開
        const namesBox = document.createElement('div');
        namesBox.style.cssText = 'margin-top:4px; display:none;';
        namesBox.innerHTML = row.members.map((m) =>
          `<div style="font-size:12px; color:#555; white-space:nowrap;">` +
          `${esc(m.name)}<span style="color:#aaa;">（${esc(m.code)}）</span></div>`).join('');

        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.textContent = '名單 ▸';
        toggleBtn.style.cssText =
          'font-size:11px; padding:0; border:none; background:none; color:#2980b9; ' +
          'cursor:pointer; text-decoration:underline;';
        toggleBtn.addEventListener('click', () => {
          const opening = namesBox.style.display === 'none';
          namesBox.style.display = opening ? 'block' : 'none';
          toggleBtn.textContent = opening ? '名單 ▾' : '名單 ▸';
        });
        tdCount.append(toggleBtn, namesBox);

        // 已經拆出來的子列本身就是一人一列，不能再拆一次
        if (!row.isChild) {
          const splitBtn = document.createElement('button');
          splitBtn.type = 'button';
          splitBtn.textContent = '拆開設定';
          splitBtn.title = '把這組拆成一人一列，可各自挑不同的起點角色';
          splitBtn.style.cssText =
            'display:block; margin-top:4px; font-size:11px; padding:1px 7px; ' +
            'border:1px solid #93c5fd; background:#fff; color:#1e40af; border-radius:4px; cursor:pointer;';
          splitBtn.addEventListener('click', () => splitGroupRow(row));
          tdCount.appendChild(splitBtn);
        }
      } else if (row.members[0]) {
        // 一人一列本來就只有一個人，直接顯示姓名，不必再點一次才看得到
        const nameLine = document.createElement('div');
        nameLine.style.cssText = 'margin-top:2px; font-size:11px; color:#777; white-space:nowrap;';
        nameLine.textContent = row.members[0].name;
        tdCount.appendChild(nameLine);
      }

      const tdRole = document.createElement('td');
      tdRole.style.cssText = 'padding:6px 8px;';
      // 配到現有角色的列不需要「新建」這個選項，清單保持乾淨
      const combo = buildRoleCombo(row.match ? roleOptions : roleOptionsWithCreate,
        () => refresh(), { openUp: false, minWidth: '260px' });
      if (row.match) combo.setValue(row.match.roleId);
      tdRole.appendChild(combo.el);

      // 新建模式：單位與職稱先用組織資料帶入，帶不到的留白讓 HR 自己選。
      // 例外區的單位／職稱本來就不明確（兼任多單位、多職稱），一律留白。
      let createBox = null;
      let unitSel = null;
      let titleSel = null;
      let createNote = null;
      if (!row.match && canCreate) {
        const seedUnit = row.isException ? '' : guessUnitName(row.unit, roleForm.unitOptions);
        const seedTitle = row.isException
          ? ''
          : guessTitleLevel(row.title, roleForm.titleOptions).value;

        createBox = document.createElement('div');
        createBox.style.cssText =
          'margin-top:6px; padding:6px 8px; border:1px dashed #93c5fd; border-radius:6px; ' +
          'background:#f5faff; display:none;';

        const line = document.createElement('div');
        line.style.cssText = 'display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:13px;';
        unitSel = buildFlatCombo(roleForm.unitOptions, () => refresh(), { minWidth: '160px' });
        titleSel = buildFlatCombo(roleForm.titleOptions, () => refresh(), { minWidth: '110px' });
        unitSel.setValue(seedUnit);
        titleSel.setValue(seedTitle);
        line.append(Object.assign(document.createElement('span'), { textContent: '單位' }), unitSel.el,
                    Object.assign(document.createElement('span'), { textContent: '職稱' }), titleSel.el);

        createNote = document.createElement('div');
        createNote.style.cssText = 'margin-top:4px; font-size:12px; color:#555;';

        createBox.append(line, createNote);
        tdRole.appendChild(createBox);
      }

      // 同名記錄的下一關不一致，起點指到哪一筆會走出不同的鏈。
      // 這個警告要跟著「目前下拉的值」走，不能只在自動配對當下判斷一次就定死——
      // HR 改選別的角色、或在例外區（match 一律是 null）手動挑角色，都要重新算。
      // 顯示與否交給 refresh() 依 isNextRoleConsistent(combo.getValue()) 決定。
      const warn = document.createElement('div');
      warn.textContent = '同名角色的下一關設定不一致，建議先用「批次設定下一關」統一';
      warn.style.cssText = 'margin-top:4px; font-size:12px; color:#92400e; display:none;';
      tdRole.appendChild(warn);

      // 下一關：這一關在 685 已經設好就顯示唯讀文字；沒設好就換成選擇器要求補齊。
      // 兩者的切換與提示文字都交給 refresh() 依目前選到的起點角色決定。
      const tdNext = document.createElement('td');
      tdNext.style.cssText = 'padding:6px 8px;';
      const nextText = document.createElement('span');
      nextText.style.cssText = 'color:#666;';
      const nextCombo = buildRoleCombo(nextOptions, () => refresh(),
        { openUp: false, minWidth: '240px', alignRight: true });
      nextCombo.el.style.display = 'none';
      const nextNote = document.createElement('div');
      nextNote.style.cssText = 'margin-top:4px; font-size:12px; color:#92400e; display:none;';
      tdNext.append(nextText, nextCombo.el, nextNote);

      tr.append(tdCheck, tdUnit, tdTitle, tdCount, tdRole, tdNext);
      // 拆分出來的子列要插在「已拆分」控制列與前一個子列之後，緊接在原組列位置；
      // 一般列（含初始渲染與例外區）照舊接在表格末端
      if (insertAfter) insertAfter.insertAdjacentElement('afterend', tr);
      else tbody.appendChild(tr);
      // seededFor 記住「下一關預設值是為哪個起點角色帶入的」，換角色才會重新帶
      state.set(row.id, {
        row, tr, combo, cb, warn, nextText, nextCombo, nextNote, seededFor: '',
        createBox, unitSel, titleSel, createNote,
        split: false, childIds: [], ctrlTr: null,
      });
      return tr;
    };

    /**
     * 把一組多人的列拆成一人一列，各自可以挑不同的起點角色。
     *
     * 原組列不刪除、只隱藏——state 裡的資料原封不動，合併回整組時直接復原，
     * 不必重新配對一次。拆出來的子列與一般列走同一套 appendRow，各自獨立的
     * combo／nextCombo，互不影響彼此的選擇。
     */
    const splitGroupRow = (row) => {
      const parent = state.get(row.id);
      if (!parent || parent.split) return;

      parent.split = true;
      parent.cb.checked = false;   // 拆開後原組列不再代表任何人，避免殘留勾選被誤送
      parent.tr.style.display = 'none';

      const ctrlTr = document.createElement('tr');
      ctrlTr.innerHTML =
        `<td colspan="6" style="padding:6px 10px; background:#eef6ff; border-top:1px solid #bfdbfe; font-size:12px; color:#1e40af;">` +
        `已拆分成 ${row.members.length} 筆，可各自指定` +
        `<button data-role="merge" style="margin-left:10px; font-size:12px; padding:2px 10px; border:1px solid #93c5fd; background:#fff; color:#1e40af; border-radius:4px; cursor:pointer;">合併回整組</button>` +
        `</td>`;
      parent.tr.insertAdjacentElement('afterend', ctrlTr);
      ctrlTr.querySelector('[data-role="merge"]').addEventListener('click', () => mergeGroupRow(row));

      let cursor = ctrlTr;
      const childIds = [];
      for (const m of row.members) {
        const childRow = {
          id: `${row.id}::${m.code}`, isException: false, isChild: true,
          unit: row.unit, title: row.title, members: [m], match: row.match,
        };
        cursor = appendRow(childRow, { insertAfter: cursor });
        childIds.push(childRow.id);
      }

      parent.ctrlTr = ctrlTr;
      parent.childIds = childIds;
      refresh();
    };

    /** 合併回整組：移除拆分出來的子列與控制列，還原成原本收合的組列 */
    const mergeGroupRow = (row) => {
      const parent = state.get(row.id);
      if (!parent || !parent.split) return;

      for (const id of parent.childIds) {
        const child = state.get(id);
        if (!child) continue;
        child.tr.remove();
        state.delete(id);
      }
      parent.ctrlTr?.remove();
      parent.ctrlTr = null;
      parent.childIds = [];
      parent.split = false;
      parent.tr.style.display = '';
      refresh();
    };

    rows.filter((r) => !r.isException).forEach(appendRow);
    const exceptionRows = rows.filter((r) => r.isException);
    if (exceptionRows.length) {
      dividerTr = appendDivider(
        `兼任多單位／多職稱／資料不全（${exceptionRows.length} 人）— 請逐人指定` +
        '（以下列一開始就是紅底，代表「尚未指定」，不是自動配對失敗——這區本來就不做自動配對）');
      exceptionRows.forEach(appendRow);
    }
    if (!rows.length) {
      tbody.innerHTML =
        '<tr><td colspan="6" style="padding:16px; color:#999; text-align:center;">沒有未設定起點的人員</td></tr>';
    }

    toolbar.querySelector('[data-role="search"]').addEventListener('input', refresh);
    toolbar.querySelector('[data-role="only-unset"]').addEventListener('change', refresh);
    toolbar.querySelector('[data-role="check-all"]').addEventListener('change', (e) => {
      for (const s of state.values()) {
        if (s.tr.style.display === 'none' || s.cb.disabled) continue;
        s.cb.checked = e.target.checked;
      }
      refresh();
    });

    actionBtn.addEventListener('click', () => {
      const pairs = [];
      const pickedGroups = [];   // 已勾選且已指定角色的列，供確認視窗列出明細
      const assignments = [];    // 這次要一併補進 685 的下一關
      const newRoles = [];       // 這次要在 685 新建的關卡
      let readyRows = 0;         // 已指定角色但沒勾選的列（會被留下，最容易被忽略）
      let readyPeople = 0;
      let unassignedRows = 0;    // 完全沒指定角色的列

      for (const s of state.values()) {
        if (s.split) continue;   // 已拆分，成員已經各自變成獨立子列

        const roleId = s.combo.getValue();
        if (!roleId) { unassignedRows += 1; continue; }

        if (!s.cb.checked) {
          readyRows += 1;
          readyPeople += s.row.members.length;
          continue;
        }

        const creating = roleId === CREATE_ROLE_VALUE;
        const label = `${s.row.unit || '—'}／${s.row.title || '—'}`;

        // entryRecordIds 非空＝這人已經有起點記錄、只是沒填角色，補填原記錄就好。
        // 新建模式的 roleId 要等角色建好才知道，先留空、帶 rowId 讓寫入端回填。
        for (const m of s.row.members) {
          pairs.push({
            code: m.code,
            roleId: creating ? '' : roleId,
            rowId: s.row.id,
            recordIds: m.entryRecordIds || [],
          });
        }

        if (creating) {
          const unitName = s.unitSel.getValue();
          const titleLevel = s.titleSel.getValue();
          const nextValue = s.nextCombo.getValue();
          newRoles.push({
            rowId: s.row.id,
            unitName,
            titleLevel,
            roleName: `${unitName}${roleForm.roleNameSeparator ?? ' - '}${titleLevel}`,
            memberCodes: s.row.members.map((m) => m.code),
            nextValue,
          });
          pickedGroups.push({
            label,
            roleLabel: `新建 ${unitName}／${titleLevel}`,
            count: s.row.members.length,
            nextLabel: s.nextCombo.getLabel(),
            isNew: true,
          });
          continue;
        }

        // 這一關在 685 缺下一關時，把補設內容一起帶出去，讓兩張表同一次寫完
        const status = inspectNextStep(roleId, roles);
        const nextValue = status && !status.hasNext ? s.nextCombo.getValue() : '';
        if (nextValue) {
          assignments.push({
            roleName:  status.roleName,
            recordIds: status.missingIds,
            value:     nextValue,
            label:     s.nextCombo.getLabel(),
          });
        }

        pickedGroups.push({
          label,
          roleLabel: s.combo.getLabel(),
          count: s.row.members.length,
          nextLabel: nextValue ? s.nextCombo.getLabel() : '',
          isNew: false,
        });
      }

      onAction({
        pairs,
        assignments,
        newRoles,
        groupCount: pickedGroups.length,
        peopleCount: new Set(pairs.map((p) => p.code)).size,
        refillCount: new Set(pairs.filter((p) => p.recordIds.length).map((p) => p.code)).size,
        pickedGroups,
        readyRows,
        readyPeople,
        unassignedRows,
      });
    });

    exportBtn.addEventListener('click', () => {
      const members = [...state.values()]
        .filter((s) => s.tr.style.display !== 'none')
        .flatMap((s) => s.row.members);
      onExport(members);
    });

    footer.append(actionBtn, exportBtn);
    root.append(toolbar, listWrap, footer);
    root.dataset.tab = 'A';
    refresh();
    return root;
  };

  /**
   * G 分頁：起點角色設定不完整
   *
   * 一列是一個「被當成起點的關卡」，不是一個人——同一個角色可能有幾十個人以它為
   * 起點，補一次下一關就把那些人一起救回來。
   *
   * 角色在 685 找不到的列一律紅底、勾不動：新建角色要決定簽核者、單位與職稱，
   * 是人的判斷，工具不代勞，只把清單列出來讓 HR 知道該去哪裡補。
   *
   * 與 A 分頁一樣，DOM 只建一次，搜尋僅切換每列的 display。
   */
  const buildBrokenEntryTab = ({ rows, roles, nextOptions, onAction, onExport }) => {
    const roleById = new Map(roles.map((r) => [r.roleId, r]));

    const root = document.createElement('div');
    root.style.cssText = 'display:flex; flex-direction:column; height:100%;';

    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'display:flex; gap:12px; align-items:center; margin-bottom:10px; flex-wrap:wrap;';
    toolbar.innerHTML = `
      <input data-role="search" type="text" placeholder="搜尋角色名稱、單位、姓名或帳號…"
             style="font-size:14px; padding:6px 10px; border:1px solid #ccc; border-radius:4px; min-width:240px;">
      <label style="font-size:14px;"><input type="checkbox" data-role="only-fixable"> 只看可補設的</label>
      <label style="font-size:14px;"><input type="checkbox" data-role="check-all"> 全選（目前顯示且已指定）</label>
      <span data-role="count" style="font-size:13px; color:#666; margin-left:auto;"></span>
    `;

    const listWrap = document.createElement('div');
    listWrap.style.cssText = 'flex:1; overflow-y:auto; border:1px solid #e0e0e0; border-radius:6px;';
    const table = document.createElement('table');
    table.style.cssText = 'width:100%; border-collapse:collapse; font-size:14px;';
    table.innerHTML = `
      <thead>
        <tr style="background:#f5f5f5; position:sticky; top:0; z-index:2;">
          <th style="padding:8px; width:36px;"></th>
          <th style="padding:8px; text-align:left;">起點角色</th>
          <th style="padding:8px; text-align:left;">問題</th>
          <th style="padding:8px; text-align:right; width:80px;">影響人數</th>
          <th style="padding:8px; text-align:left;">下一關（685）</th>
        </tr>
      </thead>
      <tbody></tbody>`;
    listWrap.appendChild(table);
    const tbody = table.querySelector('tbody');

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex; gap:12px; align-items:center; margin-top:12px; flex-wrap:wrap;';
    const actionBtn = document.createElement('button');
    actionBtn.style.cssText =
      'font-size:15px; padding:10px 24px; background:#3498db; color:#fff; border:none; border-radius:6px; cursor:pointer;';
    const exportBtn = document.createElement('button');
    exportBtn.textContent = '匯出 CSV';
    exportBtn.style.cssText =
      'font-size:14px; padding:10px 18px; background:#fff; color:#333; border:1px solid #ccc; border-radius:6px; cursor:pointer; margin-left:auto;';

    const state = new Map();   // row.key → { row, tr, cb, combo, note }

    /** 依搜尋與篩選切換每列顯示，並更新計數與按鈕狀態 */
    const refresh = () => {
      // 英數字不分大小寫（打 jim 要搜得到 Jim）
      const kw = toolbar.querySelector('[data-role="search"]').value.trim().toLowerCase();
      const onlyFixable = toolbar.querySelector('[data-role="only-fixable"]').checked;

      let pickedRows = 0;
      let pickedPeople = 0;

      for (const s of state.values()) {
        const fixable = Boolean(s.combo);          // 角色不存在的列沒有選擇器，補不了
        const value = fixable ? s.combo.getValue() : '';
        const cycle = (value && value !== CHAIN_END_VALUE)
          ? walkBackTo(value, s.row.roleName, roleById)
          : { cycle: false, path: [] };
        const ready = fixable && Boolean(value) && !cycle.cycle;

        s.cb.disabled = !ready;
        if (s.cb.disabled && s.cb.checked) s.cb.checked = false;

        switch (true) {
          case !fixable:    s.tr.style.background = '#fdecea'; break;   // 685 沒有這個角色
          case cycle.cycle: s.tr.style.background = '#fdecea'; break;   // 下一關繞回自己
          case !ready:      s.tr.style.background = '#fffbeb'; break;   // 待補下一關
          default:          s.tr.style.background = '';
        }

        if (s.note) {
          s.note.style.display = cycle.cycle ? '' : 'none';
          s.note.textContent = cycle.cycle
            ? `會繞回自己：${cycle.path.join(' → ')}，請改選其他關卡`
            : '';
        }

        const haystack = [s.row.name, s.row.unitName, s.row.roleId,
          ...s.row.people.map((p) => `${p.name} ${p.code}`)].join(' ').toLowerCase();
        const show = (!kw || haystack.includes(kw)) && (!onlyFixable || fixable);
        s.tr.style.display = show ? '' : 'none';

        if (s.cb.checked) {
          pickedRows += 1;
          pickedPeople += s.row.peopleCount;
        }
      }

      toolbar.querySelector('[data-role="count"]').textContent =
        `共 ${state.size} 個關卡・已勾選 ${pickedRows} 個（影響 ${pickedPeople} 人）`;
      actionBtn.textContent = pickedRows ? `補設 ${pickedRows} 個關卡的下一關` : '補設下一關';
      actionBtn.disabled = pickedRows === 0;
      actionBtn.style.opacity = actionBtn.disabled ? '0.5' : '1';
    };

    const appendRow = (row) => {
      const fixable = row.problem === 'no-next';

      const tr = document.createElement('tr');
      tr.style.borderTop = '1px solid #eee';

      const tdCheck = document.createElement('td');
      tdCheck.style.cssText = 'padding:6px 8px; text-align:center;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.addEventListener('change', () => refresh());
      tdCheck.appendChild(cb);

      const tdRole = document.createElement('td');
      tdRole.style.cssText = 'padding:6px 8px; font-weight:600;';
      tdRole.textContent = row.name;
      const unitLine = document.createElement('div');
      unitLine.textContent = row.unitName;
      unitLine.style.cssText = 'margin-top:2px; font-size:12px; font-weight:400; color:#888;';
      tdRole.appendChild(unitLine);

      const tdProblem = document.createElement('td');
      tdProblem.style.cssText = 'padding:6px 8px;';
      tdProblem.innerHTML = fixable
        ? '<span style="display:inline-block; padding:1px 8px; border-radius:4px; background:#fef3c7; border:1px solid #fcd34d; color:#92400e; font-weight:600;">沒有設下一關</span>'
        : '<span style="display:inline-block; padding:1px 8px; border-radius:4px; background:#fee2e2; border:1px solid #fca5a5; color:#991b1b; font-weight:600;">685 沒有這個角色</span>';

      const tdCount = document.createElement('td');
      tdCount.style.cssText = 'padding:6px 8px; text-align:right;';
      tdCount.textContent = String(row.peopleCount);
      // 滑過去看得到是哪些人受影響，補設前可以確認
      tdCount.title = row.people.map((p) => `${p.name}（${p.code}）`).join('\n');

      const tdNext = document.createElement('td');
      tdNext.style.cssText = 'padding:6px 8px;';
      const combo = fixable
        ? buildRoleCombo(nextOptions, () => refresh(),
            { openUp: false, minWidth: '240px', alignRight: true })
        : null;
      const note = fixable ? document.createElement('div') : null;
      if (combo) {
        note.style.cssText = 'margin-top:4px; font-size:12px; color:#c0392b; display:none;';
        tdNext.append(combo.el, note);
      } else {
        const hint = document.createElement('span');
        hint.textContent = `請到 685 補建「${row.roleId}」，或到 686 把這些人改指到現有角色`;
        hint.style.cssText = 'color:#991b1b; font-size:13px;';
        tdNext.appendChild(hint);
      }

      tr.append(tdCheck, tdRole, tdProblem, tdCount, tdNext);
      tbody.appendChild(tr);
      state.set(row.key, { row, tr, cb, combo, note });
    };

    rows.forEach(appendRow);
    if (!rows.length) {
      tbody.innerHTML =
        '<tr><td colspan="5" style="padding:16px; color:#999; text-align:center;">' +
        '已設定的起點角色在 685 都有對應的角色與下一關</td></tr>';
    }

    toolbar.querySelector('[data-role="search"]').addEventListener('input', refresh);
    toolbar.querySelector('[data-role="only-fixable"]').addEventListener('change', refresh);
    toolbar.querySelector('[data-role="check-all"]').addEventListener('change', (e) => {
      for (const s of state.values()) {
        if (s.tr.style.display === 'none' || s.cb.disabled) continue;
        s.cb.checked = e.target.checked;
      }
      refresh();
    });

    actionBtn.addEventListener('click', () => {
      const assignments = [];
      const picked = [];
      for (const s of state.values()) {
        if (!s.cb.checked) continue;
        const value = s.combo.getValue();
        if (!value) continue;
        assignments.push({
          roleName:  s.row.roleName,
          recordIds: s.row.missingIds,
          value,
          label:     s.combo.getLabel(),
        });
        picked.push({ roleName: s.row.name, nextLabel: s.combo.getLabel(), count: s.row.peopleCount });
      }
      onAction({ assignments, picked, peopleCount: picked.reduce((n, p) => n + p.count, 0) });
    });

    exportBtn.addEventListener('click', () => {
      onExport([...state.values()]
        .filter((s) => s.tr.style.display !== 'none')
        .map((s) => s.row));
    });

    footer.append(actionBtn, exportBtn);
    root.append(toolbar, listWrap, footer);
    root.dataset.tab = 'G';
    refresh();
    return root;
  };

  /** 由角色清單組出選擇器選項（依單位分組、同名去重；filter 可再限縮類型） */
  const buildRoleOptions = (roles, { userTypeOnly = false, valueBy = 'roleId' } = {}) => {
    const seen = new Set();
    const groups = new Map();
    // 同名角色有多筆時固定取記錄編號最小者，與 matchEntryRole 的選法一致，
    // 自動配對帶入的 role_id 才一定找得到對應選項
    const sorted = [...roles].sort((a, b) => Number(a.recordId) - Number(b.recordId));
    for (const r of sorted) {
      if (userTypeOnly && r.holderType !== HT.USER) continue;
      if (seen.has(r.roleName)) continue;
      seen.add(r.roleName);
      // 直接用 unit_name 欄位，不從 role_name 切字串（分隔符號不見得是底線）
      const unit = r.unitName || UNGROUPED_LABEL;
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

  /**
   * 「下一關」選擇器的選項：現有角色，外加一個「設為終點」的特殊選項。
   *
   * 起點本身就是最後一關是合理的（例如總經理自己送單），這種情況要能勾終點，
   * 否則會被逼著隨便指一個下一關。特殊選項排在最前面，不跟單位分組混在一起。
   */
  const buildNextStepOptions = (roles) => [
    { unit: '特殊設定', items: [{ value: CHAIN_END_VALUE, label: '（設為終點，不再往上送）' }] },
    ...buildRoleOptions(roles, { valueBy: 'roleId' }),
  ];

  /**
   * 執行一次批量寫入動作，統一處理「轉圈中／成功／失敗」三種狀態。
   *
   * 寫入是分批送出的（CONFIG.WRITE_BATCH），半途失敗代表前面幾批已經寫進 kintone 了，
   * 所以無論成功或失敗都要呼叫 rescan()，讓報告反映寫入後的真實狀態，
   * 而不是讓使用者看到過期的清單。
   *
   * @param {object} opts
   * @param {string} opts.loadingTitle 轉圈視窗標題，如「建立中…」
   * @param {() => Promise<any>} opts.write 實際寫入呼叫；回傳值會傳給 buildSuccessOptions
   * @param {(result: any) => object} opts.buildSuccessOptions 依寫入結果組出 Swal.fire 的成功選項
   * @param {() => Promise<void>} opts.rescan 重新掃描、刷新報告（async：runTool 內部會
   *        開「掃描中…」的 modal、await API、最後才 Swal.close()，呼叫端必須把它當成
   *        會失敗的非同步動作看待，不能假設它一定順利關掉轉圈）
   */
  const runWriteAction = async ({ loadingTitle, write, buildSuccessOptions, rescan }) => {
    Swal.fire({ title: loadingTitle, allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    try {
      const result = await write();
      await Swal.fire(buildSuccessOptions(result));
    } catch (err) {
      console.error('[ApprovalRouting] 涵蓋率檢查寫入失敗', err);
      Swal.close();
      await showWarning('寫入失敗', `${err?.message || String(err)}，部分可能已經寫入，請重新掃描確認目前狀態。`);
    } finally {
      // rescan 就是 runTool：async、會開「掃描中…」modal、await API、最後才 Swal.close()。
      // 這裡若不接住失敗，reject 會變成 unhandled rejection，轉圈永遠不會關——
      // 寫入本身可能已經成功，卻讓 HR 卡在無限轉圈，比原本要修的症狀更糟。
      try {
        await rescan();
      } catch (rescanErr) {
        console.error('[ApprovalRouting] 涵蓋率檢查寫入後重新掃描失敗', rescanErr);
        Swal.close();
        await showWarning(
          '重新掃描失敗',
          `寫入已送出，請重新開啟「未設定名單」確認結果。（${rescanErr?.message || String(rescanErr)}）`,
        );
      }
    }
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
      'background:#fff; border-radius:10px; width:min(1120px, 96vw); height:min(720px, 92vh); ' +
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
    const tabA = buildEntryTab({
      users: model.noEntry,
      roles: model.roles,
      roleOptions: buildRoleOptions(model.roles, { valueBy: 'roleId' }),
      nextOptions: buildNextStepOptions(model.roles),
      roleForm: model.roleForm,
      onAction: async ({ pairs, assignments, newRoles, groupCount, peopleCount, refillCount,
        pickedGroups, readyRows, readyPeople, unassignedRows }) => {
        if (!pairs.length) return;

        // 同名角色是同一關，下一關只能有一個；兩列指到不同目標就整批擋下來，
        // 靜默取其中一個會讓另一列的人走出非預期的鏈
        const { updates: nextUpdates, conflicts } = planNextStepUpdates(assignments);
        if (conflicts.length) {
          await showWarning(
            '同一個角色被指到不同的下一關',
            `${conflicts.map((c) => `${c.roleName}：${c.labels.join('／')}`).join('；')}。請先統一再送出。`,
          );
          return;
        }

        // 唯一一道把關：跨多單位、可能上百筆、不可逆的寫入，一定要讓 HR 看到
        // 「幾組／幾人」與具體是哪些單位－職稱 → 角色，不能只講一個籠統的人數
        const listHtml = pickedGroups.map((g) =>
          `<div style="padding:4px 2px; border-bottom:1px solid #f0f0f0;">` +
          `${esc(g.label)} → <strong>${esc(g.roleLabel)}</strong>` +
          (g.isNew
            ? '<span style="margin-left:6px; padding:0 6px; border-radius:4px; ' +
              'background:#dbeafe; color:#1e40af; font-size:12px; font-weight:700;">新建</span>'
            : '') +
          `（${g.count} 人）` +
          (g.nextLabel
            ? `<br><span style="color:#1a6ea8; font-size:13px;">└ 這一關的下一關一併設為「${esc(g.nextLabel)}」</span>`
            : '') +
          `</div>`,
        ).join('');

        // 已指定卻沒勾的列是「差一步就好了」，最容易被漏掉，用較重的顏色；
        // 還沒指定角色的列本來就不可能送出，講一聲就好
        const readyNote = readyRows
          ? `<div style="margin-top:10px; color:#92400e; font-weight:600;">另有 <strong>${readyRows}</strong> 列（${readyPeople} 人）` +
            `已經指定角色但沒有勾選，這次<strong>不會建立</strong>，留在清單裡等下次處理。</div>`
          : '';
        const unassignedNote = unassignedRows
          ? `<div style="margin-top:6px; color:#777;">另有 ${unassignedRows} 列還沒指定起點角色，這次會略過。</div>`
          : '';

        // 已經有記錄、只是沒填角色的人是「補填」不是「新建」，講清楚才不會以為會多出記錄
        const refillNote = refillCount
          ? `<div style="margin-top:6px; color:#555;">其中 <strong>${refillCount}</strong> 人已經有起點記錄、` +
            `只是沒填角色，會直接<strong>補填原記錄</strong>，不會新建。</div>`
          : '';

        // 新建角色是這次動作裡最重的一項（會在 685 長出新記錄），講清楚會建幾筆、
        // 簽核者是誰、起點指到哪一筆
        const newRoleRecords = newRoles.reduce((n, r) => n + r.memberCodes.length, 0);
        const newRoleNote = newRoles.length
          ? `<div style="margin-top:10px; color:#1e40af; font-weight:600;">` +
            `其中 <strong>${newRoles.length}</strong> 個關卡在 685 還不存在，會一併建立` +
            `（共 <strong>${newRoleRecords}</strong> 筆角色記錄，一人一筆，簽核者就是這組同仁）。<br>` +
            `起點會指到這一關最先建立的那一筆，與既有角色的取法一致。</div>`
          : '';

        // 這次動作會同時改到 685 與 686 兩張表，確認視窗要講清楚改了什麼
        const nextNote = nextUpdates.length
          ? `<div style="margin-top:10px; color:#1a6ea8; font-weight:600;">其中 ${assignments.length} 個關卡在 685 還沒設下一關，` +
            `會在同一次動作裡一併補上（共 ${nextUpdates.length} 筆角色記錄）。</div>`
          : '';

        const ok = (await Swal.fire({
          icon: 'question',
          title: `設定 ${groupCount} 組／${peopleCount} 人的起點？`,
          html:
            `<div style="text-align:left;">` +
            `<div style="margin-bottom:8px;">以下每組各設定一筆起點，同一個人不會重複建立：</div>` +
            `<div style="max-height:220px; overflow-y:auto; border:1px solid #e5e7eb; border-radius:6px; padding:4px 10px; font-size:14px;">${listHtml}</div>` +
            newRoleNote + refillNote + nextNote + readyNote + unassignedNote +
            `</div>`,
          width: '620px',
          showCancelButton: true, confirmButtonText: '確定建立', cancelButtonText: '取消',
        })).isConfirmed;
        if (!ok) return;

        await runWriteAction({
          loadingTitle: '寫入中…',
          write: () => createEntriesWithNextStep(pairs, nextUpdates, newRoles,
            { roleNameSeparator: model.roleForm.roleNameSeparator }),
          buildSuccessOptions: ({ created, updated, rolesCreated, rolesUpdated }) => ({
            icon: 'success',
            title: `已設定 ${created + updated} 人的起點`,
            text: [
              rolesCreated ? `新建角色 ${rolesCreated} 筆` : '',
              updated ? `補填既有起點 ${updated} 筆` : '',
              created ? `新建起點 ${created} 筆` : '',
              rolesUpdated ? `補設 ${rolesUpdated} 筆角色的下一關` : '',
            ].filter(Boolean).join('、'),
            timer: 2800, showConfirmButton: false,
          }),
          rescan,
        });
      },
      onExport: (rows) => exportCsv(rows, `未設定起點_${new Date().toISOString().slice(0, 10)}.csv`),
    });

    // 讀不到 685 的下拉選項時，A 區的「就地新建角色」不會出現，說明原因免得以為壞了
    if (model.roleForm.error) {
      const note = document.createElement('div');
      note.style.cssText =
        'background:#fff3cd; border:1px solid #f0c36d; border-radius:6px; padding:10px 14px; margin-bottom:10px; font-size:13px;';
      note.innerHTML =
        '<strong>讀不到角色定義表（685）的欄位設定，「＋ 在 685 建立這個角色」暫時不會出現</strong>：' +
        `${esc(model.roleForm.error)}<br>` +
        '請確認執行者對 685 有存取權。這只影響就地新建角色，其餘功能不受影響。';
      tabA.prepend(note);
    }

    // ── B 分頁：不具簽核身分 ──
    const tabB = buildTab({
      key: 'B',
      users: model.noHolder,
      roleOptions: buildRoleOptions(model.roles, { userTypeOnly: true, valueBy: 'roleName' }),
      actionLabel: '加入為簽核者',
      onAction: async (codes, roleName, roleLabel) => {
        if (!codes.length || !roleName) return;

        const { tpl, count, nextConsistent, hasNext } = pickRoleTemplate(roleName, model.roles);
        if (!tpl) {
          await showWarning('無法加入', `找不到「${roleName}」的既有記錄，無法沿用設定。`);
          return;
        }

        const ok = (await Swal.fire({
          icon: 'question',
          title: `新增 ${codes.length} 筆角色記錄？`,
          html:
            `<div style="text-align:left;">` +
            `角色：<strong>${esc(roleLabel)}</strong><br>` +
            `一筆記錄只掛一個人，所以每人各建一筆新記錄，<strong>既有的 ${count} 筆不會被更動</strong>。<br>` +
            `下一關等設定沿用記錄 ${esc(tpl.recordId)}（${esc(tpl.roleId)}）。` +
            (nextConsistent ? '' :
              `<div style="margin-top:8px; color:#c0392b; font-weight:700;">` +
              `注意：現有同名記錄的「下一關」設定不一致，新記錄只會沿用其中一種，` +
              `建議先用「批次設定下一關」統一。</div>`) +
            (hasNext ? '' :
              `<div style="margin-top:8px; color:#c0392b; font-weight:700;">` +
              `注意：這一關在 685 沒有設下一關、也沒有勾終點，新記錄會沿用同樣的空白設定。` +
              `之後若有人以它為起點，送單會卡在這一關——請接著用「批次設定下一關」補上。</div>`) +
            `</div>`,
          width: '620px',
          showCancelButton: true, confirmButtonText: '確定新增', cancelButtonText: '取消',
        })).isConfirmed;
        if (!ok) return;

        await runWriteAction({
          loadingTitle: '寫入中…',
          write: () => createHolderRoles(codes, roleName, model.roles),
          buildSuccessOptions: (created) => ({
            icon: 'success',
            title: `已新增 ${created} 筆「${roleName}」`,
            timer: 2200, showConfirmButton: false,
          }),
          rescan,
        });
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

        await runWriteAction({
          loadingTitle: '停用中…',
          write: () => deactivateEntries(recordIds),
          buildSuccessOptions: () => ({
            icon: 'success', title: `已停用 ${recordIds.length} 筆起點設定`, timer: 1800, showConfirmButton: false,
          }),
          rescan,
        });
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

        await runWriteAction({
          loadingTitle: '停用中…',
          write: () => deactivateRoles(updates),
          buildSuccessOptions: () => ({
            icon: 'success', title: `已停用 ${updates.length} 筆角色記錄`, timer: 2000, showConfirmButton: false,
          }),
          rescan,
        });
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

        await runWriteAction({
          loadingTitle: '停用中…',
          write: () => deactivateRoles(targets.map((r) => ({
            id: r.recordId,
            record: { [RF.IS_ACTIVE]: { value: [] } },
          }))),
          buildSuccessOptions: () => ({
            icon: 'success', title: `已停用 ${targets.length} 筆角色`, timer: 1800, showConfirmButton: false,
          }),
          rescan,
        });
      },
      onExport: (rows) => exportCsv(
        rows,
        `角色沒有簽核者_${new Date().toISOString().slice(0, 10)}.csv`,
        { code: '角色代碼', name: '角色名稱', title: '鏈上游', group: '單位' },
      ),
    });

    // ── G 分頁：起點角色設定不完整 ──
    const tabG = buildBrokenEntryTab({
      rows: model.brokenEntries,
      roles: model.roles,
      nextOptions: buildNextStepOptions(model.roles),
      onAction: async ({ assignments, picked, peopleCount }) => {
        if (!assignments.length) return;

        const { updates, conflicts } = planNextStepUpdates(assignments);
        if (conflicts.length) {
          await showWarning(
            '同一個角色被指到不同的下一關',
            `${conflicts.map((c) => `${c.roleName}：${c.labels.join('／')}`).join('；')}。請先統一再送出。`,
          );
          return;
        }

        const listHtml = picked.map((p) =>
          `<div style="padding:4px 2px; border-bottom:1px solid #f0f0f0;">` +
          `${esc(p.roleName)} → <strong>${esc(p.nextLabel)}</strong>（影響 ${p.count} 人）</div>`,
        ).join('');

        const ok = (await Swal.fire({
          icon: 'question',
          title: `補設 ${picked.length} 個關卡的下一關？`,
          html:
            `<div style="text-align:left;">` +
            `<div style="margin-bottom:8px;">同名角色是同一關，補設會寫進該關卡的每一筆記錄，` +
            `共 <strong>${updates.length}</strong> 筆，影響 <strong>${peopleCount}</strong> 位以它為起點的同仁：</div>` +
            `<div style="max-height:220px; overflow-y:auto; border:1px solid #e5e7eb; border-radius:6px; padding:4px 10px; font-size:14px;">${listHtml}</div>` +
            `</div>`,
          width: '620px',
          showCancelButton: true, confirmButtonText: '確定補設', cancelButtonText: '取消',
        })).isConfirmed;
        if (!ok) return;

        await runWriteAction({
          loadingTitle: '寫入中…',
          write: () => updateRoleRecords(updates),
          buildSuccessOptions: (n) => ({
            icon: 'success',
            title: `已補設 ${n} 筆角色記錄的下一關`,
            timer: 2000, showConfirmButton: false,
          }),
          rescan,
        });
      },
      onExport: (rows) => exportCsv(
        rows,
        `起點角色設定不完整_${new Date().toISOString().slice(0, 10)}.csv`,
        { code: '角色代碼', name: '角色名稱', title: '問題', group: '單位' },
      ),
    });

    const tabGNote = document.createElement('div');
    tabGNote.style.cssText =
      'background:#fff3cd; border:1px solid #f0c36d; border-radius:6px; padding:10px 14px; margin-bottom:10px; font-size:13px;';
    tabGNote.innerHTML =
      '<strong>這些同仁在 686 已經設好起點，685 那一關卻還沒設完整</strong>，送單時會卡在建立簽核鏈。<br>' +
      '<span style="color:#92400e; font-weight:700;">沒有設下一關</span>：選好下一關後勾起來，' +
      '按下方按鈕批量補進 685；同名角色是同一關，補設會一起寫進該關卡的每一筆記錄。<br>' +
      '<span style="color:#991b1b; font-weight:700;">685 沒有這個角色</span>：整列紅底、勾不動。' +
      '新建角色要決定簽核者、單位與職稱，本工具不代勞——請用「批量建立角色」補建，' +
      '或到 686 把這些人的起點改指到現有的角色。<br>' +
      '帳號已停用的人不列在這裡，那是 C 分頁的範圍。';
    tabG.prepend(tabGNote);

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
      { key: 'A', label: `A. 未設定起點（${model.noEntry.length} 人）`, el: tabA, hint: '686 沒有記錄、或有記錄卻沒填起點角色的人，兩種都送不出單' },
      { key: 'B', label: `B. 不具簽核身分（${model.noHolder.length} 人）`, el: tabB, hint: '多數基層同仁本來就不簽核，此區用於確認主管沒被漏掉' },
      { key: 'C', label: `C. 已停用仍有起點（${model.staleEntries.length} 人）`, el: tabC, hint: '帳號已停用但起點記錄仍啟用中，建議停用避免誤導' },
      { key: 'D', label: `D. 已停用仍是簽核者（${model.staleHolders.length} 人）`, el: tabD, hint: '帳號已停用卻仍是簽核者，流程跑到該關會卡住；本區只會取消該角色的「啟用中」，不會動簽核者名單' },
      { key: 'E', label: `E. 姓名格式異常（${model.oddNames.length} 人）`, el: tabE, hint: '姓名未同時具備中文與英文，多為系統／測試／整合帳號或姓名未補齊；已自 A～D 排除，僅供人工確認' },
      { key: 'F', label: `F. 角色沒有簽核者（${model.emptyRoles.length} 筆）`, el: tabF, hint: '啟用中、指定個人、卻沒有指定任何簽核者的角色，流程跑到這關會卡死' },
      { key: 'G', label: `G. 起點角色設定不完整（${model.brokenEntries.length} 個關卡）`, el: tabG, hint: '686 已設起點、685 卻缺角色或缺下一關，這些人送單會失敗' },
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

  // 單元測試用的出口；瀏覽器端不依賴它，不影響任何行為
  window.ApprovalRouting.CoverageInternals = Object.freeze({
    groupNoEntryUsers, matchEntryRole, isNextRoleConsistent,
    hasNextStep, inspectNextStep, walkBackTo, planNextStepUpdates, buildBrokenEntries,
    planEntryWrites, guessTitleLevel, guessUnitName, deriveRoleNameSeparator,
    buildNewRoleRecords, CHAIN_END_VALUE, CREATE_ROLE_VALUE,
  });

  // 掛在共用工具列（core/09-tool-registry.js）的「inspect」群組，不再自己長一顆按鈕
  window.ApprovalRouting.ToolRegistry.register({
    id:    'coverage-check',
    group: 'inspect',
    label: '未設定名單',
    hint:  '沒起點、沒簽核身分、停用帳號殘留…七類問題',
    apps:  [APP_ID.ROLE_DEFINITION, APP_ID.EMPLOYEE_ENTRY],
    run:   runTool,
  });
})();
