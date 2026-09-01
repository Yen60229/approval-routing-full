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

// ── 表單路由設定快取（loadAllRouteConfigs / getRouteConfig）─────────────────

describe('getRouteConfig() 全量快取', () => {

  const MOCK_ROUTE_RECORDS = [
    { form_app_id: { value: '1001' }, form_name: { value: '採購申請單' }, is_active: { value: ['啟用中'] }, route_steps: { value: [] } },
    { form_app_id: { value: '1002' }, form_name: { value: '請假單' },   is_active: { value: ['啟用中'] }, route_steps: { value: [] } },
  ];

  beforeEach(() => {
    client().clearRouteConfigCache();
    kintoneApi.mockResolvedValue({ records: MOCK_ROUTE_RECORDS });
  });

  it('✅ 第一次查詢：呼叫 kintone.api 一次', async () => {
    await client().getRouteConfig(1001);
    expect(kintoneApi).toHaveBeenCalledTimes(1);
  });

  it('✅ 快取命中：查兩個不同表單只呼叫一次 API', async () => {
    await client().getRouteConfig(1001);
    await client().getRouteConfig(1002);
    expect(kintoneApi).toHaveBeenCalledTimes(1);
  });

  it('✅ 依 App ID 回傳正確記錄（數值與字串皆可）', async () => {
    expect((await client().getRouteConfig(1001)).form_name.value).toBe('採購申請單');
    expect((await client().getRouteConfig('1002')).form_name.value).toBe('請假單');
  });

  it('✅ 查無該表單時回傳 null', async () => {
    expect(await client().getRouteConfig(9999)).toBeNull();
  });

  it('✅ clearRouteConfigCache 後重新 fetch', async () => {
    await client().getRouteConfig(1001);
    client().clearRouteConfigCache();
    await client().getRouteConfig(1001);
    expect(kintoneApi).toHaveBeenCalledTimes(2);
  });

  it('✅ TTL 5 分鐘內不重新 fetch、超過後重新 fetch', async () => {
    vi.useFakeTimers();
    await client().getRouteConfig(1001);
    vi.advanceTimersByTime(4 * 60 * 1000);
    await client().getRouteConfig(1001);
    expect(kintoneApi).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2 * 60 * 1000); // 累計 6 分鐘
    await client().getRouteConfig(1001);
    expect(kintoneApi).toHaveBeenCalledTimes(2);
  });

  it('✅ 並發呼叫 Promise singleton：只觸發一次 API', async () => {
    await Promise.all([
      client().getRouteConfig(1001),
      client().getRouteConfig(1002),
      client().getRouteConfig(1001),
    ]);
    expect(kintoneApi).toHaveBeenCalledTimes(1);
  });

  it('✅ 只載入啟用中的記錄（query 帶 is_active 條件）', async () => {
    await client().getRouteConfig(1001);
    const [, , body] = kintoneApi.mock.calls[0];
    expect(body.query).toContain('is_active in ("啟用中")');
  });

  it('✅ ensureFresh() 會一併清路由快取', async () => {
    await client().getRouteConfig(1001);          // 載入路由快取
    kintoneApi.mockResolvedValue({ records: [] }); // ensureFresh 內的 loadAllRoles
    await client().ensureFresh();
    kintoneApi.mockResolvedValue({ records: MOCK_ROUTE_RECORDS });
    await client().getRouteConfig(1001);          // 快取已清 → 再次 fetch
    // 1: 首次 getRouteConfig，2: ensureFresh 的 loadAllRoles，3: 重新 getRouteConfig
    expect(kintoneApi).toHaveBeenCalledTimes(3);
  });

});

// ── getDistinctEntryRoleIds（產生器算 K 值的資料來源）─────────────────────────

describe('getDistinctEntryRoleIds', () => {

  const entryRec = (roleId) => ({ entry_role_id: { value: roleId } });

  it('✅ 去重：500 名員工只回傳 distinct 的起點角色', async () => {
    kintoneApi.mockResolvedValue({
      records: [entryRec('ROLE_A'), entryRec('ROLE_B'), entryRec('ROLE_A'), entryRec('ROLE_B')],
    });

    expect(await client().getDistinctEntryRoleIds()).toEqual(['ROLE_A', 'ROLE_B']);
  });

  it('✅ 略過空白起點（有記錄但沒填角色的人）', async () => {
    kintoneApi.mockResolvedValue({
      records: [entryRec('ROLE_A'), entryRec(''), entryRec(undefined), entryRec('ROLE_B')],
    });

    expect(await client().getDistinctEntryRoleIds()).toEqual(['ROLE_A', 'ROLE_B']);
  });

  it('✅ 只取啟用中，且只請求 entry_role_id 一個欄位', async () => {
    kintoneApi.mockResolvedValue({ records: [entryRec('ROLE_A')] });
    await client().getDistinctEntryRoleIds();

    const [, , body] = kintoneApi.mock.calls[0];
    expect(body.app).toBe(686);
    expect(body.query).toContain('is_active in ("啟用中")');
    expect(body.fields).toEqual(['entry_role_id']);
  });

  it('✅ 超過 500 筆會分頁抓完', async () => {
    const full = Array.from({ length: 500 }, (_, i) => entryRec(`ROLE_${i}`));
    kintoneApi
      .mockResolvedValueOnce({ records: full })
      .mockResolvedValueOnce({ records: [entryRec('ROLE_LAST')] });

    const ids = await client().getDistinctEntryRoleIds();

    expect(kintoneApi).toHaveBeenCalledTimes(2);
    expect(ids).toHaveLength(501);
    expect(ids.at(-1)).toBe('ROLE_LAST');
  });

  it('✅ 沒有快取：每次都重新查（部署前要最新資料）', async () => {
    kintoneApi.mockResolvedValue({ records: [entryRec('ROLE_A')] });
    await client().getDistinctEntryRoleIds();
    await client().getDistinctEntryRoleIds();
    expect(kintoneApi).toHaveBeenCalledTimes(2);
  });

});
