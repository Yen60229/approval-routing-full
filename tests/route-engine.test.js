/**
 * core/06-route-engine.js 單元測試
 *
 * 測試策略：
 *   - 先 import 03（掛上 Engine.walkSegment / finalizeChain / buildChain），再 import 06
 *   - 各測試用 mockResolvedValue / mockImplementation 控制 ApiClient 行為
 *   - beforeEach vi.resetAllMocks() 清除上一筆
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ROLES_ROUTE_ALL,
  ROLES_TITLED_CHAIN,
  makeRouteConfig,
} from './helpers/mock-roles.js';

await import('../core/03-chain-builder.js');
await import('../core/06-route-engine.js');

const {
  getRole,
  getEntryRoleId,
  getGroupMembers,
  getRouteConfig,
  ensureFresh,
} = global.__mocks__;

const RE = () => window.ApprovalRouting.RouteEngine;

const EMP = '員工鏈段';
const FIX = '指定角色段';

const setupRoleMap = (roleMap) =>
  getRole.mockImplementation(async (id) => roleMap[id] ?? null);

const setupGroupMembers = (membersMap) =>
  getGroupMembers.mockImplementation(async (code) => membersMap[code] ?? []);

const names = (chain) => chain.map((s) => s.step_name.value);

beforeEach(() => {
  vi.resetAllMocks();
  ensureFresh.mockResolvedValue(undefined);
  setupGroupMembers({});
});

// ── fallback ────────────────────────────────────────────────────────────────

describe('fallback（查無路由設定）', () => {

  it('✅ getRouteConfig 回 null → 走現行 buildChain 全鏈', async () => {
    getRouteConfig.mockResolvedValue(null);
    getEntryRoleId.mockResolvedValue('ROLE_P1');
    setupRoleMap(ROLES_TITLED_CHAIN);

    const { ok, chain, error } = await RE().buildChainForForm('emp', 1001);

    expect(ok).toBe(true);
    expect(error).toBeNull();
    expect(chain).toHaveLength(5); // 職員→課長→次長→部長→總經理
    expect(names(chain).at(-1)).toBe('總經理室_總經理');
  });

  it('✅ 路由設定的 route_steps 為空 → ok=false', async () => {
    getRouteConfig.mockResolvedValue(makeRouteConfig({ formAppId: 1001, steps: [] }));

    const { ok, error } = await RE().buildChainForForm('emp', 1001);

    expect(ok).toBe(false);
    expect(error).toContain('沒有任何關卡');
  });

});

// ── 員工鏈段 ────────────────────────────────────────────────────────────────

describe('員工鏈段', () => {

  beforeEach(() => setupRoleMap(ROLES_ROUTE_ALL));

  it('✅ stop_at_title_level：走到該職稱為止（含該關）', async () => {
    getEntryRoleId.mockResolvedValue('ROLE_P1');
    getRouteConfig.mockResolvedValue(makeRouteConfig({
      formAppId: 1001,
      steps: [{ segmentType: EMP, stopAtTitleLevel: '部長' }],
    }));

    const { ok, chain } = await RE().buildChainForForm('emp', 1001);

    expect(ok).toBe(true);
    expect(names(chain)).toEqual(['研發課_職員', '研發課_課長', '研發部_次長', '研發部_部長']);
  });

  it('✅ skip_title_levels：中間職稱照走但不列入簽核', async () => {
    getEntryRoleId.mockResolvedValue('ROLE_P1');
    getRouteConfig.mockResolvedValue(makeRouteConfig({
      formAppId: 1001,
      steps: [{ segmentType: EMP, stopAtTitleLevel: '部長', skipTitleLevels: ['次長'] }],
    }));

    const { ok, chain } = await RE().buildChainForForm('emp', 1001);

    expect(ok).toBe(true);
    expect(names(chain)).toEqual(['研發課_職員', '研發課_課長', '研發部_部長']);
  });

  it('✅ 截止職稱不存在於鏈上：走到終點仍沒遇到 → ok=false 設定矛盾', async () => {
    getEntryRoleId.mockResolvedValue('ROLE_P1');
    getRouteConfig.mockResolvedValue(makeRouteConfig({
      formAppId: 1001,
      steps: [{ segmentType: EMP, stopAtTitleLevel: '董事長' }],
    }));

    const { ok, error } = await RE().buildChainForForm('emp', 1001);

    expect(ok).toBe(false);
    expect(error).toContain('設定矛盾');
    expect(error).toContain('董事長');
  });

  it('✅ 申請人起點就是截止職稱（主管送自己的單）→ 個人段為空', async () => {
    getEntryRoleId.mockResolvedValue('ROLE_P4'); // 部長本人
    setupGroupMembers({ g_ga_head: ['head.ga'] });
    getRouteConfig.mockResolvedValue(makeRouteConfig({
      formAppId: 1001,
      steps: [
        { segmentType: EMP, stopAtTitleLevel: '部長' },
        { segmentType: FIX, roleId: 'ROLE_ACC' },
      ],
    }));

    const { ok, chain } = await RE().buildChainForForm('emp', 1001);

    expect(ok).toBe(true);
    expect(names(chain)).toEqual(['會計_經辦']); // 部長自己那關不簽
  });

  it('✅ 員工未設定起點角色 → ok=false', async () => {
    getEntryRoleId.mockResolvedValue(null);
    getRouteConfig.mockResolvedValue(makeRouteConfig({
      formAppId: 1001,
      steps: [{ segmentType: EMP, stopAtTitleLevel: '部長' }],
    }));

    const { ok, error } = await RE().buildChainForForm('nobody', 1001);

    expect(ok).toBe(false);
    expect(error).toContain('未設定起點角色');
  });

});

// ── 個人段 + 職能段拼接 ─────────────────────────────────────────────────────

describe('個人段 + 職能段拼接', () => {

  beforeEach(() => setupRoleMap(ROLES_ROUTE_ALL));

  it('✅ 員工鏈段 → 兩個指定角色段：依序拼接', async () => {
    getEntryRoleId.mockResolvedValue('ROLE_P1');
    setupGroupMembers({ g_ga_head: ['head.ga'] });
    getRouteConfig.mockResolvedValue(makeRouteConfig({
      formAppId: 1001,
      steps: [
        { segmentType: EMP, stopAtTitleLevel: '課長' },
        { segmentType: FIX, roleId: 'ROLE_ACC' },
        { segmentType: FIX, roleId: 'ROLE_GAH' },
      ],
    }));

    const { ok, chain } = await RE().buildChainForForm('emp', 1001);

    expect(ok).toBe(true);
    expect(names(chain)).toEqual(['研發課_職員', '研發課_課長', '會計_經辦', '總務_部長']);
    expect(chain[0].step_no.value).toBe(1);
    expect(chain[3].step_no.value).toBe(4);
    expect(chain[3].expected_signers.value).toEqual([{ code: 'head.ga' }]); // 群組成員即時解析
  });

  it('✅ 純職能流程（完全沒有員工鏈段）：不查起點角色', async () => {
    getRouteConfig.mockResolvedValue(makeRouteConfig({
      formAppId: 1001,
      steps: [
        { segmentType: FIX, roleId: 'ROLE_ACC' },
        { segmentType: FIX, roleId: 'ROLE_GA' },
      ],
    }));

    const { ok, chain } = await RE().buildChainForForm('emp', 1001);

    expect(ok).toBe(true);
    expect(names(chain)).toEqual(['會計_經辦', '總務_經辦']);
    expect(getEntryRoleId).not.toHaveBeenCalled();
  });

  it('✅ 子表格順序依 step_no，非陣列順序', async () => {
    getRouteConfig.mockResolvedValue(makeRouteConfig({
      formAppId: 1001,
      steps: [
        { stepNo: 2, segmentType: FIX, roleId: 'ROLE_GA' },
        { stepNo: 1, segmentType: FIX, roleId: 'ROLE_ACC' },
      ],
    }));

    const { ok, chain } = await RE().buildChainForForm('emp', 1001);

    expect(ok).toBe(true);
    expect(names(chain)).toEqual(['會計_經辦', '總務_經辦']);
  });

});

// ── 員工鏈段的續接（2026-09-01 修的兩個 bug）────────────────────────────────

describe('員工鏈段續接', () => {

  beforeEach(() => {
    setupRoleMap(ROLES_ROUTE_ALL);
    getEntryRoleId.mockResolvedValue('ROLE_P1');
  });

  it('✅ 員工鏈段 → 指定角色段 → 員工鏈段：第二段從前一段的下一關續走', async () => {
    getRouteConfig.mockResolvedValue(makeRouteConfig({
      formAppId: 1001,
      steps: [
        { segmentType: EMP, stopAtTitleLevel: '課長' },
        { segmentType: FIX, roleId: 'ROLE_ACC' },
        { segmentType: EMP, stopAtTitleLevel: '部長' },
      ],
    }));

    const { ok, chain } = await RE().buildChainForForm('emp', 1001);

    expect(ok).toBe(true);
    expect(names(chain)).toEqual([
      '研發課_職員', '研發課_課長',   // 第 1 段：起點 → 課長（截止）
      '會計_經辦',                    // 第 2 段：職能關
      '研發部_次長', '研發部_部長',   // 第 3 段：從次長續走 → 部長（截止）
    ]);
  });

  it('🐛 續接段的第一關就命中截止職稱 → 必須保留（不是「申請人自己」）', async () => {
    // 第 1 段停在次長 → 續接游標＝部長；第 3 段截止職稱也是部長。
    // 修正前：walkSegment 把「第一關即截止」一律當成主管送自己的單而不 push，
    //         部長會無聲從鏈上消失，且沒有任何錯誤訊息。
    getRouteConfig.mockResolvedValue(makeRouteConfig({
      formAppId: 1001,
      steps: [
        { segmentType: EMP, stopAtTitleLevel: '次長' },
        { segmentType: FIX, roleId: 'ROLE_ACC' },
        { segmentType: EMP, stopAtTitleLevel: '部長' },
      ],
    }));

    const { ok, chain } = await RE().buildChainForForm('emp', 1001);

    expect(ok).toBe(true);
    expect(names(chain)).toEqual([
      '研發課_職員', '研發課_課長', '研發部_次長',
      '會計_經辦',
      '研發部_部長', // ← 修正前這一關會被吃掉
    ]);
  });

  it('🐛 前一個員工鏈段已走到終點，後面又接員工鏈段 → 明確報設定錯誤（非誤報循環）', async () => {
    // 修正前：personalCursor 是 null，被 `?? 起點` 併掉 → 回頭重走申請人的鏈
    //         → 撞上 visited → 報「偵測到循環：ROLE_P1 重複出現」，指向完全錯的方向。
    getRouteConfig.mockResolvedValue(makeRouteConfig({
      formAppId: 1001,
      steps: [
        { segmentType: EMP },                          // 無截止職稱 → 走到 is_chain_end
        { segmentType: EMP, stopAtTitleLevel: '部長' },
      ],
    }));

    const { ok, error } = await RE().buildChainForForm('emp', 1001);

    expect(ok).toBe(false);
    expect(error).toContain('已走到簽核鏈終點');
    expect(error).not.toContain('循環');
  });

  it('✅ 主管送自己的單：第一段仍適用「不簽自己」，續接段不受影響', async () => {
    getEntryRoleId.mockResolvedValue('ROLE_P3'); // 次長本人送單
    getRouteConfig.mockResolvedValue(makeRouteConfig({
      formAppId: 1001,
      steps: [
        { segmentType: EMP, stopAtTitleLevel: '次長' },  // 起點即截止 → 本段為空
        { segmentType: EMP, stopAtTitleLevel: '部長' },  // 續接：部長要簽
      ],
    }));

    const { ok, chain } = await RE().buildChainForForm('emp', 1001);

    expect(ok).toBe(true);
    expect(names(chain)).toEqual(['研發部_部長']);
  });

});

// ── 指定角色段的錯誤情境 ────────────────────────────────────────────────────

describe('指定角色段錯誤情境', () => {

  beforeEach(() => setupRoleMap(ROLES_ROUTE_ALL));

  it('✅ 指定角色不存在或未啟用 → ok=false', async () => {
    getRouteConfig.mockResolvedValue(makeRouteConfig({
      formAppId: 1001,
      steps: [{ segmentType: FIX, roleId: 'ROLE_NOPE' }],
    }));

    const { ok, error } = await RE().buildChainForForm('emp', 1001);

    expect(ok).toBe(false);
    expect(error).toContain('ROLE_NOPE');
    expect(error).toContain('不存在或未啟用');
  });

  it('✅ 指定角色段沒填 role_id → ok=false', async () => {
    getRouteConfig.mockResolvedValue(makeRouteConfig({
      formAppId: 1001,
      steps: [{ segmentType: FIX, roleId: '' }],
    }));

    const { ok, error } = await RE().buildChainForForm('emp', 1001);

    expect(ok).toBe(false);
    expect(error).toContain('未指定角色');
  });

  it('✅ 職能段角色沒有簽核者 → 複用 #2 空簽核者檢查擋下', async () => {
    getRouteConfig.mockResolvedValue(makeRouteConfig({
      formAppId: 1001,
      steps: [{ segmentType: FIX, roleId: 'ROLE_EMPTY' }],
    }));

    const { ok, error } = await RE().buildChainForForm('emp', 1001);

    expect(ok).toBe(false);
    expect(error).toContain('沒有任何簽核者');
  });

  it('✅ 跨段循環：職能段指回員工鏈段已走過的角色 → ok=false', async () => {
    getEntryRoleId.mockResolvedValue('ROLE_P1');
    getRouteConfig.mockResolvedValue(makeRouteConfig({
      formAppId: 1001,
      steps: [
        { segmentType: EMP, stopAtTitleLevel: '次長' },
        { segmentType: FIX, roleId: 'ROLE_P2' }, // 課長，員工鏈段已走過
      ],
    }));

    const { ok, error } = await RE().buildChainForForm('emp', 1001);

    expect(ok).toBe(false);
    expect(error).toContain('ROLE_P2');
    expect(error).toContain('重複出現');
  });

});

// ── step_signing_mode 覆寫 ──────────────────────────────────────────────────

describe('step_signing_mode 覆寫', () => {

  beforeEach(() => setupRoleMap(ROLES_ROUTE_ALL));

  it('✅ 指定角色段可覆寫為「全員會簽」', async () => {
    getRouteConfig.mockResolvedValue(makeRouteConfig({
      formAppId: 1001,
      steps: [{ segmentType: FIX, roleId: 'ROLE_ACC', stepSigningMode: '全員會簽' }],
    }));

    const { ok, chain } = await RE().buildChainForForm('emp', 1001);

    expect(ok).toBe(true);
    expect(chain[0].signing_mode.value).toBe('全員會簽'); // 角色表原值是「任一人簽」
  });

  it('✅ 空值（沿用角色表）：不覆寫，用角色表快照', async () => {
    getRouteConfig.mockResolvedValue(makeRouteConfig({
      formAppId: 1001,
      steps: [{ segmentType: FIX, roleId: 'ROLE_ACC', stepSigningMode: '' }],
    }));

    const { chain } = await RE().buildChainForForm('emp', 1001);

    expect(chain[0].signing_mode.value).toBe('任一人簽');
  });

  it('✅ 員工鏈段也可以指定「全員會簽」，該關停在「會簽中」狀態', async () => {
    // 舊的編號模型擋下這種設定（位置浮動、生不出對應的 ALL 狀態）。
    // 固定狀態模型下會簽關卡一律停在專屬的「會簽中」，放在鏈的哪裡都行。
    getEntryRoleId.mockResolvedValue('ROLE_P1');
    getRouteConfig.mockResolvedValue(makeRouteConfig({
      formAppId: 1001,
      steps: [{ segmentType: EMP, stopAtTitleLevel: '課長', stepSigningMode: '全員會簽' }],
    }));

    const { ok, chain } = await RE().buildChainForForm('emp', 1001);

    expect(ok).toBe(true);
    expect(chain.every((s) => s.signing_mode.value === '全員會簽')).toBe(true);
    expect(chain.every((s) => s.step_state.value === '會簽中')).toBe(true);
  });

});

// ── forceFresh ──────────────────────────────────────────────────────────────

describe('forceFresh', () => {

  beforeEach(() => {
    setupRoleMap(ROLES_ROUTE_ALL);
    getRouteConfig.mockResolvedValue(makeRouteConfig({
      formAppId: 1001,
      steps: [{ segmentType: FIX, roleId: 'ROLE_ACC' }],
    }));
  });

  it('✅ forceFresh=true → 呼叫 ensureFresh()', async () => {
    await RE().buildChainForForm('emp', 1001, { forceFresh: true });
    expect(ensureFresh).toHaveBeenCalledTimes(1);
  });

  it('✅ 預設不呼叫 ensureFresh()', async () => {
    await RE().buildChainForForm('emp', 1001);
    expect(ensureFresh).not.toHaveBeenCalled();
  });

});

// ── buildChainForFormCurrentUser ────────────────────────────────────────────

describe('buildChainForFormCurrentUser()', () => {

  it('✅ 以 kintone.getLoginUser().code 作為申請人', async () => {
    kintone.getLoginUser.mockReturnValue({ code: 'login.user' });
    setupRoleMap(ROLES_ROUTE_ALL);
    getRouteConfig.mockResolvedValue(makeRouteConfig({
      formAppId: 1001,
      steps: [{ segmentType: EMP, stopAtTitleLevel: '課長' }],
    }));
    getEntryRoleId.mockResolvedValue('ROLE_P1');

    await RE().buildChainForFormCurrentUser(1001);

    expect(getEntryRoleId).toHaveBeenCalledWith('login.user');
  });

});
