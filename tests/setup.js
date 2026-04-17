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
  }),
  ROLE_FIELDS: Object.freeze({
    ROLE_ID:      'role_id',
    ROLE_NAME:    'role_name',
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
  CHAIN_FIELDS: Object.freeze({
    TABLE:            'approver_chain',
    STEP_NO:          'step_no',
    ROLE_ID:          'role_id',
    STEP_NAME:        'step_name',
    EXPECTED_SIGNERS: 'expected_signers',
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
const mockGetEntryRoleId     = vi.fn();
const mockGetCurrentUserEntry= vi.fn();
const mockGetGroupMembers    = vi.fn();

// ─── 掛到全域 ─────────────────────────────────────────────────────────────

global.window ??= global;

global.window.ApprovalRouting = {
  Config,
  ApiClient: {
    getRole:                  mockGetRole,
    getAllRoles:               mockGetAllRoles,
    clearRoleCache:           mockClearRoleCache,
    ensureFreshRoles:         mockEnsureFreshRoles,
    getEntryRoleId:           mockGetEntryRoleId,
    getCurrentUserEntryRoleId: mockGetCurrentUserEntry,
    getGroupMembers:          mockGetGroupMembers,
  },
  // Engine 由 03-chain-builder.js 載入後填入
};

// 暴露 mock 函式給測試檔案使用
global.__mocks__ = {
  kintoneApi:        kintoneApiMock,
  getRole:           mockGetRole,
  getAllRoles:        mockGetAllRoles,
  clearRoleCache:    mockClearRoleCache,
  ensureFreshRoles:  mockEnsureFreshRoles,
  getEntryRoleId:    mockGetEntryRoleId,
  getGroupMembers:   mockGetGroupMembers,
};
