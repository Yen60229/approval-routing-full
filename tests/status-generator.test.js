/**
 * tools/10-status-generator.js 的純函式測試
 *
 * 範圍：狀態圖產生、驗證、全員會簽位置判定、部署指紋、K 值計算。
 * UI（SweetAlert 流程、按鈕）與 REST 呼叫不在此範圍。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ROLES_ROUTE_ALL, makeRouteConfig } from './helpers/mock-roles.js';

await import('../core/03-chain-builder.js');
await import('../core/06-route-engine.js');
await import('../tools/10-status-generator.js');

const {
  buildStatusJson,
  validateStatusPayload,
  resolveAllSigningPositions,
  hashRouteConfig,
  countApprovingStates,
  computeMaxDepth,
  TPL,
} = window.ApprovalRouting.StatusGeneratorInternals;

const { getRole, getEntryRoleId, getDistinctEntryRoleIds } = global.__mocks__;

const EMP = '員工鏈段';
const FIX = '指定角色段';
const ALL = '全員會簽';

/** 只取 from→to 的精簡表示，方便斷言 */
const actionSigs = (payload, name) =>
  payload.actions.filter((a) => a.name === name).map((a) => `${a.from}→${a.to}[${a.filterCond}]`);

const cfg = (steps, extra = {}) => makeRouteConfig({ formAppId: 1001, steps, ...extra });

beforeEach(() => {
  vi.resetAllMocks();
  getRole.mockImplementation(async (id) => ROLES_ROUTE_ALL[id] ?? null);
});

// ── 狀態產生 ────────────────────────────────────────────────────────────────

describe('buildStatusJson — 狀態', () => {

  it('✅ K=3：草稿 + 簽核中(1..3) + 核准 + 駁回 + 作廢，index 從 0 連續', () => {
    const { ok, payload } = buildStatusJson({ routeConfig: cfg([{ segmentType: EMP }]), k: 3 });

    expect(ok).toBe(true);
    expect(Object.keys(payload.states)).toEqual([
      '草稿', '簽核中(1)', '簽核中(2)', '簽核中(3)', '核准', '駁回', '作廢',
    ]);
    expect(Object.values(payload.states).map((s) => s.index)).toEqual(['0', '1', '2', '3', '4', '5', '6']);
  });

  it('✅ 簽核關卡的執行者掛 current_approvers（FIELD_ENTITY，不是 CUSTOM_FIELD）', () => {
    const { payload } = buildStatusJson({ routeConfig: cfg([{ segmentType: EMP }]), k: 2 });

    expect(payload.states['簽核中(1)'].assignee).toEqual({
      type: 'ANY',
      entities: [{ entity: { type: 'FIELD_ENTITY', code: 'current_approvers' }, includeSubs: false }],
    });
  });

  it('✅ 任一人簽用 ANY（不是 ONE——ONE 是「指定一人」）', () => {
    const { payload } = buildStatusJson({ routeConfig: cfg([{ segmentType: EMP }]), k: 2 });
    expect(payload.states['簽核中(1)'].assignee.type).toBe('ANY');
    expect(payload.states['簽核中(2)'].assignee.type).toBe('ANY');
  });

  it('✅ 終態（核准／作廢）不設執行者；駁回掛 CREATOR 讓申請人能再申請', () => {
    const { payload } = buildStatusJson({ routeConfig: cfg([{ segmentType: EMP }]), k: 1 });

    expect(payload.states['核准'].assignee.entities).toEqual([]);
    expect(payload.states['作廢'].assignee.entities).toEqual([]);
    expect(payload.states['駁回'].assignee.entities).toEqual([
      { entity: { type: 'CREATOR' }, includeSubs: false },
    ]);
  });

  it('✅ 只增不減：算出來 K 比已部署的少 → 保留既有狀態數', () => {
    const { ok, payload, effectiveK } = buildStatusJson({
      routeConfig: cfg([{ segmentType: EMP }]), k: 2, existingApprovingCount: 5,
    });

    expect(ok).toBe(true);
    expect(effectiveK).toBe(5);
    expect(payload.states['簽核中(5)']).toBeDefined();
  });

  it('✅ K 超過上限 10 → 擋下', () => {
    const { ok, error } = buildStatusJson({ routeConfig: cfg([{ segmentType: EMP }]), k: 11 });
    expect(ok).toBe(false);
    expect(error).toContain('超過上限 10');
  });

});

// ── 動作產生 ────────────────────────────────────────────────────────────────

describe('buildStatusJson — 動作', () => {

  it('✅ 變動深度：每一關兩條同名「核准」，filterCond 互補', () => {
    const { payload } = buildStatusJson({ routeConfig: cfg([{ segmentType: EMP }]), k: 3 });

    expect(actionSigs(payload, '核准')).toEqual([
      '簽核中(1)→簽核中(2)[total_steps > 1]',
      '簽核中(1)→核准[total_steps <= 1]',
      '簽核中(2)→簽核中(3)[total_steps > 2]',
      '簽核中(2)→核准[total_steps <= 2]',
      '簽核中(3)→核准[]',   // 最後一關只有一條出路，不需要條件
    ]);
  });

  it('✅ 送出／再申請各一條', () => {
    const { payload } = buildStatusJson({ routeConfig: cfg([{ segmentType: EMP }]), k: 2 });
    expect(actionSigs(payload, '送出')).toEqual(['草稿→簽核中(1)[]']);
    expect(actionSigs(payload, '再申請')).toEqual(['駁回→草稿[]']);
  });

  it('✅ 駁回＝退回申請人：每一關都回駁回狀態', () => {
    const { payload } = buildStatusJson({
      routeConfig: cfg([{ segmentType: EMP }], { rejectTarget: '退回申請人' }), k: 3,
    });
    expect(actionSigs(payload, '駁回')).toEqual([
      '簽核中(1)→駁回[]', '簽核中(2)→駁回[]', '簽核中(3)→駁回[]',
    ]);
  });

  it('✅ 駁回＝退回上一關：第 1 關沒有上一關，仍回駁回狀態', () => {
    const { payload } = buildStatusJson({
      routeConfig: cfg([{ segmentType: EMP }], { rejectTarget: '退回上一關' }), k: 3,
    });
    expect(actionSigs(payload, '駁回')).toEqual([
      '簽核中(1)→駁回[]',        // 上一關就是申請人本人
      '簽核中(2)→簽核中(1)[]',
      '簽核中(3)→簽核中(2)[]',
    ]);
  });

  it('✅ 作廢掛在每個非終態，SECONDARY，限定群組', () => {
    const rc = cfg([{ segmentType: EMP }]);
    rc.cancel_groups.value = [{ code: 'g_admin' }];
    const { payload } = buildStatusJson({ routeConfig: rc, k: 2 });

    const cancels = payload.actions.filter((a) => a.name === '作廢');
    expect(cancels.map((a) => a.from)).toEqual(['草稿', '簽核中(1)', '簽核中(2)', '駁回']);
    expect(cancels.every((a) => a.type === 'SECONDARY')).toBe(true);
    expect(cancels[0].executableUser).toEqual({
      entities: [{ entity: { type: 'GROUP', code: 'g_admin' }, includeSubs: false }],
    });
  });

  it('✅ 沒設作廢群組 → 不帶 executableUser（沿用該狀態的執行者）', () => {
    const { payload } = buildStatusJson({ routeConfig: cfg([{ segmentType: EMP }]), k: 1 });
    const cancel = payload.actions.find((a) => a.name === '作廢');
    expect(cancel.executableUser).toBeUndefined();
  });

});

// ── 全員會簽的位置判定（docs/06 §5.4）────────────────────────────────────────

describe('resolveAllSigningPositions', () => {

  it('✅ 純職能路由：第 2 段全員會簽 → 位置固定，ALL 生效', () => {
    const rc = cfg([
      { segmentType: FIX, roleId: 'ROLE_ACC' },
      { segmentType: FIX, roleId: 'ROLE_GA', stepSigningMode: ALL },
    ]);
    const { ok, allPositions } = resolveAllSigningPositions(rc.route_steps.value);

    expect(ok).toBe(true);
    expect([...allPositions]).toEqual([2]);
  });

  it('🚫 全員會簽排在員工鏈段之後 → 位置浮動，擋下並說明原因', () => {
    const rc = cfg([
      { segmentType: EMP, stopAtTitleLevel: '部長' },
      { segmentType: FIX, roleId: 'ROLE_ACC', stepSigningMode: ALL },
    ]);
    const { ok, error } = resolveAllSigningPositions(rc.route_steps.value);

    expect(ok).toBe(false);
    expect(error).toContain('因申請人而異');
  });

  it('🚫 員工鏈段自己指定全員會簽 → 擋下', () => {
    const rc = cfg([{ segmentType: EMP, stepSigningMode: ALL }]);
    const { ok, error } = resolveAllSigningPositions(rc.route_steps.value);

    expect(ok).toBe(false);
    expect(error).toContain('僅限指定角色段');
  });

  it('✅ 全員會簽的狀態產生為 ALL，其餘維持 ANY', () => {
    const rc = cfg([
      { segmentType: FIX, roleId: 'ROLE_ACC' },
      { segmentType: FIX, roleId: 'ROLE_GA', stepSigningMode: ALL },
    ]);
    const { payload } = buildStatusJson({ routeConfig: rc, k: 2 });

    expect(payload.states['簽核中(1)'].assignee.type).toBe('ANY');
    expect(payload.states['簽核中(2)'].assignee.type).toBe('ALL');
  });

  it('🚫 buildStatusJson 會把位置浮動的全員會簽一起擋下', () => {
    const rc = cfg([
      { segmentType: EMP },
      { segmentType: FIX, roleId: 'ROLE_ACC', stepSigningMode: ALL },
    ]);
    const { ok, error } = buildStatusJson({ routeConfig: rc, k: 3 });

    expect(ok).toBe(false);
    expect(error).toContain('全員會簽');
  });

});

// ── 驗證 ────────────────────────────────────────────────────────────────────

describe('validateStatusPayload', () => {

  const goodPayload = () => buildStatusJson({ routeConfig: cfg([{ segmentType: EMP }]), k: 3 }).payload;

  it('✅ 正常產出無錯', () => {
    expect(validateStatusPayload(goodPayload())).toEqual([]);
  });

  it('✅ from 指向不存在的狀態 → 錯', () => {
    const p = goodPayload();
    p.actions.push({ name: '亂搞', from: '不存在的狀態', to: '核准', filterCond: '', type: 'PRIMARY' });
    expect(validateStatusPayload(p).join()).toContain('來源狀態「不存在的狀態」不存在');
  });

  it('✅ 兩條同名動作都沒有條件 → 錯（按鈕行為不可預期）', () => {
    const p = goodPayload();
    p.actions.push({ name: '核准', from: '簽核中(1)', to: '核准', filterCond: '', type: 'PRIMARY' });
    p.actions.push({ name: '核准', from: '簽核中(1)', to: '作廢', filterCond: '', type: 'PRIMARY' });
    expect(validateStatusPayload(p).join()).toContain('沒有條件的同名動作');
  });

  it('✅ 一條有條件一條沒有 → 允許（互補分歧的常見寫法）', () => {
    const p = goodPayload();
    p.actions.push({ name: '核准', from: '簽核中(1)', to: '作廢', filterCond: 'total_steps > 99', type: 'PRIMARY' });
    expect(validateStatusPayload(p)).toEqual([]);
  });

  it('✅ 非終態沒有出路 → 錯（單子會卡死）', () => {
    const p = goodPayload();
    p.states['孤島'] = { name: '孤島', index: '7', assignee: { type: 'ANY', entities: [] } };
    expect(validateStatusPayload(p).join()).toContain('「孤島」沒有任何出路');
  });

  it('✅ 終態有向外的動作 → 錯', () => {
    const p = goodPayload();
    p.actions.push({ name: '復活', from: '核准', to: '草稿', filterCond: '', type: 'PRIMARY' });
    expect(validateStatusPayload(p).join()).toContain('終態「核准」不應該有向外的動作');
  });

  it('✅ index 不連續 → 錯', () => {
    const p = goodPayload();
    p.states['草稿'].index = '9';
    expect(validateStatusPayload(p).join()).toContain('index 不連續');
  });

  it('✅ 來源與目標相同 → 錯', () => {
    const p = goodPayload();
    p.actions.push({ name: '原地打轉', from: '簽核中(1)', to: '簽核中(1)', filterCond: '', type: 'PRIMARY' });
    expect(validateStatusPayload(p).join()).toContain('來源與目標都是');
  });

});

// ── 部署指紋 ────────────────────────────────────────────────────────────────

describe('hashRouteConfig', () => {

  it('✅ 相同設定 → 相同雜湊', () => {
    const a = cfg([{ segmentType: EMP, stopAtTitleLevel: '部長' }]);
    const b = cfg([{ segmentType: EMP, stopAtTitleLevel: '部長' }]);
    expect(hashRouteConfig(a, 3)).toBe(hashRouteConfig(b, 3));
  });

  it('✅ 改了截止職稱 → 雜湊變（偵測「路由改了忘記重部署」）', () => {
    const a = cfg([{ segmentType: EMP, stopAtTitleLevel: '部長' }]);
    const b = cfg([{ segmentType: EMP, stopAtTitleLevel: '次長' }]);
    expect(hashRouteConfig(a, 3)).not.toBe(hashRouteConfig(b, 3));
  });

  it('✅ K 變了 → 雜湊變', () => {
    const a = cfg([{ segmentType: EMP }]);
    expect(hashRouteConfig(a, 3)).not.toBe(hashRouteConfig(a, 4));
  });

  it('✅ 跳過職稱的陣列順序不影響雜湊（複選欄位順序不穩定）', () => {
    const a = cfg([{ segmentType: EMP, skipTitleLevels: ['次長', '課長'] }]);
    const b = cfg([{ segmentType: EMP, skipTitleLevels: ['課長', '次長'] }]);
    expect(hashRouteConfig(a, 3)).toBe(hashRouteConfig(b, 3));
  });

  it('✅ 只改表單名稱 → 雜湊不變（不影響狀態圖）', () => {
    const a = cfg([{ segmentType: EMP }]);
    const b = cfg([{ segmentType: EMP }], { formName: '換個名字' });
    expect(hashRouteConfig(a, 3)).toBe(hashRouteConfig(b, 3));
  });

  it('✅ 輸出 8 碼十六進位', () => {
    expect(hashRouteConfig(cfg([{ segmentType: EMP }]), 3)).toMatch(/^[0-9a-f]{8}$/);
  });

});

// ── countApprovingStates ────────────────────────────────────────────────────

describe('countApprovingStates', () => {

  it('✅ 數出連續的簽核中(n)', () => {
    const states = { 草稿: {}, '簽核中(1)': {}, '簽核中(2)': {}, '簽核中(3)': {}, 核准: {} };
    expect(countApprovingStates(states)).toBe(3);
  });

  it('✅ 沒有簽核狀態（全新 App）→ 0', () => {
    expect(countApprovingStates({ 未処理: {} })).toBe(0);
    expect(countApprovingStates(undefined)).toBe(0);
  });

});

// ── K 值計算 ────────────────────────────────────────────────────────────────

describe('computeMaxDepth', () => {

  it('✅ 純職能路由：直接數關卡，不查 686', async () => {
    const rc = cfg([
      { segmentType: FIX, roleId: 'ROLE_ACC' },
      { segmentType: FIX, roleId: 'ROLE_GA' },
    ]);

    const { ok, k } = await computeMaxDepth(rc);

    expect(ok).toBe(true);
    expect(k).toBe(2);
    expect(getDistinctEntryRoleIds).not.toHaveBeenCalled();
  });

  it('✅ 有員工鏈段：取所有 distinct 起點展開後的最大值', async () => {
    // P1 職員起步走到部長＝4 關；P3 次長起步＝2 關 → K 應為 4
    getDistinctEntryRoleIds.mockResolvedValue(['ROLE_P1', 'ROLE_P3']);
    const rc = cfg([{ segmentType: EMP, stopAtTitleLevel: '部長' }]);

    const { ok, k } = await computeMaxDepth(rc);

    expect(ok).toBe(true);
    expect(k).toBe(4);
    expect(getEntryRoleId).not.toHaveBeenCalled(); // 給定 entryRoleId 就不該再查 686 單筆
  });

  it('✅ 個別起點展開失敗不中斷，收集起來回報', async () => {
    getDistinctEntryRoleIds.mockResolvedValue(['ROLE_P1', 'ROLE_GHOST']);
    const rc = cfg([{ segmentType: EMP, stopAtTitleLevel: '部長' }]);

    const { ok, k, skipped } = await computeMaxDepth(rc);

    expect(ok).toBe(true);
    expect(k).toBe(4);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain('ROLE_GHOST');
  });

  it('✅ 全部起點都失敗 → ok=false，要求先修資料', async () => {
    getDistinctEntryRoleIds.mockResolvedValue(['ROLE_GHOST']);
    const rc = cfg([{ segmentType: EMP, stopAtTitleLevel: '部長' }]);

    const { ok, error } = await computeMaxDepth(rc);

    expect(ok).toBe(false);
    expect(error).toContain('健康檢查');
  });

  it('✅ 686 沒有任何啟用中起點 → ok=false', async () => {
    getDistinctEntryRoleIds.mockResolvedValue([]);
    const rc = cfg([{ segmentType: EMP, stopAtTitleLevel: '部長' }]);

    const { ok, error } = await computeMaxDepth(rc);

    expect(ok).toBe(false);
    expect(error).toContain('沒有任何啟用中的起點角色');
  });

});

// ── 端到端：路由 → 狀態圖 ───────────────────────────────────────────────────

describe('端到端', () => {

  it('✅ 「員工鏈段到部長 + 會計經辦」→ K=5 的完整狀態圖且通過驗證', async () => {
    getDistinctEntryRoleIds.mockResolvedValue(['ROLE_P1', 'ROLE_P3']);
    const rc = cfg([
      { segmentType: EMP, stopAtTitleLevel: '部長' },
      { segmentType: FIX, roleId: 'ROLE_ACC' },
    ]);

    const { ok, k } = await computeMaxDepth(rc);
    expect(ok).toBe(true);
    expect(k).toBe(5); // 職員→課長→次長→部長→會計經辦

    const built = buildStatusJson({ routeConfig: rc, k });
    expect(built.ok).toBe(true);
    expect(validateStatusPayload(built.payload)).toEqual([]);
    expect(Object.keys(built.payload.states)).toContain(TPL.approving(5));
    expect(built.payload.states[TPL.approving(6)]).toBeUndefined();
  });

});
