/**
 * 全域設定 — App ID、欄位代碼、共用常數集中管理
 *
 * 【影響的欄位】
 *   - 所有 App 的欄位代碼定義於此，其餘 JS 一律從此引用
 *
 * 【依賴】
 *   - 無（最先載入）
 *
 * 【變更履歷】
 *   2026-04-14  Jimmy/Claude  初版建立
 *   2026-05-01  Jimmy/Claude  移除 TITLE_LEVEL_OPTIONS 硬編碼，改由各使用者
 *                              透過 kintone.app.getFormFields() 動態讀取選項
 *   2026-08-31  Jimmy/Claude  CHAIN_FIELDS 新增 SIGNING_MODE（docs/05 評估 #3）：
 *                              P8 流程管理需要逐關知道簽核模式，趁子表格尚未嵌入
 *                              任何申請 App 補上，此時改結構是零成本
 *   2026-08-31  Jimmy/Claude  P8 Phase B：新增 form_route_config（App 3）欄位代碼
 *                              ROUTE_FIELDS / ROUTE_STEP_FIELDS、段類型與簽核模式選項、
 *                              標準 adapter 規約欄位 ADAPTER_FIELDS（規格見 docs/02 App 3）
 *   2026-09-01  Jimmy/Claude  P8 Phase C/D：新增 STATUS_TEMPLATE / ACTION_TEMPLATE。
 *                              產生器建狀態、adapter 從狀態名反推第幾關，兩邊共用同一份，
 *                              各存一份會讓改狀態名靜默斷掉 adapter
 *   2026-09-01  Jimmy/Claude  狀態模型改版（Jimmy 實測確認 kintone 允許動作自迴圈）：
 *                              簽核中(1..K) 編號改為固定 6 狀態，K 的概念消失。
 *                              新增 ADAPTER_FIELDS.NEXT_STATE 與 CHAIN_FIELDS.STEP_STATE
 */
(() => {
  'use strict';

  const APP_ID = Object.freeze({
    ROLE_DEFINITION: 685,  // 簽核角色定義表
    EMPLOYEE_ENTRY: 686,   // 員工起點對照表
    // ⚠️ 待 Jimmy 依 docs/02 App 3 規格手動建立 form_route_config 後回填真實 App ID。
    //    在此之前 0 只是佔位符（沿用專案慣例）；尚無 adapter 掛載，不影響現有功能。
    FORM_ROUTE_CONFIG: 736,  // 表單路由設定表（P8）
  });

  /** 角色定義表欄位代碼 */
  const ROLE_FIELDS = Object.freeze({
    ROLE_ID:        'role_id',
    ROLE_NAME:      'role_name',
    UNIT_NAME:      'unit_name',
    TITLE_LEVEL:    'title_level',
    HOLDER_TYPE:    'holder_type',
    HOLDER_GROUP:   'holder_group',
    HOLDER_USER:    'holder_user',
    NEXT_ROLE_ID:   'next_role_id',
    IS_CHAIN_END:   'is_chain_end',
    SIGNING_MODE:   'signing_mode',
    IS_ACTIVE:      'is_active',
  });

  /** holder_type 選項值 */
  const HOLDER_TYPE_OPTIONS = Object.freeze({
    GROUP: '指定群組',
    USER:  '指定個人',
  });

  /** is_chain_end / is_active 核取方塊選項值 */
  const CHECKBOX = Object.freeze({
    CHAIN_END: '是終點',
    ACTIVE:    '啟用中',
  });

  /** signing_mode 選項值 */
  const SIGNING_MODE_OPTIONS = Object.freeze({
    ANY: '任一人簽',
    ALL: '全員會簽',
  });

  /** 員工起點對照表欄位代碼 */
  const ENTRY_FIELDS = Object.freeze({
    EMPLOYEE:       'employee',
    ENTRY_ROLE_ID:  'entry_role_id',
    IS_ACTIVE:      'is_active',
  });

  /** 表單路由設定表（App 3）主表欄位代碼 — 規格見 docs/02 App 3 */
  const ROUTE_FIELDS = Object.freeze({
    FORM_APP_ID:    'form_app_id',    // 數值，唯一鍵：申請 App 的 kintone App ID
    FORM_NAME:      'form_name',      // 文字：給維護者看的表單名稱
    IS_ACTIVE:      'is_active',      // 核取方塊「啟用中」；未啟用時 adapter 走 fallback 全鏈
    ROUTE_STEPS:    'route_steps',    // 子表格：有序的路由關卡
    // 數值：最大關卡數 K。**2026-09-01 起不再使用**——狀態改為自迴圈後 K 的概念消失，
    // 產生器不再計算、adapter 不再檢查。欄位留在 736 上不刪（刪欄位會掉舊資料），
    // 但任何新程式都不該讀它。
    MAX_DEPTH:      'max_depth',
    CANCEL_GROUPS:  'cancel_groups',  // 群組選擇（多選）：可作廢群組
    REJECT_TARGET:  'reject_target',  // 單選：駁回退回目標
    DEPLOYED_AT:    'deployed_at',    // 日期時間：上次部署時間（產生器回寫）
    DEPLOYED_HASH:  'deployed_hash',  // 文字：部署版本指紋（產生器回寫）
  });

  /** 表單路由設定表子表格 route_steps 欄位代碼 */
  const ROUTE_STEP_FIELDS = Object.freeze({
    STEP_NO:             'step_no',              // 數值：段的執行順序
    SEGMENT_TYPE:        'segment_type',         // 單選：段類型
    STOP_AT_TITLE_LEVEL: 'stop_at_title_level',  // 下拉（員工鏈段）：簽到此職稱為止（含）
    SKIP_TITLE_LEVELS:   'skip_title_levels',    // 複選 MULTI_SELECT（員工鏈段）：沿鏈經過但不簽的職稱，值為字串陣列
    ROLE_ID:             'role_id',              // 文字（指定角色段）：指定角色
    STEP_SIGNING_MODE:   'step_signing_mode',    // 單選：段的簽核模式（空＝沿用角色表）
  });

  /** route_steps.segment_type 選項值 */
  const SEGMENT_TYPE_OPTIONS = Object.freeze({
    EMPLOYEE_CHAIN: '員工鏈段',   // 沿申請人起點角色走 Linked List
    FIXED_ROLE:     '指定角色段', // 固定角色，直接指定 role_id
  });

  /** route_steps.step_signing_mode 選項值（「全員會簽」僅指定角色段可用，見 docs/06 §5.4） */
  const STEP_SIGNING_MODE_OPTIONS = Object.freeze({
    INHERIT: '（沿用角色表）',
    ANY:     '任一人簽',
    ALL:     '全員會簽',
  });

  /** 主表 reject_target 選項值 */
  const REJECT_TARGET_OPTIONS = Object.freeze({
    APPLICANT:  '退回申請人',
    PREV_STEP:  '退回上一關',
  });

  /** 申請 App 規約欄位（P8 標準 adapter，每個申請 App 都要埋）— 規格見 docs/02 */
  const ADAPTER_FIELDS = Object.freeze({
    APPROVER_CHAIN:    'approver_chain',    // 子表格（＝ CHAIN_FIELDS.TABLE）
    CURRENT_APPROVERS: 'current_approvers', // 使用者選擇（多選）：原生流程所有簽核狀態的執行者來源
    CURRENT_STEP:      'current_step',      // 數值：目前第幾關（0＝尚未進入簽核）
    TOTAL_STEPS:       'total_steps',       // 數值：鏈總長，顯示「第 3 / 5 關」用
    // 文字（單行）：**按下「同意」之後要去哪個狀態**，值必為 STATUS_TEMPLATE 的其中一個。
    // 狀態轉移的 filterCond 全部看這一欄——狀態不再編號，光看「簽核中」不知道下一關
    // 是主管、經辦、還是已經簽完，得由 adapter 先算好放在這裡讓 kintone 讀。
    NEXT_STATE:        'next_state',
    // 文字（單行）：**按下「駁回」之後要去哪個狀態**。同樣是給 filterCond 讀的。
    // reject_target =「退回申請人」時恆為「駁回」；=「退回上一關」時是上一關的 step_state
    // （已在第 1 關則仍為「駁回」——上一關就是申請人本人）。
    REJECT_STATE:      'reject_state',
  });

  /**
   * 流程管理的狀態命名模板（docs/06 §5.1，全公司統一）
   *
   * ⚠️ **產生器（tools/10）與 adapter（adapters/00）必須共用這一份。**
   * 產生器據此建狀態、adapter 據此決定下一個狀態；各存一份的話，改個狀態名
   * 會讓 adapter 靜默算出不存在的狀態——單子照跑，但流程走不動。
   *
   * 【為什麼是固定 6 個狀態，不再有「簽核中(n)」編號】
   * kintone 允許動作的「執行前」與「執行後」是**同一個狀態**（2026-09-01 Jimmy 實測確認），
   * 所以一條 N 關的鏈可以在同一個狀態上自迴圈 N 次，每次由 adapter 換執行者。
   * 於是「最大鏈深 K」這個概念整個消失：
   *   - 不必算 K、不必 max_depth、送出時不必擋「鏈比狀態多」
   *   - 組織多一層主管，流程設定一行都不用改
   *   - 每個申請 App 的 status.json **逐字元相同**，產生器退化成「貼同一份」
   *
   * 狀態名絕不綁職稱（不寫「課長審核中」），否則又回到舊系統把組織寫進設定的老路。
   * 「簽核中」對應員工鏈段的關卡、「經辦人確認中」對應指定角色段的關卡——
   * 使用者看得出「卡在主管」還是「卡在經辦」，而這兩者都不綁特定的人或單位。
   */
  const STATUS_TEMPLATE = Object.freeze({
    DRAFT:     '草稿',
    APPROVING: '簽核中',        // 員工鏈段的關卡（任一人簽）
    HANDLER:   '經辦人確認中',  // 指定角色段的關卡（任一人簽）
    COSIGNING: '會簽中',        // 需要全員會簽的關卡，不分段類型
    REJECTED:  '駁回',
    DECIDED:   '核決',          // 終態：全部簽完
    CANCELLED: '作廢',          // 終態
  });

  /**
   * 會停留簽核者的三個狀態（自迴圈就發生在這三個之間與各自身上）
   *
   * 為什麼「會簽中」要獨立成一個狀態：kintone 的執行者類型（任一人 ANY／全員 ALL）
   * 是**每個狀態靜態設定**的，不能依記錄切換。「簽核中」與「經辦人確認中」被所有
   * 任一人簽的關卡共用，型別只能是 ANY；需要全員會簽的關卡因此必須停在自己的狀態上。
   * 副作用是好的：舊的編號模型只有「位置固定」的關卡能全員會簽，現在放在鏈的哪裡都行。
   */
  const APPROVING_STATES = Object.freeze([
    STATUS_TEMPLATE.APPROVING, STATUS_TEMPLATE.HANDLER, STATUS_TEMPLATE.COSIGNING,
  ]);

  /** 終態：沒有任何向外的動作 */
  const TERMINAL_STATES = Object.freeze([STATUS_TEMPLATE.DECIDED, STATUS_TEMPLATE.CANCELLED]);

  /**
   * 流程管理的動作名稱（同上，兩邊共用）
   *
   * 簽核者只會看到兩顆按鈕：**同意**與**駁回**。
   * 送出／再申請是申請人按的、作廢是管理群組按的，動作對象不同，不算在那兩顆裡。
   */
  const ACTION_TEMPLATE = Object.freeze({
    SUBMIT:  '送出',
    APPROVE: '同意',
    REJECT:  '駁回',
    REAPPLY: '再申請',
    CANCEL:  '作廢',
  });

  /** 共用子表格欄位代碼（嵌入各申請 App） */
  const CHAIN_FIELDS = Object.freeze({
    TABLE:            'approver_chain',
    STEP_NO:          'step_no',
    ROLE_ID:          'role_id',
    STEP_NAME:        'step_name',
    EXPECTED_SIGNERS: 'expected_signers',
    SIGNING_MODE:     'signing_mode',
    // 文字（單行）：這一關要停在哪個狀態（簽核中／經辦人確認中）。
    // 存快照而非跑到時再回頭查路由表：路由改版後，在途單仍照送出當下的樣子跑完。
    STEP_STATE:       'step_state',
    SIGNED_BY:        'signed_by',
    SIGNED_AT:        'signed_at',
  });

  /**
   * `approver_chain` 各欄的 kintone 欄位型別
   *
   * ⚠️ 寫入 `event.record` 的欄位物件必須是 `{ type, value }`，只給 value 會被
   *    kintone 判為型別錯誤（逐列回報 `approver_chain.value[n] 錯誤`）。
   *    子表格是整批新建列，沒有原本的欄位物件可沿用，型別只能由我們自己帶上。
   *
   * 這份型別必須與各申請 App 實際建的欄位一致（規格見 docs/02）。
   */
  const CHAIN_FIELD_TYPES = Object.freeze({
    [CHAIN_FIELDS.STEP_NO]:          'NUMBER',
    [CHAIN_FIELDS.ROLE_ID]:          'SINGLE_LINE_TEXT',
    [CHAIN_FIELDS.STEP_NAME]:        'SINGLE_LINE_TEXT',
    [CHAIN_FIELDS.EXPECTED_SIGNERS]: 'USER_SELECT',
    [CHAIN_FIELDS.SIGNING_MODE]:     'SINGLE_LINE_TEXT',
    [CHAIN_FIELDS.STEP_STATE]:       'SINGLE_LINE_TEXT',
    [CHAIN_FIELDS.SIGNED_BY]:        'USER_SELECT',
    [CHAIN_FIELDS.SIGNED_AT]:        'DATETIME',
  });

  /** role_id 自動產生前綴 */
  const ROLE_ID_PREFIX = 'ROLE_';

  // 掛到全域供其他檔案使用
  window.ApprovalRouting = window.ApprovalRouting || {};
  window.ApprovalRouting.Config = Object.freeze({
    APP_ID,
    ROLE_FIELDS,
    HOLDER_TYPE_OPTIONS,
    CHECKBOX,
    SIGNING_MODE_OPTIONS,
    ENTRY_FIELDS,
    ROUTE_FIELDS,
    ROUTE_STEP_FIELDS,
    SEGMENT_TYPE_OPTIONS,
    STEP_SIGNING_MODE_OPTIONS,
    REJECT_TARGET_OPTIONS,
    ADAPTER_FIELDS,
    STATUS_TEMPLATE,
    APPROVING_STATES,
    TERMINAL_STATES,
    ACTION_TEMPLATE,
    CHAIN_FIELDS,
    CHAIN_FIELD_TYPES,
    ROLE_ID_PREFIX,
  });
})();
