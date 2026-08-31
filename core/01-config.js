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
 */
(() => {
  'use strict';

  const APP_ID = Object.freeze({
    ROLE_DEFINITION: 685,  // 簽核角色定義表
    EMPLOYEE_ENTRY: 686,   // 員工起點對照表
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
    CHAIN_FIELDS,
    ROLE_ID_PREFIX,
  });
})();
