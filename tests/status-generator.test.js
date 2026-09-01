/**
 * tools/10-status-generator.js 的純函式測試
 *
 * 範圍：狀態圖產生、驗證、部署指紋、舊編號狀態偵測。
 * UI（SweetAlert 流程、按鈕）與 REST 呼叫不在此範圍。
 *
 * 核心不變式：**除了「可作廢群組」之外，產出對每一張表單完全相同**。
 * 關卡有幾關、走哪種段，都不影響狀態圖——那是 adapter 靠 next_state 決定的。
 */
import { describe, it, expect } from 'vitest';

await import('../tools/10-status-generator.js');

const {
  buildStatusJson,
  validateStatusPayload,
  hashStatusPayload,
  findLegacyNumberedStates,
  STATE_ORDER,
} = window.ApprovalRouting.StatusGeneratorInternals;

const DRAFT = '草稿';
const APPROVING = '簽核中';
const HANDLER = '經辦人確認中';
const COSIGNING = '會簽中';
const REJECTED = '駁回';
const DECIDED = '核決';
const CANCELLED = '作廢';

/** 取某個動作的 from→to[條件] 精簡表示 */
const sigs = (payload, name) =>
  payload.actions.filter((a) => a.name === name).map((a) => `${a.from}→${a.to}[${a.filterCond}]`);

const build = (o) => buildStatusJson(o).payload;

// ── 狀態 ────────────────────────────────────────────────────────────────────

describe('buildStatusJson — 狀態', () => {

  it('✅ 固定 7 個狀態，index 從 0 連續', () => {
    const p = build();
    expect(Object.keys(p.states)).toEqual([
      DRAFT, APPROVING, HANDLER, COSIGNING, REJECTED, DECIDED, CANCELLED,
    ]);
    expect(Object.values(p.states).map((s) => s.index)).toEqual(['0', '1', '2', '3', '4', '5', '6']);
  });

  it('🔑 三個簽核狀態的執行者掛 current_approvers（FIELD_ENTITY，不是 CUSTOM_FIELD）', () => {
    const p = build();
    for (const name of [APPROVING, HANDLER, COSIGNING]) {
      expect(p.states[name].assignee.entities).toEqual([
        { entity: { type: 'FIELD_ENTITY', code: 'current_approvers' }, includeSubs: false },
      ]);
    }
  });

  it('🔑 初始狀態（index 0）：type 必須 ONE、執行者必須留空 — kintone 平台規則', () => {
    // 實測打出來的兩條：
    //   ①「初始狀態下，執行者的type只能指定為『ONE』。」
    //   ②「初始狀態下，執行者需為空、或指定為記錄的建立人欄位。」← CREATOR 不被接受
    const p = build();
    expect(p.states[DRAFT].index).toBe('0');
    expect(p.states[DRAFT].assignee.type).toBe('ONE');
    expect(p.states[DRAFT].assignee.entities).toEqual([]);
  });

  it('🔑 任一人簽用 ANY（ONE 是「指定一人」，名字騙人）；會簽中才是 ALL', () => {
    const p = build();
    expect(p.states[APPROVING].assignee.type).toBe('ANY');
    expect(p.states[HANDLER].assignee.type).toBe('ANY');
    expect(p.states[COSIGNING].assignee.type).toBe('ALL');
  });

  it('✅ 終態不設執行者；駁回掛 CREATOR（申請人要能再申請）', () => {
    const p = build();
    expect(p.states[DECIDED].assignee.entities).toEqual([]);
    expect(p.states[CANCELLED].assignee.entities).toEqual([]);
    // 駁回不是初始狀態，CREATOR 可用（實測驗證通過，未被 kintone 挑錯）
    expect(p.states[REJECTED].assignee.entities).toEqual([
      { entity: { type: 'CREATOR' }, includeSubs: false },
    ]);
  });

});

// ── 動作 ────────────────────────────────────────────────────────────────────

describe('buildStatusJson — 動作', () => {

  it('🔑 同意：三個簽核狀態各自可去三個簽核狀態或核決，含自迴圈', () => {
    const p = build();
    expect(sigs(p, '同意')).toEqual([
      '簽核中→簽核中[next_state in ("簽核中")]',                 // ← 自迴圈，鏈靠它跑完
      '簽核中→經辦人確認中[next_state in ("經辦人確認中")]',
      '簽核中→會簽中[next_state in ("會簽中")]',
      '簽核中→核決[next_state in ("核決")]',
      '經辦人確認中→簽核中[next_state in ("簽核中")]',
      '經辦人確認中→經辦人確認中[next_state in ("經辦人確認中")]',
      '經辦人確認中→會簽中[next_state in ("會簽中")]',
      '經辦人確認中→核決[next_state in ("核決")]',
      '會簽中→簽核中[next_state in ("簽核中")]',
      '會簽中→經辦人確認中[next_state in ("經辦人確認中")]',
      '會簽中→會簽中[next_state in ("會簽中")]',
      '會簽中→核決[next_state in ("核決")]',
    ]);
  });

  it('✅ 送出：草稿 → 第 1 關所在的狀態（三種可能，由 next_state 分流）', () => {
    expect(sigs(build(), '送出')).toEqual([
      '草稿→簽核中[next_state in ("簽核中")]',
      '草稿→經辦人確認中[next_state in ("經辦人確認中")]',
      '草稿→會簽中[next_state in ("會簽中")]',
    ]);
  });

  it('✅ 駁回：看 reject_state，支援退回申請人與退回上一關兩種', () => {
    const p = build();
    const r = sigs(p, '駁回');
    expect(r).toHaveLength(12); // 3 個來源 × 4 個去向
    expect(r).toContain('簽核中→駁回[reject_state in ("駁回")]');
    expect(r).toContain('經辦人確認中→簽核中[reject_state in ("簽核中")]'); // 退回上一關
  });

  it('✅ 再申請：駁回 → 草稿', () => {
    expect(sigs(build(), '再申請')).toEqual(['駁回→草稿[]']);
  });

  it('✅ 作廢掛在每個非終態，SECONDARY，限定群組', () => {
    const p = build({ cancelGroups: [{ code: 'g_admin' }] });
    const cancels = p.actions.filter((a) => a.name === '作廢');
    expect(cancels.map((a) => a.from)).toEqual([DRAFT, APPROVING, HANDLER, COSIGNING, REJECTED]);
    expect(cancels.every((a) => a.type === 'SECONDARY')).toBe(true);
    expect(cancels[0].executableUser).toEqual({
      entities: [{ entity: { type: 'GROUP', code: 'g_admin' }, includeSubs: false }],
    });
  });

  it('🔑 沒設作廢群組 → 完全不產生作廢動作', () => {
    // kintone 規定 SECONDARY 動作的 executableUser 必填（實測，官方文件未載明）。
    // 省略它會被拒；而作廢不可逆，硬給一個「誰都能按」的版本更糟 → 直接不產生。
    expect(build().actions.some((a) => a.name === '作廢')).toBe(false);
    expect(buildStatusJson({ cancelGroups: [] }).hasCancel).toBe(false);
    expect(buildStatusJson({ cancelGroups: [{ code: 'g' }] }).hasCancel).toBe(true);
  });

  it('✅ 簽核者只看到「同意」與「駁回」兩種按鈕', () => {
    const p = build();
    const fromApproving = new Set(
      p.actions.filter((a) => a.from === APPROVING && a.type === 'PRIMARY').map((a) => a.name)
    );
    expect([...fromApproving].sort()).toEqual(['同意', '駁回']);
  });

});

// ── 常數性：狀態圖與路由無關 ────────────────────────────────────────────────

describe('狀態圖是常數', () => {

  it('🔑 兩張表單只要作廢群組相同，狀態圖逐字元相同', () => {
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });

  it('✅ 只有作廢群組會讓產出不同', () => {
    const a = build({ cancelGroups: [{ code: 'g_a' }] });
    const b = build({ cancelGroups: [{ code: 'g_b' }] });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    // 差異只在作廢動作，狀態完全一樣
    expect(JSON.stringify(a.states)).toBe(JSON.stringify(b.states));
  });

  it('✅ STATE_ORDER 決定畫面順序，共 7 個', () => {
    expect(STATE_ORDER).toHaveLength(7);
  });

});

// ── 驗證 ────────────────────────────────────────────────────────────────────

describe('validateStatusPayload', () => {

  it('✅ 正常產出無錯（含自迴圈，不該被誤判）', () => {
    expect(validateStatusPayload(build())).toEqual([]);
    expect(validateStatusPayload(build({ cancelGroups: [{ code: 'g' }] }))).toEqual([]);
  });

  it('✅ from 指向不存在的狀態 → 錯', () => {
    const p = build();
    p.actions.push({ name: '亂搞', from: '不存在的狀態', to: DECIDED, filterCond: '', type: 'PRIMARY' });
    expect(validateStatusPayload(p).join()).toContain('來源狀態「不存在的狀態」不存在');
  });

  it('✅ 兩條同名動作都沒有條件 → 錯（按鈕行為不可預期）', () => {
    const p = build();
    p.actions.push({ name: '同意', from: APPROVING, to: DECIDED, filterCond: '', type: 'PRIMARY' });
    p.actions.push({ name: '同意', from: APPROVING, to: CANCELLED, filterCond: '', type: 'PRIMARY' });
    expect(validateStatusPayload(p).join()).toContain('沒有條件的同名動作');
  });

  it('✅ 同名動作的條件重複 → 錯（兩條會同時成立）', () => {
    const p = build();
    p.actions.push({
      name: '同意', from: APPROVING, to: CANCELLED,
      filterCond: 'next_state in ("核決")', type: 'PRIMARY',
    });
    expect(validateStatusPayload(p).join()).toContain('重複的條件');
  });

  it('✅ 非終態沒有出路 → 錯（單子會卡死）', () => {
    const p = build();
    p.states['孤島'] = { name: '孤島', index: '7', assignee: { type: 'ANY', entities: [] } };
    expect(validateStatusPayload(p).join()).toContain('「孤島」沒有任何出路');
  });

  it('✅ 終態有向外的動作 → 錯', () => {
    const p = build();
    p.actions.push({ name: '復活', from: DECIDED, to: DRAFT, filterCond: '', type: 'PRIMARY' });
    expect(validateStatusPayload(p).join()).toContain('終態「核決」不應該有向外的動作');
  });

  it('🔑 初始狀態 type 不是 ONE → 錯（PUT 前就擋下，不要讓 kintone 回 400）', () => {
    const p = build();
    p.states[DRAFT].assignee.type = 'ANY';
    expect(validateStatusPayload(p).join()).toContain('只能是 ONE');
  });

  it('🔑 初始狀態掛 CREATOR → 錯（kintone 只接受留空或建立人欄位）', () => {
    const p = build();
    p.states[DRAFT].assignee.entities = [{ entity: { type: 'CREATOR' }, includeSubs: false }];
    expect(validateStatusPayload(p).join()).toContain('建立人欄位');
  });

  it('🔑 SECONDARY 動作沒帶 executableUser → 錯', () => {
    const p = build();
    p.actions.push({ name: '作廢', from: APPROVING, to: CANCELLED, filterCond: '', type: 'SECONDARY' });
    expect(validateStatusPayload(p).join()).toContain('必須指定 executableUser');
  });

  it('✅ 有作廢群組時的完整產出仍然無錯', () => {
    expect(validateStatusPayload(build({ cancelGroups: [{ code: 'g_admin' }] }))).toEqual([]);
  });

  it('✅ index 不連續 → 錯', () => {
    const p = build();
    p.states[DRAFT].index = '9';
    expect(validateStatusPayload(p).join()).toContain('index 不連續');
  });

});

// ── 部署指紋 ────────────────────────────────────────────────────────────────

describe('hashStatusPayload', () => {

  it('✅ 相同狀態圖 → 相同雜湊', () => {
    expect(hashStatusPayload(build())).toBe(hashStatusPayload(build()));
  });

  it('✅ 作廢群組不同 → 雜湊不同', () => {
    expect(hashStatusPayload(build({ cancelGroups: [{ code: 'g_a' }] })))
      .not.toBe(hashStatusPayload(build({ cancelGroups: [{ code: 'g_b' }] })));
  });

  it('✅ 模板改了 → 雜湊變（偵測「模板改版但這個 App 沒重新部署」）', () => {
    const p = build();
    const before = hashStatusPayload(p);
    p.actions.push({ name: '新動作', from: APPROVING, to: DECIDED, filterCond: 'x', type: 'PRIMARY' });
    expect(hashStatusPayload(p)).not.toBe(before);
  });

  it('✅ 輸出 8 碼十六進位', () => {
    expect(hashStatusPayload(build())).toMatch(/^[0-9a-f]{8}$/);
  });

});

// ── 舊編號狀態偵測 ──────────────────────────────────────────────────────────

describe('findLegacyNumberedStates', () => {

  it('🔑 掃出舊模型殘留的「簽核中(n)」——它們在新模板不存在，部署等同要刪掉', () => {
    const states = {
      草稿: {}, '簽核中(1)': {}, '簽核中(2)': {}, 核准: {},
    };
    expect(findLegacyNumberedStates(states)).toEqual(['簽核中(1)', '簽核中(2)']);
  });

  it('✅ 新模板的「簽核中」不會被誤判', () => {
    expect(findLegacyNumberedStates(build().states)).toEqual([]);
  });

  it('✅ 空的／未定義都回空陣列', () => {
    expect(findLegacyNumberedStates({})).toEqual([]);
    expect(findLegacyNumberedStates(undefined)).toEqual([]);
  });

});
