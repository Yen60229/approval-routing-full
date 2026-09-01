/**
 * core/03-chain-builder.js 單元測試
 *
 * 測試策略：
 *   - setup.js 已建立 ApiClient mock 函式物件
 *   - 此檔 import chain-builder IIFE → IIFE 執行、解構 mock 函式、掛上 Engine
 *   - 各測試透過 mockResolvedValue / mockImplementation 控制 ApiClient 行為
 *   - beforeEach 用 vi.resetAllMocks() 清除上一筆測試的實作與呼叫記錄
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ROLES_3_STEPS,
  ROLES_CIRCULAR,
  ROLES_BROKEN,
  ROLES_EMPTY_HOLDER,
  ROLES_MIXED_SIGNING,
} from './helpers/mock-roles.js';

// 載入 IIFE（執行後掛上 window.ApprovalRouting.Engine）
await import('../core/03-chain-builder.js');

const {
  getRole,
  getEntryRoleId,
  getGroupMembers,
  ensureFresh,
} = global.__mocks__;

const Engine = () => window.ApprovalRouting.Engine;

// ─── 共用 mock 設定 ─────────────────────────────────────────────────────────

/** 設定 getRole 依照角色字典回傳 */
const setupRoleMap = (roleMap) => {
  getRole.mockImplementation(async (id) => roleMap[id] ?? null);
};

/** 設定群組成員 */
const setupGroupMembers = (membersMap) => {
  getGroupMembers.mockImplementation(async (groupCode) =>
    membersMap[groupCode] ?? []
  );
};

// ─── 測試 ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
  ensureFresh.mockResolvedValue(undefined);
});

// ── buildChain ──────────────────────────────────────────────────────────────

describe('buildChain()', () => {

  it('✅ 正常 3 關鏈：回傳 ok=true + 正確 chain 長度與內容', async () => {
    getEntryRoleId.mockResolvedValue('ROLE_001');
    setupRoleMap(ROLES_3_STEPS);
    setupGroupMembers({
      'g_rd_section': ['chen.wei'],
      'g_ceo':        ['wang.ceo'],
    });

    const { ok, chain, error } = await Engine().buildChain('yamada.taro');

    expect(ok).toBe(true);
    expect(error).toBeNull();
    expect(chain).toHaveLength(3);

    // 第 1 關
    expect(chain[0].value.step_no.value).toBe('1');
    expect(chain[0].value.step_name.value).toBe('研發課課長');
    expect(chain[0].value.expected_signers.value).toEqual([{ code: 'chen.wei' }]);

    // 第 2 關（個人 holder）
    expect(chain[1].value.step_name.value).toBe('研發部部長');
    expect(chain[1].value.expected_signers.value).toEqual([{ code: 'lin.mingzhi' }]);

    // 第 3 關（終點）
    expect(chain[2].value.step_name.value).toBe('總經理');
    expect(chain[2].value.expected_signers.value).toEqual([{ code: 'wang.ceo' }]);

    // 每個欄位都要帶 type，只給 value 會被 kintone 判型別錯誤
    expect(chain[0].value.step_no).toEqual({ type: 'NUMBER', value: '1' });
    expect(chain[0].value.expected_signers.type).toBe('USER_SELECT');

    // 子表格格式確認：signed_by / signed_at 為空
    expect(chain[0].value.signed_by.value).toEqual([]);
    expect(chain[0].value.signed_at.value).toBeNull(); // 空的 DATETIME 是 null，不是空字串
  });

  it('✅ 員工未設定起點角色：回傳 ok=false + 明確錯誤訊息', async () => {
    getEntryRoleId.mockResolvedValue(null);

    const { ok, chain, error } = await Engine().buildChain('unknown.user');

    expect(ok).toBe(false);
    expect(chain).toHaveLength(0);
    expect(error).toContain('unknown.user');
    expect(error).toContain('未設定起點角色');
  });

  it('✅ 斷鏈（next_role_id 指向不存在角色）：回傳 ok=false', async () => {
    getEntryRoleId.mockResolvedValue('ROLE_X');
    setupRoleMap(ROLES_BROKEN);  // ROLE_X → ROLE_GHOST（不存在）
    setupGroupMembers({});

    const { ok, error } = await Engine().buildChain('user.x');

    expect(ok).toBe(false);
    expect(error).toContain('ROLE_GHOST');
    expect(error).toContain('不存在或未啟用');
  });

  it('✅ 循環鏈偵測：A→B→A 時回傳 ok=false', async () => {
    getEntryRoleId.mockResolvedValue('ROLE_A');
    setupRoleMap(ROLES_CIRCULAR);
    setupGroupMembers({});
    getGroupMembers.mockResolvedValue([]);

    const { ok, error } = await Engine().buildChain('user.loop');

    expect(ok).toBe(false);
    expect(error).toContain('循環');
    expect(error).toContain('ROLE_A');
  });

  it('✅ forceFresh=true：應呼叫 ensureFresh()（角色＋起點兩個快取都要清）', async () => {
    getEntryRoleId.mockResolvedValue('ROLE_001');
    setupRoleMap(ROLES_3_STEPS);
    setupGroupMembers({ 'g_rd_section': ['chen.wei'], 'g_ceo': ['wang.ceo'] });

    await Engine().buildChain('yamada.taro', { forceFresh: true });

    expect(ensureFresh).toHaveBeenCalledTimes(1);
  });

  it('✅ forceFresh 預設 false：不應呼叫 ensureFresh()', async () => {
    getEntryRoleId.mockResolvedValue('ROLE_001');
    setupRoleMap(ROLES_3_STEPS);
    setupGroupMembers({ 'g_rd_section': ['chen.wei'], 'g_ceo': ['wang.ceo'] });

    await Engine().buildChain('yamada.taro');

    expect(ensureFresh).not.toHaveBeenCalled();
  });

  it('✅ holder 解析採 Promise.all 平行：getGroupMembers 應「同時」被呼叫', async () => {
    getEntryRoleId.mockResolvedValue('ROLE_001');
    setupRoleMap(ROLES_3_STEPS);

    const callOrder = [];
    getGroupMembers.mockImplementation(async (code) => {
      callOrder.push({ code, time: Date.now() });
      await new Promise((r) => setTimeout(r, 10)); // 模擬 10ms 延遲
      return code === 'g_rd_section' ? ['chen.wei'] : ['wang.ceo'];
    });

    await Engine().buildChain('yamada.taro');

    // 兩次群組呼叫的時間差應 < 5ms（幾乎同時），而非串行的 10ms 以上
    expect(getGroupMembers).toHaveBeenCalledTimes(2);
    const timeDiff = Math.abs(callOrder[1].time - callOrder[0].time);
    expect(timeDiff).toBeLessThan(5);
  });

  it('✅ API 拋出例外時：回傳 ok=false + error.message', async () => {
    getEntryRoleId.mockRejectedValue(new Error('kintone API 連線逾時'));

    const { ok, error } = await Engine().buildChain('yamada.taro');

    expect(ok).toBe(false);
    expect(error).toContain('kintone API 連線逾時');
  });

  // ── docs/05 評估 #2：空簽核者不得放行 ──────────────────────────────────

  it('✅ 某一關沒有簽核者：ok=false，且錯誤訊息指出是第幾關、哪個角色', async () => {
    getEntryRoleId.mockResolvedValue('ROLE_E1');
    setupRoleMap(ROLES_EMPTY_HOLDER);
    setupGroupMembers({});

    const { ok, chain, error } = await Engine().buildChain('user.empty');

    expect(ok).toBe(false);
    expect(chain).toHaveLength(0);
    expect(error).toContain('第 2 關');
    expect(error).toContain('第二關沒人');
  });

  it('✅ 空簽核者在群組角色時同樣擋下（群組成員被清空）', async () => {
    getEntryRoleId.mockResolvedValue('ROLE_001');
    setupRoleMap(ROLES_3_STEPS);
    // 第 1 關的群組被 IT 清空成員，第 3 關正常
    setupGroupMembers({ 'g_rd_section': [], 'g_ceo': ['wang.ceo'] });

    const { ok, error } = await Engine().buildChain('yamada.taro');

    expect(ok).toBe(false);
    expect(error).toContain('第 1 關');
    expect(error).toContain('研發課課長');
  });

  // ── docs/05 評估 #3：signing_mode 快照 ────────────────────────────────

  it('✅ 子表格逐關帶入 signing_mode 快照，不是統一寫死', async () => {
    getEntryRoleId.mockResolvedValue('ROLE_M1');
    setupRoleMap(ROLES_MIXED_SIGNING);
    setupGroupMembers({});

    const { ok, chain } = await Engine().buildChain('user.mixed');

    expect(ok).toBe(true);
    expect(chain[0].value.signing_mode.value).toBe('任一人簽');
    expect(chain[1].value.signing_mode.value).toBe('全員會簽');
  });

});

// ── validateChain ───────────────────────────────────────────────────────────

describe('validateChain()', () => {

  it('✅ 正常鏈：ok=true + 正確深度', async () => {
    setupRoleMap(ROLES_3_STEPS);

    const { ok, depth, error } = await Engine().validateChain('ROLE_001');

    expect(ok).toBe(true);
    expect(depth).toBe(3);
    expect(error).toBeNull();
  });

  it('✅ 循環鏈：ok=false + 錯誤訊息包含循環節點', async () => {
    setupRoleMap(ROLES_CIRCULAR);

    const { ok, error } = await Engine().validateChain('ROLE_A');

    expect(ok).toBe(false);
    expect(error).toContain('循環');
  });

  it('✅ 斷鏈：ok=false + 錯誤訊息包含不存在角色', async () => {
    setupRoleMap(ROLES_BROKEN);

    const { ok, error } = await Engine().validateChain('ROLE_X');

    expect(ok).toBe(false);
    expect(error).toContain('ROLE_GHOST');
  });

});

// ── buildChainForCurrentUser ────────────────────────────────────────────────

describe('buildChainForCurrentUser()', () => {

  it('✅ 應使用 kintone.getLoginUser().code 作為 employeeCode', async () => {
    kintone.getLoginUser.mockReturnValue({ code: 'login.user' });
    getEntryRoleId.mockResolvedValue(null); // 不需要完整鏈，只驗證 code 傳遞

    await Engine().buildChainForCurrentUser();

    expect(getEntryRoleId).toHaveBeenCalledWith('login.user');
  });

});
