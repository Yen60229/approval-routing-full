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
    MAX_DEPTH:      'max_depth',      // 數值：最大關卡數 K（產生器回寫，勿人工填）
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
    CURRENT_STEP:      'current_step',      // 數值：目前關卡指標
    TOTAL_STEPS:       'total_steps',       // 數值：鏈總長，供狀態轉移 filterCond 分流
  });

  /** 共用子表格欄位代碼（嵌入各申請 App） */
  const CHAIN_FIELDS = Object.freeze({
    TABLE:            'approver_chain',
    STEP_NO:          'step_no',
    ROLE_ID:          'role_id',
    STEP_NAME:        'step_name',
    EXPECTED_SIGNERS: 'expected_signers',
    SIGNING_MODE:     'signing_mode',
    SIGNED_BY:        'signed_by',
    SIGNED_AT:        'signed_at',
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
    CHAIN_FIELDS,
    ROLE_ID_PREFIX,
  });
})();
