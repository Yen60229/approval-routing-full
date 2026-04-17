/**
 * core/02-api-client.js 單元測試
 *
 * 重點驗證：
 *   1. 快取行為（第一次 fetch、快取命中、TTL 過期）
 *   2. Promise singleton（並發呼叫只觸發一次 API）
 *   3. clearRoleCache / ensureFreshRoles 語意正確
 *   4. getEntryRoleId 單筆快取
 *
 * 注意：api-client.js 載入後狀態（快取）存在 IIFE 閉包內，
 *       只能透過對外 API（clearRoleCache）重設，無法直接操作內部變數。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 載入 IIFE（執行後掛上 window.ApprovalRouting.ApiClient）
await import('../core/02-api-client.js');

const client = () => window.ApprovalRouting.ApiClient;
const { kintoneApi } = global.__mocks__;

// 假角色清單（loadAllRoles 回傳格式）
const MOCK_ROLE_RECORDS = [
  { role_id: { value: 'ROLE_001' }, role_name: { value: '研發課課長' }, is_active: { value: ['啟用中'] } },
  { role_id: { value: 'ROLE_002' }, role_name: { value: '研發部部長' }, is_active: { value: ['啟用中'] } },
];

/** 讓 kintone.api 回傳 records（模擬 /k/v1/records GET） */
const mockRecordsApi = (records = MOCK_ROLE_RECORDS) => {
  kintoneApi.mockResolvedValue({ records });
};

beforeEach(() => {
  vi.resetAllMocks();
  client().clearRoleCache(); // 每次測試前清快取，確保乾淨狀態
  mockRecordsApi();
});

afterEach(() => {
  vi.useRealTimers(); // 還原真實時鐘
});

// ── 角色快取 ────────────────────────────────────────────────────────────────

describe('角色快取（loadAllRoles）', () => {

  it('✅ 第一次 getRole：應呼叫 kintone.api 一次', async () => {
    await client().getRole('ROLE_001');
    expect(kintoneApi).toHaveBeenCalledTimes(1);
  });

  it('✅ 快取命中：連續兩次 getRole 只呼叫一次 API', async () => {
    await client().getRole('ROLE_001');
    await client().getRole('ROLE_002');
    expect(kintoneApi).toHaveBeenCalledTimes(1);
  });

  it('✅ getRole 回傳正確角色資料', async () => {
    const role = await client().getRole('ROLE_001');
    expect(role.role_name.value).toBe('研發課課長');
  });

  it('✅ getRole 找不到角色時回傳 null', async () => {
    const role = await client().getRole('ROLE_GHOST');
    expect(role).toBeNull();
  });

  it('✅ clearRoleCache 後應重新呼叫 API', async () => {
    await client().getRole('ROLE_001');     // 第 1 次：觸發 fetch
    client().clearRoleCache();
    await client().getRole('ROLE_001');     // 第 2 次：快取已清，再次 fetch
    expect(kintoneApi).toHaveBeenCalledTimes(2);
  });

  it('✅ TTL 5 分鐘內不重新 fetch', async () => {
    vi.useFakeTimers();

    await client().getRole('ROLE_001');
    vi.advanceTimersByTime(4 * 60 * 1000); // 快進 4 分鐘（TTL 內）
    await client().getRole('ROLE_001');

    expect(kintoneApi).toHaveBeenCalledTimes(1); // 仍使用快取
  });

  it('✅ TTL 超過 5 分鐘後重新 fetch', async () => {
    vi.useFakeTimers();

    await client().getRole('ROLE_001');
    vi.advanceTimersByTime(6 * 60 * 1000); // 快進 6 分鐘（超過 TTL）
    await client().getRole('ROLE_001');

    expect(kintoneApi).toHaveBeenCalledTimes(2); // 重新 fetch
  });

  it('✅ 並發呼叫 Promise singleton：只觸發一次 API', async () => {
    // 三個並發呼叫，應只有一個真正打 API
    await Promise.all([
      client().getRole('ROLE_001'),
      client().getRole('ROLE_001'),
      client().getRole('ROLE_001'),
    ]);
    expect(kintoneApi).toHaveBeenCalledTimes(1);
  });

  it('✅ API 失敗後下次呼叫可重試（promise 清除）', async () => {
    kintoneApi
      .mockRejectedValueOnce(new Error('網路錯誤'))  // 第 1 次失敗
      .mockResolvedValue({ records: MOCK_ROLE_RECORDS }); // 第 2 次成功

    // 第 1 次失敗
    await expect(client().getRole('ROLE_001')).rejects.toThrow('網路錯誤');

    // 第 2 次應能重試（loadPromise 已被清除）
    const role = await client().getRole('ROLE_001');
    expect(role).not.toBeNull();
    expect(kintoneApi).toHaveBeenCalledTimes(2);
  });

});

// ── ensureFreshRoles ────────────────────────────────────────────────────────

describe('ensureFreshRoles()', () => {

  it('✅ 強制清快取並重新 fetch', async () => {
    await client().getRole('ROLE_001');    // 載入快取
    await client().ensureFreshRoles();     // 強制重刷
    expect(kintoneApi).toHaveBeenCalledTimes(2);
  });

});

// ── 員工起點快取 ────────────────────────────────────────────────────────────

describe('getEntryRoleId() 單筆快取', () => {

  beforeEach(() => {
    client().clearEntryCache(); // 清除員工快取，避免跨測試污染
    // 員工起點查詢回傳
    kintoneApi.mockResolvedValue({
      records: [{ entry_role_id: { value: 'ROLE_001' } }],
    });
  });

  it('✅ 第一次查詢：呼叫 kintone.api', async () => {
    const roleId = await client().getEntryRoleId('yamada.taro');
    expect(roleId).toBe('ROLE_001');
    expect(kintoneApi).toHaveBeenCalledTimes(1);
  });

  it('✅ 相同員工第二次查詢：從快取回傳，不呼叫 API', async () => {
    await client().getEntryRoleId('yamada.taro');
    await client().getEntryRoleId('yamada.taro');
    expect(kintoneApi).toHaveBeenCalledTimes(1);
  });

  it('✅ 找不到員工時回傳 null', async () => {
    kintoneApi.mockResolvedValue({ records: [] });
    const roleId = await client().getEntryRoleId('unknown.user');
    expect(roleId).toBeNull();
  });

});
