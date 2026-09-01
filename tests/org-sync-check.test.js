/**
 * tools/11-org-sync-check.js 的純函式單元測試
 *
 * 載入策略：先載 core/08-directory（11 會解構它）→ import IIFE → 掛上 OrgSyncInternals
 * UI 與 API 呼叫不在測試範圍，只測「比對 → 分類 → 寫入計畫」這條主線，
 * 因為分類判錯的代價是斷鏈（就地改名 vs 換人接手，改法完全相反）。
 */
import { describe, it, expect } from 'vitest';

await import('../core/08-directory.js');
await import('../tools/11-org-sync-check.js');

const I = () => window.ApprovalRouting.OrgSyncInternals;

/** 685 記錄（工具內部形狀，不是 kintone record） */
const mkRec = ({
  recordId = '1', roleId = 'ROLE_0001', unitName = '業務部', titleLevel = '課長',
  holderCode = 'u1', holderName = '王一', nextRoleId = 'ROLE_0002',
  isChainEnd = false, signingMode = '任一人簽', roleName,
}) => ({
  recordId, roleId, roleName: roleName ?? `${unitName} - ${titleLevel}`,
  unitName, titleLevel, holderType: '指定個人', holderCode, holderName,
  nextRoleId, isChainEnd, signingMode,
});

/** 後台身分（已對應完 685 選項的形狀） */
const id = (unit, title) => ({ rawUnit: unit, rawTitle: title, unit, title, titleExact: true });

describe('tools/11 載入', () => {
  it('IIFE 執行後掛上 OrgSyncInternals', () => {
    expect(I()).toBeDefined();
  });
});

describe('mapIdentities', () => {
  it('後台單位要完全相同才對得上，職務可由結尾推測', () => {
    const out = I().mapIdentities(
      [{ unit: '業務部', title: '資訊本部長' }],
      ['業務部', '資訊部'],
      ['課長', '部長', '本部長'],
    );
    expect(out[0].unit).toBe('業務部');
    expect(out[0].title).toBe('本部長');      // 不是「部長」
    expect(out[0].titleExact).toBe(false);
  });

  it('單位不在 685 選項裡就留空，不亂配到隔壁單位', () => {
    const out = I().mapIdentities([{ unit: '倉儲（TEPZ）', title: '課長' }], ['倉儲'], ['課長']);
    expect(out[0].unit).toBe('');
    expect(out[0].title).toBe('課長');
  });
});

describe('diffRecord', () => {
  it('完全相符', () => {
    expect(I().diffRecord(mkRec({}), [id('業務部', '課長')]).status).toBe('match');
  });

  it('兼任者只要有一組身分相符就算相符', () => {
    const r = I().diffRecord(mkRec({}), [id('資訊部', '擔當'), id('業務部', '課長')]);
    expect(r.status).toBe('match');
  });

  it('單位對得上、職稱不同 → 職稱異動，目標留在原單位', () => {
    const r = I().diffRecord(mkRec({}), [id('業務部', '部長')]);
    expect(r.status).toBe('title');
    expect(r.target).toEqual({ unit: '業務部', title: '部長' });
  });

  it('職稱對得上、單位不同 → 單位異動，目標留在原職稱', () => {
    const r = I().diffRecord(mkRec({}), [id('資訊部', '課長')]);
    expect(r.status).toBe('unit');
    expect(r.target).toEqual({ unit: '資訊部', title: '課長' });
  });

  it('單位職稱都不同 → both', () => {
    const r = I().diffRecord(mkRec({}), [id('資訊部', '部長')]);
    expect(r.status).toBe('both');
    expect(r.target).toEqual({ unit: '資訊部', title: '部長' });
  });

  it('後台查無組織 → no_identity，不給目標', () => {
    const r = I().diffRecord(mkRec({}), []);
    expect(r.status).toBe('no_identity');
    expect(r.target).toBeNull();
  });

  it('後台有資料但對不到 685 選項 → unmapped，不給目標', () => {
    const r = I().diffRecord(mkRec({}), [{ rawUnit: '倉儲（TEPZ）', rawTitle: 'PM', unit: '', title: '' }]);
    expect(r.status).toBe('unmapped');
    expect(r.target).toBeNull();
  });
});

describe('classifyDiffs', () => {
  const diffOf = (rec, target, status = 'unit') => ({ record: rec, status, target });

  it('整個單位的人都指向同一個新單位 → 判為單位改名', () => {
    const a = mkRec({ recordId: '1', roleId: 'ROLE_0001', titleLevel: '課長', holderCode: 'u1' });
    const b = mkRec({ recordId: '2', roleId: 'ROLE_0002', titleLevel: '擔當', holderCode: 'u2' });
    const { unitRenames, personMoves } = I().classifyDiffs([
      diffOf(a, { unit: '業務一部', title: '課長' }),
      diffOf(b, { unit: '業務一部', title: '擔當' }),
    ]);
    expect(unitRenames).toHaveLength(1);
    expect(unitRenames[0]).toMatchObject({ fromUnit: '業務部', toUnit: '業務一部' });
    expect(personMoves).toHaveLength(0);
  });

  it('同單位還有人對得上舊設定 → 不是改名，是人動了', () => {
    const a = mkRec({ recordId: '1', holderCode: 'u1' });
    const b = mkRec({ recordId: '2', titleLevel: '擔當', holderCode: 'u2' });
    const { unitRenames, personMoves } = I().classifyDiffs([
      diffOf(a, { unit: '資訊部', title: '課長' }),
      { record: b, status: 'match', target: null },
    ]);
    expect(unitRenames).toHaveLength(0);
    expect(personMoves).toHaveLength(1);
    expect(personMoves[0].record.recordId).toBe('1');
  });

  it('同單位的人各奔東西 → 不是改名', () => {
    const a = mkRec({ recordId: '1', holderCode: 'u1' });
    const b = mkRec({ recordId: '2', titleLevel: '擔當', holderCode: 'u2' });
    const { unitRenames, personMoves } = I().classifyDiffs([
      diffOf(a, { unit: '資訊部', title: '課長' }),
      diffOf(b, { unit: '財務部', title: '擔當' }),
    ]);
    expect(unitRenames).toHaveLength(0);
    expect(personMoves).toHaveLength(2);
  });

  it('同一關的人全部指向同一組新單位職稱 → 判為關卡改名', () => {
    const a = mkRec({ recordId: '1', holderCode: 'u1' });
    const b = mkRec({ recordId: '2', recordName: '', holderCode: 'u2' });
    // 同單位還有別的關卡對得上，所以不會先被判成單位改名
    const other = mkRec({ recordId: '3', titleLevel: '擔當', holderCode: 'u3' });
    const { unitRenames, stepRenames, personMoves } = I().classifyDiffs([
      diffOf(a, { unit: '業務部', title: '副理' }, 'title'),
      diffOf(b, { unit: '業務部', title: '副理' }, 'title'),
      { record: other, status: 'match', target: null },
    ]);
    expect(unitRenames).toHaveLength(0);
    expect(stepRenames).toHaveLength(1);
    expect(stepRenames[0]).toMatchObject({ fromTitle: '課長', toTitle: '副理', toUnit: '業務部' });
    expect(personMoves).toHaveLength(0);
  });

  it('關卡只有一個人不符 → 人員異動（單筆無從分辨改名或升遷，一律走安全的換人）', () => {
    const a = mkRec({ recordId: '1', holderCode: 'u1' });
    const other = mkRec({ recordId: '2', titleLevel: '擔當', holderCode: 'u2' });
    const { unitRenames, stepRenames, personMoves } = I().classifyDiffs([
      diffOf(a, { unit: '業務部', title: '部長' }, 'title'),
      { record: other, status: 'match', target: null },
    ]);
    expect(unitRenames).toHaveLength(0);
    expect(stepRenames).toHaveLength(0);
    expect(personMoves).toHaveLength(1);
  });

  it('沒有目標的（後台無資料／對不到選項）歸入無法判定', () => {
    const a = mkRec({ recordId: '1', holderCode: 'u1' });
    const { personMoves, undecidable } = I().classifyDiffs([
      { record: a, status: 'no_identity', target: null },
    ]);
    expect(personMoves).toHaveLength(0);
    expect(undecidable).toHaveLength(1);
  });

  it('相符的記錄不會被列進任何待處理分類', () => {
    const a = mkRec({ recordId: '1', holderCode: 'u1' });
    const out = I().classifyDiffs([{ record: a, status: 'match', target: null }]);
    expect(out.unitRenames).toHaveLength(0);
    expect(out.stepRenames).toHaveLength(0);
    expect(out.personMoves).toHaveLength(0);
    expect(out.undecidable).toHaveLength(0);
  });
});

describe('detectNameClash', () => {
  it('改名後撞到既有關卡且下一關不同 → 標為衝突', () => {
    const target = mkRec({ recordId: '1', nextRoleId: 'ROLE_0009' });
    const existing = mkRec({ recordId: '2', unitName: '業務部', titleLevel: '副理', nextRoleId: 'ROLE_0010' });
    const out = I().detectNameClash([target], [target, existing], '業務部', '副理');
    expect(out.clash).toBe(true);
    expect(out.nextConflict).toBe(true);
  });

  it('撞名但下一關一致 → 不算衝突', () => {
    const target = mkRec({ recordId: '1', nextRoleId: 'ROLE_0009' });
    const existing = mkRec({ recordId: '2', unitName: '業務部', titleLevel: '副理', nextRoleId: 'ROLE_0009' });
    const out = I().detectNameClash([target], [target, existing], '業務部', '副理');
    expect(out.clash).toBe(true);
    expect(out.nextConflict).toBe(false);
  });

  it('沒有既有關卡 → 不撞名', () => {
    const target = mkRec({ recordId: '1' });
    expect(I().detectNameClash([target], [target], '新單位', '副理').clash).toBe(false);
  });
});

describe('findInboundRefs', () => {
  it('列出指著這個 role_id 的上游角色與 686 起點', () => {
    const me = mkRec({ recordId: '1', roleId: 'ROLE_0005' });
    const up = mkRec({ recordId: '2', roleId: 'ROLE_0004', nextRoleId: 'ROLE_0005' });
    const out = I().findInboundRefs(
      [me, up],
      [{ recordId: 'e1', employee: 'u9', entryRoleId: 'ROLE_0005' },
        { recordId: 'e2', employee: 'u8', entryRoleId: 'ROLE_0001' }],
      'ROLE_0005',
    );
    expect(out.inboundRoles.map((r) => r.roleId)).toEqual(['ROLE_0004']);
    expect(out.inboundEntries.map((e) => e.recordId)).toEqual(['e1']);
  });
});

describe('planRename', () => {
  it('只改單位時不碰 title_level', () => {
    const [put] = I().planRename([mkRec({ recordId: '7' })], { unit: '業務一部', title: null });
    expect(put.id).toBe('7');
    expect(put.record.unit_name).toEqual({ value: '業務一部' });
    expect(put.record.title_level).toBeUndefined();
  });

  it('關卡改名時兩個欄位一起寫', () => {
    const [put] = I().planRename([mkRec({ recordId: '7' })], { unit: '業務部', title: '副理' });
    expect(put.record).toEqual({ unit_name: { value: '業務部' }, title_level: { value: '副理' } });
  });
});

describe('planPersonMove', () => {
  const record = mkRec({ recordId: '10', roleId: 'ROLE_0005', nextRoleId: 'ROLE_0006' });
  const target = { unit: '業務部', title: '部長' };
  const template = mkRec({ recordId: '20', roleId: 'ROLE_0007', unitName: '業務部', titleLevel: '部長', nextRoleId: 'ROLE_0008', signingMode: '全員會簽' });

  it('有接任者：舊記錄換人、role_id 不動', () => {
    const { puts, posts } = I().planPersonMove({
      record, target, successor: { code: 'u9', name: '李四' }, template,
      newRoleId: 'ROLE_0099',
    });
    expect(puts).toHaveLength(1);
    expect(puts[0]).toEqual({ id: '10', record: { holder_user: { value: [{ code: 'u9' }] } } });
    expect(posts[0].role_id).toEqual({ value: 'ROLE_0099' });
    expect(posts[0].holder_user).toEqual({ value: [{ code: 'u1' }] });
  });

  it('沒有接任者：舊記錄取消啟用中（不刪除）', () => {
    const { puts } = I().planPersonMove({
      record, target, successor: null, template, newRoleId: 'ROLE_0099',
    });
    expect(puts[0].record.is_active).toEqual({ value: [] });
    expect(puts[0].record.holder_user).toBeUndefined();
  });

  it('掛到既有關卡：沿用該關的下一關與簽核模式', () => {
    const { posts } = I().planPersonMove({
      record, target, successor: null, template, newRoleId: 'ROLE_0099',
    });
    expect(posts[0].next_role_id).toEqual({ value: 'ROLE_0008' });
    expect(posts[0].is_chain_end).toEqual({ value: [] });
    expect(posts[0].signing_mode).toEqual({ value: '全員會簽' });
  });

  it('既有關卡是終點：新記錄一樣是終點、不寫下一關', () => {
    const endTpl = { ...template, isChainEnd: true, nextRoleId: '' };
    const { posts } = I().planPersonMove({
      record, target, successor: null, template: endTpl, newRoleId: 'ROLE_0099',
    });
    expect(posts[0].is_chain_end).toEqual({ value: ['是終點'] });
    expect(posts[0].next_role_id).toEqual({ value: '' });
  });

  it('新建關卡：用 HR 指定的下一關，選終點時寫終點', () => {
    const a = I().planPersonMove({
      record, target, successor: null, template: null, newRoleId: 'ROLE_0099', nextValue: 'ROLE_0030',
    });
    expect(a.posts[0].next_role_id).toEqual({ value: 'ROLE_0030' });
    expect(a.posts[0].signing_mode).toEqual({ value: '任一人簽' });

    const b = I().planPersonMove({
      record, target, successor: null, template: null, newRoleId: 'ROLE_0099',
      nextValue: I().CHAIN_END_VALUE,
    });
    expect(b.posts[0].is_chain_end).toEqual({ value: ['是終點'] });
  });

  it('686 起點指著舊關卡才改指，指別處的不動', () => {
    const { entryPuts } = I().planPersonMove({
      record, target, successor: null, template, newRoleId: 'ROLE_0099',
      ownEntries: [
        { recordId: 'e1', employee: 'u1', entryRoleId: 'ROLE_0005' },
        { recordId: 'e2', employee: 'u1', entryRoleId: 'ROLE_0001' },
      ],
    });
    expect(entryPuts).toEqual([{ id: 'e1', record: { entry_role_id: { value: 'ROLE_0099' } } }]);
  });

  it('role_id 一律補到 4 碼', () => {
    expect(I().makeRoleId(7)).toBe('ROLE_0007');
    expect(I().makeRoleId(1234)).toBe('ROLE_1234');
  });
});
