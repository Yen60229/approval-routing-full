/**
 * adapters/00-standard-adapter.js 測試
 *
 * 兩個層次：
 *   1. 純函式（planProceed 等）— 狀態轉移的翻譯規則，分支全覆蓋
 *   2. 事件處理函式 — 從 kintone.events.on 的 mock 取出 handler 直接呼叫，
 *      驗證 submit / proceed 對 event.record 的實際寫入
 *
 * detail.show 的安全網會呼叫 location.reload()，不在此範圍（需要真瀏覽器行為）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

global.kintone.app.getId = vi.fn(() => 1001);

await import('../core/03-chain-builder.js');
await import('../adapters/00-standard-adapter.js');

// 事件處理函式在載入時就註冊完了，先抓下來（beforeEach 的 resetAllMocks 會清掉 calls）
const handlers = {};
for (const [events, fn] of global.kintone.events.on.mock.calls) {
  for (const e of [].concat(events)) handlers[e] = fn;
}

const {
  planProceed, findBuiltIn, hasAdapterFields, sameMembers, chainRow,
} = window.ApprovalRouting.AdapterInternals;

const { getRole, getRouteConfig, getGroupMembers } = global.__mocks__;

const submitHandler = handlers['app.record.create.submit'];
const proceedHandler = handlers['app.record.detail.process.proceed'];

// ── 測試資料 ────────────────────────────────────────────────────────────────

const chainStep = (n, roleId, name, signers) => ({
  id: String(n),
  value: {
    step_no:          { value: n },
    role_id:          { value: roleId },
    step_name:        { value: name },
    expected_signers: { value: signers.map((code) => ({ code })) },
    signing_mode:     { value: '任一人簽' },
    signed_by:        { value: [] },
    signed_at:        { value: '' },
  },
});

/** 一筆已進入簽核的申請記錄 */
const makeRecord = ({ status = '簽核中(1)', currentStep = 1, totalSteps = 3 } = {}) => ({
  $id:       { type: 'RECORD_NUMBER', value: '42' },
  $revision: { type: '__REVISION__', value: '7' },
  狀態:      { type: 'STATUS', value: status },
  作業者:    { type: 'STATUS_ASSIGNEE', value: [{ code: 'user.p1' }] },
  approver_chain:    { type: 'SUBTABLE', value: [
    chainStep(1, 'ROLE_P1', '研發課_職員', ['user.p1']),
    chainStep(2, 'ROLE_P2', '研發課_課長', ['user.p2']),
    chainStep(3, 'ROLE_P3', '研發部_次長', ['user.p3']),
  ] },
  current_approvers: { type: 'USER_SELECT', value: [{ code: 'user.p1' }] },
  current_step:      { type: 'NUMBER', value: String(currentStep) },
  total_steps:       { type: 'NUMBER', value: String(totalSteps) },
});

const roleRec = (roleId, holder) => ({
  role_id:      { value: roleId },
  role_name:    { value: roleId },
  holder_type:  { value: '指定個人' },
  holder_group: { value: [] },
  holder_user:  { value: [{ code: holder }] },
});

beforeEach(() => {
  vi.resetAllMocks();
  global.kintone.app.getId.mockReturnValue(1001);
  global.kintone.getLoginUser.mockReturnValue({ code: 'test.user', name: '測試使用者' });
  getRole.mockImplementation(async (id) => roleRec(id, `user.${id.toLowerCase().replace('role_', '')}`));
  getGroupMembers.mockResolvedValue([]);
  getRouteConfig.mockResolvedValue({ max_depth: { value: '5' } });
});

// ── planProceed：狀態轉移的翻譯規則 ──────────────────────────────────────────

describe('planProceed', () => {

  const plan = (o) => planProceed({ currentStep: 1, totalSteps: 3, ...o });

  it('🔑 全員會簽尚未簽完（狀態沒變）→ stay，絕不推進', () => {
    // kintone 官方：ALL 的關卡每個人按一次都會觸發 proceed，直到最後一人才換狀態。
    // 若在這裡推進，會簽關卡每有一人簽名就跳一關。
    const r = plan({ fromStatus: '簽核中(2)', toStatus: '簽核中(2)', currentStep: 2 });
    expect(r.kind).toBe('stay');
    expect(r.nextStep).toBeNull();
  });

  it('✅ 核准往下一關 → advance，解析下一關的簽核者', () => {
    const r = plan({ fromStatus: '簽核中(1)', toStatus: '簽核中(2)' });
    expect(r).toMatchObject({ kind: 'advance', nextStep: 2, approverStep: 2 });
  });

  it('✅ 送出（草稿 → 簽核中(1)）→ advance 到第 1 關', () => {
    const r = plan({ fromStatus: '草稿', toStatus: '簽核中(1)', currentStep: 0 });
    expect(r).toMatchObject({ kind: 'advance', nextStep: 1, approverStep: 1 });
  });

  it('✅ 最後一關核准 → terminal，執行者清空、指標停在總關數', () => {
    const r = plan({ fromStatus: '簽核中(3)', toStatus: '核准', currentStep: 3 });
    expect(r).toMatchObject({ kind: 'terminal', nextStep: 3, approverStep: null });
  });

  it('✅ 駁回 → reset，指標歸零、執行者交給狀態設定（申請人）', () => {
    const r = plan({ fromStatus: '簽核中(2)', toStatus: '駁回', currentStep: 2 });
    expect(r).toMatchObject({ kind: 'reset', nextStep: 0, approverStep: null });
  });

  it('✅ 再申請（駁回 → 草稿）→ reset', () => {
    const r = plan({ fromStatus: '駁回', toStatus: '草稿', currentStep: 0 });
    expect(r).toMatchObject({ kind: 'reset', nextStep: 0 });
  });

  it('✅ 退回上一關（簽核中(3) → 簽核中(2)）→ advance 到第 2 關', () => {
    const r = plan({ fromStatus: '簽核中(3)', toStatus: '簽核中(2)', currentStep: 3 });
    expect(r).toMatchObject({ kind: 'advance', nextStep: 2, approverStep: 2 });
  });

  it('✅ 作廢 → terminal，執行者清空', () => {
    const r = plan({ fromStatus: '簽核中(2)', toStatus: '作廢', currentStep: 2 });
    expect(r).toMatchObject({ kind: 'terminal', approverStep: null });
  });

  it('🔒 併發：記錄的 current_step 與畫面上的關卡不符 → blocked', () => {
    // 兩個「任一人簽」的簽核者同時按核准，慢的那個會走到這裡
    const r = plan({ fromStatus: '簽核中(1)', toStatus: '簽核中(2)', currentStep: 2 });
    expect(r.kind).toBe('blocked');
    expect(r.error).toContain('已經被其他簽核者處理過');
  });

  it('✅ current_step 為 0（adapter 上線前的舊單）→ 不擋，順勢補上', () => {
    const r = plan({ fromStatus: '簽核中(2)', toStatus: '簽核中(3)', currentStep: 0 });
    expect(r.kind).toBe('advance');
  });

});

// ── 內建欄位定位 ────────────────────────────────────────────────────────────

describe('findBuiltIn', () => {

  it('🔑 用型別找內建欄位，不靠欄位代碼', () => {
    // 內建欄位代碼隨 kintone 語言而異（狀態／ステータス／Status），寫死會靜默失效
    const rec = makeRecord();
    expect(findBuiltIn(rec, 'STATUS').value).toBe('簽核中(1)');
    expect(findBuiltIn(rec, 'STATUS_ASSIGNEE').value).toEqual([{ code: 'user.p1' }]);
  });

  it('✅ 日文欄位代碼一樣找得到', () => {
    const rec = { ステータス: { type: 'STATUS', value: '核准' } };
    expect(findBuiltIn(rec, 'STATUS').value).toBe('核准');
  });

  it('✅ 找不到回 null', () => {
    expect(findBuiltIn({}, 'STATUS')).toBeNull();
    expect(findBuiltIn(undefined, 'STATUS')).toBeNull();
  });

});

describe('hasAdapterFields / sameMembers / chainRow', () => {

  it('✅ 四個規約欄位齊全才算數', () => {
    expect(hasAdapterFields(makeRecord())).toBe(true);
    const missing = makeRecord();
    delete missing.total_steps;
    expect(hasAdapterFields(missing)).toBe(false);
  });

  it('✅ sameMembers 順序無關', () => {
    expect(sameMembers(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameMembers(['a'], ['a', 'b'])).toBe(false);
    expect(sameMembers([], [])).toBe(true);
  });

  it('✅ chainRow 是 1-based', () => {
    const rec = makeRecord();
    expect(chainRow(rec, 1).value.role_id.value).toBe('ROLE_P1');
    expect(chainRow(rec, 3).value.role_id.value).toBe('ROLE_P3');
    expect(chainRow(rec, 4)).toBeNull();
  });

});

// ── submit ─────────────────────────────────────────────────────────────────

describe('submit', () => {

  const draftRecord = () => {
    const r = makeRecord({ status: '草稿', currentStep: 0 });
    r.approver_chain.value = [];
    r.current_approvers.value = [];
    r.total_steps.value = '';
    return r;
  };

  const builtChain = [
    chainStep(1, 'ROLE_P1', '研發課_職員', ['user.p1']).value,
    chainStep(2, 'ROLE_P2', '研發課_課長', ['user.p2']).value,
  ];

  it('✅ 草稿送出：寫入鏈、total_steps、current_step=0、第 1 關簽核者', async () => {
    window.ApprovalRouting.buildChainForForm = vi.fn().mockResolvedValue({
      ok: true, chain: builtChain, error: null,
    });

    const event = { record: draftRecord() };
    await submitHandler(event);

    expect(event.record.approver_chain.value).toBe(builtChain);
    expect(event.record.total_steps.value).toBe('2');
    // 0＝還沒進簽核；送出動作才推到 1
    expect(event.record.current_step.value).toBe('0');
    // kintone 解析「指定欄位」執行者時讀的是按鈕按下前的值，所以這裡要先放好第 1 關
    expect(event.record.current_approvers.value).toEqual([{ code: 'user.p1' }]);
    expect(event.error).toBeUndefined();
  });

  it('✅ forceFresh：正式送出不吃過期快取', async () => {
    window.ApprovalRouting.buildChainForForm = vi.fn().mockResolvedValue({
      ok: true, chain: builtChain, error: null,
    });

    await submitHandler({ record: draftRecord() });

    expect(window.ApprovalRouting.buildChainForForm).toHaveBeenCalledWith(
      'test.user', 1001, { forceFresh: true }
    );
  });

  it('✅ 建鏈失敗 → event.error 擋下儲存', async () => {
    window.ApprovalRouting.buildChainForForm = vi.fn().mockResolvedValue({
      ok: false, chain: [], error: '員工 test.user 未設定起點角色',
    });

    const event = { record: draftRecord() };
    await submitHandler(event);

    expect(event.error).toContain('未設定起點角色');
  });

  it('🔑 鏈比已部署的狀態數長 → 擋在送出當下，不讓單子卡在最後一關', async () => {
    // 組織長高之後一定會發生（多一層主管就多一關）
    window.ApprovalRouting.buildChainForForm = vi.fn().mockResolvedValue({
      ok: true, chain: [1, 2, 3, 4, 5, 6].map((n) => chainStep(n, `ROLE_${n}`, `第${n}關`, ['u']).value), error: null,
    });
    getRouteConfig.mockResolvedValue({ max_depth: { value: '5' } });

    const event = { record: draftRecord() };
    await submitHandler(event);

    expect(event.error).toContain('需要 6 關');
    expect(event.error).toContain('只部署到 5 關');
  });

  it('✅ max_depth 未設定（還沒跑過產生器）→ 不擋', async () => {
    window.ApprovalRouting.buildChainForForm = vi.fn().mockResolvedValue({
      ok: true, chain: builtChain, error: null,
    });
    getRouteConfig.mockResolvedValue({ max_depth: { value: '' } });

    const event = { record: draftRecord() };
    await submitHandler(event);

    expect(event.error).toBeUndefined();
  });

  it('✅ 非草稿狀態不重算（已簽過的關卡不能被洗掉）', async () => {
    window.ApprovalRouting.buildChainForForm = vi.fn();

    const event = { record: makeRecord({ status: '簽核中(2)' }) };
    await submitHandler(event);

    expect(window.ApprovalRouting.buildChainForForm).not.toHaveBeenCalled();
  });

  it('✅ App 沒埋齊規約欄位 → 整支停用，不半殘地跑', async () => {
    window.ApprovalRouting.buildChainForForm = vi.fn();
    const bare = { 狀態: { type: 'STATUS', value: '草稿' } };

    const event = { record: bare };
    await submitHandler(event);

    expect(window.ApprovalRouting.buildChainForForm).not.toHaveBeenCalled();
    expect(event.error).toBeUndefined();
  });

});

// ── process.proceed ────────────────────────────────────────────────────────

describe('process.proceed', () => {

  const evt = (from, to, action = '核准', recOpts = {}) => ({
    record: makeRecord(recOpts),
    status: { value: from },
    nextStatus: { value: to },
    action: { value: action },
  });

  it('✅ 核准往下一關：current_step 推進、執行者換成第 2 關的人', async () => {
    const event = evt('簽核中(1)', '簽核中(2)', '核准', { currentStep: 1 });
    await proceedHandler(event);

    expect(event.record.current_step.value).toBe('2');
    expect(event.record.current_approvers.value).toEqual([{ code: 'user.p2' }]);
  });

  it('🔑 全員會簽尚未簽完：只記簽名，current_step 不動', async () => {
    const event = evt('簽核中(2)', '簽核中(2)', '核准', { currentStep: 2 });
    await proceedHandler(event);

    expect(event.record.current_step.value).toBe('2');
    expect(event.record.approver_chain.value[1].value.signed_by.value)
      .toEqual([{ code: 'test.user' }]);
  });

  it('✅ 簽名逐一累加，同一人不重複記', async () => {
    const event = evt('簽核中(2)', '簽核中(2)', '核准', { currentStep: 2 });
    await proceedHandler(event);
    await proceedHandler(event);

    expect(event.record.approver_chain.value[1].value.signed_by.value)
      .toEqual([{ code: 'test.user' }]);
  });

  it('✅ 最後一關核准 → 執行者清空', async () => {
    const event = evt('簽核中(3)', '核准', '核准', { currentStep: 3 });
    await proceedHandler(event);

    expect(event.record.current_approvers.value).toEqual([]);
    expect(event.record.current_step.value).toBe('3');
  });

  it('✅ 駁回 → 指標歸零、執行者清空（交給狀態設定的申請人）', async () => {
    const event = evt('簽核中(2)', '駁回', '駁回', { currentStep: 2 });
    await proceedHandler(event);

    expect(event.record.current_step.value).toBe('0');
    expect(event.record.current_approvers.value).toEqual([]);
  });

  it('✅ 駁回不記簽名', async () => {
    const event = evt('簽核中(2)', '駁回', '駁回', { currentStep: 2 });
    await proceedHandler(event);

    expect(event.record.approver_chain.value[1].value.signed_by.value).toEqual([]);
  });

  it('🔒 併發：current_step 對不上 → event.error 擋下，不動任何欄位', async () => {
    const event = evt('簽核中(1)', '簽核中(2)', '核准', { currentStep: 3 });
    await proceedHandler(event);

    expect(event.error).toContain('已經被其他簽核者處理過');
    expect(event.record.current_step.value).toBe('3');
  });

  it('✅ 下一關沒有簽核者 → 擋下並說明是哪一關', async () => {
    getRole.mockImplementation(async (id) =>
      id === 'ROLE_P2' ? { ...roleRec(id, ''), holder_user: { value: [] } } : roleRec(id, 'someone'));

    const event = evt('簽核中(1)', '簽核中(2)', '核准', { currentStep: 1 });
    await proceedHandler(event);

    expect(event.error).toContain('研發課_課長');
    expect(event.error).toContain('沒有任何簽核者');
  });

  it('✅ 即時解析：角色換人後，跑到那一關拿到的是新的人', async () => {
    getRole.mockImplementation(async (id) =>
      id === 'ROLE_P2' ? roleRec(id, 'new.manager') : roleRec(id, 'whoever'));

    const event = evt('簽核中(1)', '簽核中(2)', '核准', { currentStep: 1 });
    await proceedHandler(event);

    // 子表格快照寫的是 user.p2，但實際拿到的是角色表上現在的人
    expect(event.record.current_approvers.value).toEqual([{ code: 'new.manager' }]);
  });

});
