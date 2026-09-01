/**
 * adapters/00-standard-adapter.js 測試
 *
 * 兩個層次：
 *   1. 純函式（planProceed / isFinalSignature / nextStateAfter / rejectStateAt）
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
  planProceed, isFinalSignature, nextStateAfter, rejectStateAt,
  findBuiltIn, hasAdapterFields, sameMembers, chainRow,
} = window.ApprovalRouting.AdapterInternals;

const { getRole, getRouteConfig } = global.__mocks__;

const submitHandler = handlers['app.record.create.submit'];
const proceedHandler = handlers['app.record.detail.process.proceed'];

const APPROVING = '簽核中';
const HANDLER = '經辦人確認中';
const COSIGNING = '會簽中';
const REJECTED = '駁回';
const DECIDED = '核決';

// ── 測試資料 ────────────────────────────────────────────────────────────────

const chainStep = (n, roleId, name, signers, state = APPROVING, mode = '任一人簽') => ({
  id: String(n),
  value: {
    step_no:          { value: n },
    role_id:          { value: roleId },
    step_name:        { value: name },
    expected_signers: { value: signers.map((code) => ({ code })) },
    signing_mode:     { value: mode },
    step_state:       { value: state },
    signed_by:        { value: [] },
    signed_at:        { value: '' },
  },
});

/** 三關：簽核中 → 簽核中 → 經辦人確認中（自迴圈會發生在前兩關之間） */
const defaultChain = () => [
  chainStep(1, 'ROLE_P1', '研發課_職員', ['user.p1']),
  chainStep(2, 'ROLE_P2', '研發課_課長', ['user.p2']),
  chainStep(3, 'ROLE_ACC', '會計_經辦', ['user.acc'], HANDLER),
];

const makeRecord = ({ status = APPROVING, currentStep = 1, chain = defaultChain(), assignees = ['user.p1'] } = {}) => ({
  $id:       { type: 'RECORD_NUMBER', value: '42' },
  $revision: { type: '__REVISION__', value: '7' },
  狀態:      { type: 'STATUS', value: status },
  作業者:    { type: 'STATUS_ASSIGNEE', value: assignees.map((code) => ({ code })) },
  approver_chain:    { type: 'SUBTABLE', value: chain },
  current_approvers: { type: 'USER_SELECT', value: [{ code: 'user.p1' }] },
  current_step:      { type: 'NUMBER', value: String(currentStep) },
  total_steps:       { type: 'NUMBER', value: String(chain.length) },
  next_state:        { type: 'SINGLE_LINE_TEXT', value: APPROVING },
  reject_state:      { type: 'SINGLE_LINE_TEXT', value: REJECTED },
});

const roleRec = (roleId, holder) => ({
  role_id:      { value: roleId },
  role_name:    { value: roleId },
  holder_type:  { value: '指定個人' },
  holder_group: { value: [] },
  holder_user:  { value: holder ? [{ code: holder }] : [] },
});

beforeEach(() => {
  vi.resetAllMocks();
  global.kintone.app.getId.mockReturnValue(1001);
  global.kintone.getLoginUser.mockReturnValue({ code: 'test.user', name: '測試使用者' });
  getRole.mockImplementation(async (id) => roleRec(id, `holder.${id}`));
  getRouteConfig.mockResolvedValue({ reject_target: { value: '退回申請人' } });
});

// ── planProceed ─────────────────────────────────────────────────────────────

describe('planProceed', () => {

  const plan = (o) => planProceed({
    currentStep: 1, chainLen: 3, finalSignature: true, rejectTarget: '退回申請人', ...o,
  });

  it('✅ 送出 → 第 1 關', () => {
    expect(plan({ action: '送出', currentStep: 0 })).toMatchObject({ kind: 'advance', nextStep: 1 });
  });

  it('🔑 同意且是最後一個簽名 → 推進一關（狀態名不參與判斷）', () => {
    expect(plan({ action: '同意', currentStep: 1 })).toMatchObject({ kind: 'advance', nextStep: 2 });
  });

  it('🔑 同意但會簽還沒簽完 → stay，指標不動', () => {
    expect(plan({ action: '同意', currentStep: 2, finalSignature: false }))
      .toMatchObject({ kind: 'stay', nextStep: 2 });
  });

  it('✅ 最後一關同意 → terminal（核決）', () => {
    expect(plan({ action: '同意', currentStep: 3 })).toMatchObject({ kind: 'terminal', nextStep: 3 });
  });

  it('✅ 駁回（退回申請人）→ 指標歸零', () => {
    expect(plan({ action: '駁回', currentStep: 2 })).toMatchObject({ kind: 'reset', nextStep: 0 });
  });

  it('✅ 駁回（退回上一關）→ 退一關', () => {
    expect(plan({ action: '駁回', currentStep: 3, rejectTarget: '退回上一關' }))
      .toMatchObject({ kind: 'advance', nextStep: 2 });
  });

  it('✅ 駁回（退回上一關）但已在第 1 關 → 仍回申請人', () => {
    expect(plan({ action: '駁回', currentStep: 1, rejectTarget: '退回上一關' }))
      .toMatchObject({ kind: 'reset', nextStep: 0 });
  });

  it('✅ 再申請 → 指標歸零', () => {
    expect(plan({ action: '再申請', currentStep: 0 })).toMatchObject({ kind: 'reset', nextStep: 0 });
  });

  it('✅ 作廢 → terminal，指標不動', () => {
    expect(plan({ action: '作廢', currentStep: 2 })).toMatchObject({ kind: 'terminal', nextStep: 2 });
  });

  it('🔒 同意但指標超出鏈長 → blocked', () => {
    expect(plan({ action: '同意', currentStep: 9 }).kind).toBe('blocked');
    expect(plan({ action: '同意', currentStep: 0 }).kind).toBe('blocked');
  });

  it('✅ 不認得的動作（各表單自訂的）→ 不干預', () => {
    expect(plan({ action: '列印', currentStep: 2 })).toMatchObject({ kind: 'stay', nextStep: 2 });
  });

});

// ── isFinalSignature：自迴圈帶來的歧義 ──────────────────────────────────────

describe('isFinalSignature', () => {

  const allRow = (signedBy = []) => ({
    value: {
      signing_mode: { value: '全員會簽' },
      signed_by: { value: signedBy.map((code) => ({ code })) },
    },
  });

  it('✅ 任一人簽 → 永遠是最後一簽', () => {
    const anyRow = { value: { signing_mode: { value: '任一人簽' }, signed_by: { value: [] } } };
    expect(isFinalSignature(anyRow, ['a', 'b'], 'a')).toBe(true);
  });

  it('🔑 全員會簽：還有人沒簽 → false（狀態不變不代表關卡結束）', () => {
    // 「會簽中 → 會簽中」既可能是會簽未完，也可能是下一關剛好也是會簽，
    // 狀態分辨不了 → 看簽名是否覆蓋所有執行者
    expect(isFinalSignature(allRow([]), ['a', 'b', 'c'], 'a')).toBe(false);
    expect(isFinalSignature(allRow(['a']), ['a', 'b', 'c'], 'b')).toBe(false);
  });

  it('🔑 全員會簽：最後一個人簽下去 → true', () => {
    expect(isFinalSignature(allRow(['a', 'b']), ['a', 'b', 'c'], 'c')).toBe(true);
  });

  it('✅ 全員會簽：已簽過的人重複按，不會誤判成完成', () => {
    expect(isFinalSignature(allRow(['a']), ['a', 'b'], 'a')).toBe(false);
  });

  it('✅ 執行者名單取不到時保守處理：當成還沒簽完，寧可停著也不跳關', () => {
    expect(isFinalSignature(allRow(['a']), [], 'a')).toBe(false);
  });

});

// ── next_state / reject_state 的計算 ────────────────────────────────────────

describe('nextStateAfter / rejectStateAt', () => {

  const chain = defaultChain();

  it('✅ 下一關是簽核中 → 自迴圈回同一個狀態', () => {
    expect(nextStateAfter(chain, 1)).toBe(APPROVING);
  });

  it('✅ 下一關是經辦 → 經辦人確認中', () => {
    expect(nextStateAfter(chain, 2)).toBe(HANDLER);
  });

  it('✅ 沒有下一關 → 核決', () => {
    expect(nextStateAfter(chain, 3)).toBe(DECIDED);
  });

  it('✅ 退回申請人 → 恆為駁回', () => {
    expect(rejectStateAt(chain, 3, '退回申請人')).toBe(REJECTED);
    expect(rejectStateAt(chain, 1, '退回申請人')).toBe(REJECTED);
  });

  it('✅ 退回上一關 → 上一關的 step_state', () => {
    expect(rejectStateAt(chain, 3, '退回上一關')).toBe(APPROVING); // 第 2 關是簽核中
  });

  it('✅ 退回上一關但已在第 1 關 → 駁回（上一關就是申請人本人）', () => {
    expect(rejectStateAt(chain, 1, '退回上一關')).toBe(REJECTED);
  });

});

// ── 內建欄位定位 ────────────────────────────────────────────────────────────

describe('findBuiltIn / hasAdapterFields / sameMembers / chainRow', () => {

  it('🔑 用型別找內建欄位，不靠欄位代碼（代碼隨 kintone 語言而異）', () => {
    const rec = makeRecord();
    expect(findBuiltIn(rec, 'STATUS').value).toBe(APPROVING);
    expect(findBuiltIn({ ステータス: { type: 'STATUS', value: DECIDED } }, 'STATUS').value).toBe(DECIDED);
    expect(findBuiltIn({}, 'STATUS')).toBeNull();
  });

  it('✅ 六個規約欄位齊全才算數', () => {
    expect(hasAdapterFields(makeRecord())).toBe(true);
    const missing = makeRecord();
    delete missing.next_state;
    expect(hasAdapterFields(missing)).toBe(false);
  });

  it('✅ sameMembers 順序無關', () => {
    expect(sameMembers(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameMembers(['a'], ['a', 'b'])).toBe(false);
  });

  it('✅ chainRow 是 1-based', () => {
    const rec = makeRecord();
    expect(chainRow(rec, 1).value.role_id.value).toBe('ROLE_P1');
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
    r.next_state.value = '';
    return r;
  };

  const builtChain = [
    chainStep(1, 'ROLE_P1', '研發課_職員', ['user.p1']).value,
    chainStep(2, 'ROLE_ACC', '會計_經辦', ['user.acc'], HANDLER).value,
  ];

  it('🔑 草稿送出：寫入鏈、total_steps、current_step=0、第 1 關的人與去向', async () => {
    window.ApprovalRouting.buildChainForForm = vi.fn().mockResolvedValue({
      ok: true, chain: builtChain, error: null,
    });

    const event = { record: draftRecord() };
    await submitHandler(event);

    expect(event.record.approver_chain.value).toBe(builtChain);
    expect(event.record.total_steps.value).toBe('2');
    expect(event.record.current_step.value).toBe('0'); // 送出動作才推到 1
    // kintone 解析執行者與 filterCond 讀的都是按鈕按下前的值，所以這兩個要先放好
    expect(event.record.current_approvers.value).toEqual([{ code: 'user.p1' }]);
    expect(event.record.next_state.value).toBe(APPROVING);
    expect(event.record.reject_state.value).toBe(REJECTED);
  });

  it('✅ 第 1 關是經辦時，next_state 指到經辦人確認中', async () => {
    window.ApprovalRouting.buildChainForForm = vi.fn().mockResolvedValue({
      ok: true, chain: [builtChain[1]], error: null,
    });

    const event = { record: draftRecord() };
    await submitHandler(event);

    expect(event.record.next_state.value).toBe(HANDLER);
  });

  it('✅ forceFresh：正式送出不吃過期快取', async () => {
    window.ApprovalRouting.buildChainForForm = vi.fn().mockResolvedValue({
      ok: true, chain: builtChain, error: null,
    });
    await submitHandler({ record: draftRecord() });
    expect(window.ApprovalRouting.buildChainForForm)
      .toHaveBeenCalledWith('test.user', 1001, { forceFresh: true });
  });

  it('✅ 建鏈失敗 → event.error 擋下儲存', async () => {
    window.ApprovalRouting.buildChainForForm = vi.fn().mockResolvedValue({
      ok: false, chain: [], error: '員工 test.user 未設定起點角色',
    });
    const event = { record: draftRecord() };
    await submitHandler(event);
    expect(event.error).toContain('未設定起點角色');
  });

  it('🔑 鏈再長也不擋——狀態靠自迴圈跑，沒有上限了', async () => {
    // 舊的編號模型要檢查 chain.length > max_depth，固定狀態模型不需要
    window.ApprovalRouting.buildChainForForm = vi.fn().mockResolvedValue({
      ok: true,
      chain: Array.from({ length: 15 }, (_, i) => chainStep(i + 1, `ROLE_${i}`, `第${i}關`, ['u']).value),
      error: null,
    });

    const event = { record: draftRecord() };
    await submitHandler(event);

    expect(event.error).toBeUndefined();
    expect(event.record.total_steps.value).toBe('15');
  });

  it('✅ 非草稿狀態不重算（已簽過的關卡不能被洗掉）', async () => {
    window.ApprovalRouting.buildChainForForm = vi.fn();
    await submitHandler({ record: makeRecord({ status: APPROVING }) });
    expect(window.ApprovalRouting.buildChainForForm).not.toHaveBeenCalled();
  });

  it('✅ App 沒埋齊規約欄位 → 整支停用，不半殘地跑', async () => {
    window.ApprovalRouting.buildChainForForm = vi.fn();
    const event = { record: { 狀態: { type: 'STATUS', value: '草稿' } } };
    await submitHandler(event);
    expect(window.ApprovalRouting.buildChainForForm).not.toHaveBeenCalled();
    expect(event.error).toBeUndefined();
  });

});

// ── process.proceed ────────────────────────────────────────────────────────

describe('process.proceed', () => {

  const evt = (action, recOpts = {}) => ({
    appId: 1001,
    record: makeRecord(recOpts),
    action: { value: action },
  });

  it('🔑 自迴圈推進：簽核中的第 1 關同意 → 第 2 關，next_state 仍是簽核中', async () => {
    const event = evt('同意', { currentStep: 1 });
    await proceedHandler(event);

    expect(event.record.current_step.value).toBe('2');
    expect(event.record.current_approvers.value).toEqual([{ code: 'holder.ROLE_P2' }]);
    expect(event.record.next_state.value).toBe(HANDLER); // 第 3 關是經辦
  });

  it('✅ 倒數第二關同意 → next_state 變核決', async () => {
    const event = evt('同意', { currentStep: 2 });
    await proceedHandler(event);

    expect(event.record.current_step.value).toBe('3');
    expect(event.record.next_state.value).toBe(DECIDED);
  });

  it('✅ 最後一關同意 → 執行者與去向清空', async () => {
    const event = evt('同意', { currentStep: 3 });
    await proceedHandler(event);

    expect(event.record.current_approvers.value).toEqual([]);
    expect(event.record.next_state.value).toBe('');
  });

  it('🔑 全員會簽未簽完：只記簽名，指標與去向都不動', async () => {
    const chain = defaultChain();
    chain[1].value.signing_mode.value = '全員會簽';
    chain[1].value.step_state.value = COSIGNING;

    const event = evt('同意', { currentStep: 2, chain, assignees: ['a', 'b'] });
    await proceedHandler(event);

    expect(event.record.current_step.value).toBe('2');
    expect(event.record.approver_chain.value[1].value.signed_by.value)
      .toEqual([{ code: 'test.user' }]);
  });

  it('🔑 全員會簽最後一人簽完 → 推進', async () => {
    const chain = defaultChain();
    chain[1].value.signing_mode.value = '全員會簽';
    chain[1].value.step_state.value = COSIGNING;
    chain[1].value.signed_by.value = [{ code: 'other.user' }];

    const event = evt('同意', {
      currentStep: 2, chain, assignees: ['other.user', 'test.user'],
    });
    await proceedHandler(event);

    expect(event.record.current_step.value).toBe('3');
  });

  it('✅ 簽名不重複記同一人', async () => {
    const event = evt('同意', { currentStep: 1 });
    await proceedHandler(event);
    await proceedHandler(event);
    expect(event.record.approver_chain.value[0].value.signed_by.value)
      .toEqual([{ code: 'test.user' }]);
  });

  it('✅ 駁回（退回申請人）→ 指標歸零、執行者與去向清空', async () => {
    const event = evt('駁回', { currentStep: 2 });
    await proceedHandler(event);

    expect(event.record.current_step.value).toBe('0');
    expect(event.record.current_approvers.value).toEqual([]);
    expect(event.record.next_state.value).toBe('');
  });

  it('✅ 駁回（退回上一關）→ 退一關並重算該關的人與去向', async () => {
    getRouteConfig.mockResolvedValue({ reject_target: { value: '退回上一關' } });

    const event = evt('駁回', { currentStep: 3 });
    await proceedHandler(event);

    expect(event.record.current_step.value).toBe('2');
    expect(event.record.current_approvers.value).toEqual([{ code: 'holder.ROLE_P2' }]);
    expect(event.record.next_state.value).toBe(HANDLER);
  });

  it('✅ 駁回不記簽名', async () => {
    const event = evt('駁回', { currentStep: 2 });
    await proceedHandler(event);
    expect(event.record.approver_chain.value[1].value.signed_by.value).toEqual([]);
  });

  it('🔒 指標超出鏈長 → event.error 擋下，不動任何欄位', async () => {
    const event = evt('同意', { currentStep: 9 });
    await proceedHandler(event);

    expect(event.error).toContain('關卡指標異常');
    expect(event.record.current_step.value).toBe('9');
  });

  it('✅ 下一關沒有簽核者 → 擋下並說明是哪一關', async () => {
    getRole.mockImplementation(async (id) =>
      id === 'ROLE_P2' ? roleRec(id, '') : roleRec(id, 'someone'));

    const event = evt('同意', { currentStep: 1 });
    await proceedHandler(event);

    expect(event.error).toContain('研發課_課長');
    expect(event.error).toContain('沒有任何簽核者');
  });

  it('🔑 即時解析：角色換人後，跑到那一關拿到的是新的人', async () => {
    getRole.mockImplementation(async (id) =>
      id === 'ROLE_P2' ? roleRec(id, 'new.manager') : roleRec(id, 'whoever'));

    const event = evt('同意', { currentStep: 1 });
    await proceedHandler(event);

    // 子表格快照寫的是 user.p2，實際拿到的是角色表上現在的人
    expect(event.record.current_approvers.value).toEqual([{ code: 'new.manager' }]);
  });

});
