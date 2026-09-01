/**
 * Vitest 全域測試環境設定
 *
 * 執行時機：每個測試檔案開始前（setupFiles）
 * 職責：模擬 kintone 平台全域物件 + 建立 window.ApprovalRouting 骨架
 *
 * 重要：chain-builder.js 載入時會解構 ApiClient 的函式，
 *       所以 mock 函式物件必須在 IIFE 執行前就存在。
 *       各測試使用 mockResolvedValue / mockImplementation 控制行為，
 *       不要替換整個 ApiClient 物件（會讓 IIFE 內部捕捉到的參考失效）。
 */
import { vi } from 'vitest';

// ─── kintone 平台 mock ─────────────────────────────────────────────────────

const kintoneApiMock = vi.fn();
kintoneApiMock.url = (path) => `https://mock.cybozu.com${path}`;

global.kintone = {
  api:          kintoneApiMock,
  getLoginUser: vi.fn(() => ({ code: 'test.user', name: '測試使用者' })),
  events:       { on: vi.fn() },
  app: {
    record: {
      get:           vi.fn(),
      set:           vi.fn(),
      setFieldShown: vi.fn(),
    },
  },
};

// ─── SweetAlert2 mock ──────────────────────────────────────────────────────

global.Swal = {
  fire:           vi.fn().mockResolvedValue({ isConfirmed: true }),
  showLoading:    vi.fn(),
  close:          vi.fn(),
  showValidationMessage: vi.fn(),
};

// ─── ApprovalRouting.Config ────────────────────────────────────────────────

const Config = Object.freeze({
  APP_ID: Object.freeze({
    ROLE_DEFINITION: 685,
    EMPLOYEE_ENTRY:  686,
    FORM_ROUTE_CONFIG: 700,   // 測試用假 App ID（正式環境為 736，見 core/01-config.js；mock 不打真 API，值任意）
  }),
  ROLE_FIELDS: Object.freeze({
    ROLE_ID:      'role_id',
    ROLE_NAME:    'role_name',
    UNIT_NAME:    'unit_name',
    TITLE_LEVEL:  'title_level',
    HOLDER_TYPE:  'holder_type',
    HOLDER_GROUP: 'holder_group',
    HOLDER_USER:  'holder_user',
    NEXT_ROLE_ID: 'next_role_id',
    IS_CHAIN_END: 'is_chain_end',
    SIGNING_MODE: 'signing_mode',
    IS_ACTIVE:    'is_active',
  }),
  HOLDER_TYPE_OPTIONS: Object.freeze({
    GROUP: '指定群組',
    USER:  '指定個人',
  }),
  CHECKBOX: Object.freeze({
    CHAIN_END: '是終點',
    ACTIVE:    '啟用中',
  }),
  SIGNING_MODE_OPTIONS: Object.freeze({
    ANY: '任一人簽',
    ALL: '全員會簽',
  }),
  ENTRY_FIELDS: Object.freeze({
    EMPLOYEE:      'employee',
    ENTRY_ROLE_ID: 'entry_role_id',
    IS_ACTIVE:     'is_active',
  }),
  ROUTE_FIELDS: Object.freeze({
    FORM_APP_ID:   'form_app_id',
    FORM_NAME:     'form_name',
    IS_ACTIVE:     'is_active',
    ROUTE_STEPS:   'route_steps',
    MAX_DEPTH:     'max_depth',
    CANCEL_GROUPS: 'cancel_groups',
    REJECT_TARGET: 'reject_target',
    DEPLOYED_AT:   'deployed_at',
    DEPLOYED_HASH: 'deployed_hash',
  }),
  ROUTE_STEP_FIELDS: Object.freeze({
    STEP_NO:             'step_no',
    SEGMENT_TYPE:        'segment_type',
    STOP_AT_TITLE_LEVEL: 'stop_at_title_level',
    SKIP_TITLE_LEVELS:   'skip_title_levels',
    ROLE_ID:             'role_id',
    STEP_SIGNING_MODE:   'step_signing_mode',
  }),
  SEGMENT_TYPE_OPTIONS: Object.freeze({
    EMPLOYEE_CHAIN: '員工鏈段',
    FIXED_ROLE:     '指定角色段',
  }),
  STEP_SIGNING_MODE_OPTIONS: Object.freeze({
    INHERIT: '（沿用角色表）',
    ANY:     '任一人簽',
    ALL:     '全員會簽',
  }),
  REJECT_TARGET_OPTIONS: Object.freeze({
    APPLICANT: '退回申請人',
    PREV_STEP: '退回上一關',
  }),
  STATUS_TEMPLATE: Object.freeze({
    DRAFT:     '草稿',
    APPROVING: '簽核中',
    HANDLER:   '經辦人確認中',
    COSIGNING: '會簽中',
    REJECTED:  '駁回',
    DECIDED:   '核決',
    CANCELLED: '作廢',
  }),
  APPROVING_STATES: Object.freeze(['簽核中', '經辦人確認中', '會簽中']),
  TERMINAL_STATES: Object.freeze(['核決', '作廢']),
  ACTION_TEMPLATE: Object.freeze({
    SUBMIT:  '送出',
    APPROVE: '同意',
    REJECT:  '駁回',
    REAPPLY: '再申請',
    CANCEL:  '作廢',
  }),
  ADAPTER_FIELDS: Object.freeze({
    APPROVER_CHAIN:    'approver_chain',
    CURRENT_APPROVERS: 'current_approvers',
    CURRENT_STEP:      'current_step',
    TOTAL_STEPS:       'total_steps',
    NEXT_STATE:        'next_state',
    REJECT_STATE:      'reject_state',
  }),
  CHAIN_FIELDS: Object.freeze({
    TABLE:            'approver_chain',
    STEP_NO:          'step_no',
    ROLE_ID:          'role_id',
    STEP_NAME:        'step_name',
    EXPECTED_SIGNERS: 'expected_signers',
    SIGNING_MODE:     'signing_mode',
    STEP_STATE:       'step_state',
    SIGNED_BY:        'signed_by',
    SIGNED_AT:        'signed_at',
  }),
  ROLE_ID_PREFIX: 'ROLE_',
});

// ─── ApprovalRouting.ApiClient mock 函式（固定物件，各測試用 mock* 控制） ─

const mockGetRole            = vi.fn();
const mockGetAllRoles        = vi.fn();
const mockClearRoleCache     = vi.fn();
const mockEnsureFreshRoles   = vi.fn().mockResolvedValue(undefined);
const mockEnsureFresh        = vi.fn().mockResolvedValue(undefined);
const mockGetEntryRoleId     = vi.fn();
const mockGetCurrentUserEntry= vi.fn();
const mockGetGroupMembers    = vi.fn();
const mockGetRouteConfig     = vi.fn();
const mockClearRouteConfigCache = vi.fn();

// ─── 掛到全域 ─────────────────────────────────────────────────────────────

global.window ??= global;

global.window.ApprovalRouting = {
  Config,
  ApiClient: {
    getRole:                  mockGetRole,
    getAllRoles:               mockGetAllRoles,
    clearRoleCache:           mockClearRoleCache,
    ensureFresh:              mockEnsureFresh,
    ensureFreshRoles:         mockEnsureFreshRoles,
    getEntryRoleId:           mockGetEntryRoleId,
    getCurrentUserEntryRoleId: mockGetCurrentUserEntry,
    getGroupMembers:          mockGetGroupMembers,
    getRouteConfig:           mockGetRouteConfig,
    clearRouteConfigCache:    mockClearRouteConfigCache,
  },
  // Engine 由 03-chain-builder.js 載入後填入
};

// ─── ApprovalRouting.Utils mock（tools/ 下的工具會解構它） ────────────────

const mockShowWarning = vi.fn().mockResolvedValue(undefined);
const mockShowSuccess = vi.fn().mockResolvedValue(undefined);
const mockShowConfirm = vi.fn().mockResolvedValue(true);

global.window.ApprovalRouting.Utils = Object.freeze({
  // 測試不驗證錯誤包裝行為，直接原樣回傳處理函式
  safeHandler:       (fn) => fn,
  showSuccess:       mockShowSuccess,
  showWarning:       mockShowWarning,
  showConfirm:       mockShowConfirm,
  kintoneApi:        kintoneApiMock,
  pushSubmitError:   vi.fn(),
  flushSubmitErrors: vi.fn(),
});

// 暴露 mock 函式給測試檔案使用
global.__mocks__ = {
  kintoneApi:        kintoneApiMock,
  getRole:           mockGetRole,
  getAllRoles:        mockGetAllRoles,
  clearRoleCache:    mockClearRoleCache,
  ensureFresh:       mockEnsureFresh,
  ensureFreshRoles:  mockEnsureFreshRoles,
  getEntryRoleId:    mockGetEntryRoleId,
  getGroupMembers:   mockGetGroupMembers,
  getRouteConfig:    mockGetRouteConfig,
  clearRouteConfigCache: mockClearRouteConfigCache,
  showWarning:       mockShowWarning,
};
