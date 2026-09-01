/**
 * tools/05-coverage-check.js 的純函式單元測試
 *
 * 載入策略：先載 core/08-directory（05 會解構它）→ import IIFE → 掛上 CoverageInternals
 * UI 與 API 呼叫不在此測試範圍，只測分組、配對與起點鏈完整性這幾段純邏輯。
 */
import { describe, it, expect } from 'vitest';

// 05 解構 core/08-directory 的共用函式，必須先載入
await import('../core/08-directory.js');
await import('../tools/05-coverage-check.js');

const Internals = () => window.ApprovalRouting.CoverageInternals;

describe('tools/05 載入', () => {
  it('IIFE 執行後掛上 CoverageInternals', () => {
    expect(Internals()).toBeDefined();
  });
});

const mkUser = (code, name, jobTitle, units) => ({ code, name, jobTitle, units });

describe('groupNoEntryUsers', () => {
  it('同單位同職稱的人歸成一組', () => {
    const { groups, exceptions } = Internals().groupNoEntryUsers([
      mkUser('a1', '王一', '課員', ['海運貨物']),
      mkUser('a2', '王二', '課員', ['海運貨物']),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].unit).toBe('海運貨物');
    expect(groups[0].title).toBe('課員');
    expect(groups[0].members.map((m) => m.code)).toEqual(['a1', 'a2']);
    expect(exceptions).toHaveLength(0);
  });

  it('同單位不同職稱分成不同組', () => {
    const { groups } = Internals().groupNoEntryUsers([
      mkUser('a1', '王一', '課員', ['海運貨物']),
      mkUser('a2', '王二', '課長', ['海運貨物']),
    ]);
    expect(groups).toHaveLength(2);
    // 排序用 localeCompare('zh-Hant')，實際順序取決於執行環境的 ICU collation，
    // 這裡只驗證「不同職稱要分成不同組」，不綁定特定排序規則
    expect(new Set(groups.map((g) => g.title))).toEqual(new Set(['課員', '課長']));
  });

  it('兼任多單位的人進例外區', () => {
    const { groups, exceptions } = Internals().groupNoEntryUsers([
      mkUser('a1', '王一', '課長', ['海運貨物', '業務部']),
    ]);
    expect(groups).toHaveLength(0);
    expect(exceptions.map((u) => u.code)).toEqual(['a1']);
  });

  it('職稱有多個（以、串接）的人進例外區', () => {
    const { groups, exceptions } = Internals().groupNoEntryUsers([
      mkUser('a1', '王一', '課長、專員', ['海運貨物']),
    ]);
    expect(groups).toHaveLength(0);
    expect(exceptions.map((u) => u.code)).toEqual(['a1']);
  });

  it('沒有職稱的人進例外區', () => {
    const { groups, exceptions } = Internals().groupNoEntryUsers([
      mkUser('a1', '王一', '', ['海運貨物']),
    ]);
    expect(groups).toHaveLength(0);
    expect(exceptions.map((u) => u.code)).toEqual(['a1']);
  });

  it('單位是（未分類）的人進例外區，不會被綁成同一組', () => {
    const { groups, exceptions } = Internals().groupNoEntryUsers([
      mkUser('a1', '王一', '課員', ['（未分類）']),
      mkUser('a2', '王二', '課員', ['（未分類）']),
    ]);
    expect(groups).toHaveLength(0);
    expect(exceptions).toHaveLength(2);
  });

  it('分組與例外互斥，人數加總等於輸入人數', () => {
    const users = [
      mkUser('a1', '王一', '課員', ['海運貨物']),
      mkUser('a2', '王二', '課員', ['海運貨物']),
      mkUser('a3', '王三', '課長', ['海運貨物', '業務部']),
      mkUser('a4', '王四', '', ['業務部']),
    ];
    const { groups, exceptions } = Internals().groupNoEntryUsers(users);
    const total = groups.reduce((n, g) => n + g.members.length, 0) + exceptions.length;
    expect(total).toBe(users.length);

    const codes = [...groups.flatMap((g) => g.members.map((m) => m.code)),
                   ...exceptions.map((u) => u.code)];
    expect(new Set(codes).size).toBe(users.length);
  });
});

const mkRole = (recordId, roleId, roleName, unitName, titleLevel, nextRoleId = '') =>
  ({ recordId, roleId, roleName, unitName, titleLevel, nextRoleId,
     holderType: '指定個人', holderUsers: [] });

describe('matchEntryRole', () => {
  const roles = [
    mkRole('430', 'ROLE_0430', '海運貨物－課員', '海運貨物', '課員', 'ROLE_0100'),
    mkRole('425', 'ROLE_0425', '海運貨物－課員', '海運貨物', '課員', 'ROLE_0100'),
    mkRole('500', 'ROLE_0500', '海運貨物－課長', '海運貨物', '課長', 'ROLE_0200'),
  ];

  it('單位與職稱都相符時回傳該角色', () => {
    const m = Internals().matchEntryRole('海運貨物', '課長', roles);
    expect(m.roleId).toBe('ROLE_0500');
    expect(m.roleName).toBe('海運貨物－課長');
  });

  it('同名角色有多筆時取記錄編號最小者', () => {
    const m = Internals().matchEntryRole('海運貨物', '課員', roles);
    expect(m.roleId).toBe('ROLE_0425');
  });

  it('找不到對應角色時回傳 null', () => {
    expect(Internals().matchEntryRole('資訊部', '專員', roles)).toBeNull();
  });

  it('單位相符但職稱不符時回傳 null', () => {
    expect(Internals().matchEntryRole('海運貨物', '專員', roles)).toBeNull();
  });

  it('同名記錄的下一關一致時 nextConsistent 為 true', () => {
    expect(Internals().matchEntryRole('海運貨物', '課員', roles).nextConsistent).toBe(true);
  });

  it('同名記錄的下一關不一致時 nextConsistent 為 false', () => {
    const messy = [
      mkRole('425', 'ROLE_0425', '海運貨物－課員', '海運貨物', '課員', 'ROLE_0100'),
      mkRole('430', 'ROLE_0430', '海運貨物－課員', '海運貨物', '課員', 'ROLE_0999'),
    ];
    expect(Internals().matchEntryRole('海運貨物', '課員', messy).nextConsistent).toBe(false);
  });
});

describe('isNextRoleConsistent', () => {
  const roles = [
    mkRole('430', 'ROLE_0430', '海運貨物－課員', '海運貨物', '課員', 'ROLE_0100'),
    mkRole('425', 'ROLE_0425', '海運貨物－課員', '海運貨物', '課員', 'ROLE_0100'),
    mkRole('500', 'ROLE_0500', '海運貨物－課長', '海運貨物', '課長', 'ROLE_0200'),
  ];

  it('依 roleId 找到角色、同名記錄下一關一致時回 true', () => {
    expect(Internals().isNextRoleConsistent('ROLE_0430', roles)).toBe(true);
  });

  it('同名記錄下一關不一致時回 false（不限定從哪一筆同名記錄的 roleId 查）', () => {
    const messy = [
      mkRole('425', 'ROLE_0425', '海運貨物－課員', '海運貨物', '課員', 'ROLE_0100'),
      mkRole('430', 'ROLE_0430', '海運貨物－課員', '海運貨物', '課員', 'ROLE_0999'),
    ];
    expect(Internals().isNextRoleConsistent('ROLE_0430', messy)).toBe(false);
  });

  it('找不到對應 roleId 時回 null（呼叫端視為不顯示警告）', () => {
    expect(Internals().isNextRoleConsistent('ROLE_9999', roles)).toBeNull();
  });
});

// ─── 起點鏈完整性（A 區同步設定與 G 區補齊共用的純函式）────────────────────

/** 起點鏈測試用的角色：比上面的 mkRole 多帶 is_chain_end，才測得到「終點也算設好」 */
const mkChainRole = (recordId, roleId, roleName,
  { unitName = '海運貨物', titleLevel = '課員', nextRoleId = '', chainEnd = false } = {}) => ({
  recordId, roleId, roleName, unitName, titleLevel, nextRoleId,
  isChainEnd: chainEnd ? ['是終點'] : [],
  holderType: '指定個人', holderUsers: [],
});

describe('hasNextStep', () => {
  it('有 next_role_id 算已設定', () => {
    expect(Internals().hasNextStep(mkChainRole('1', 'R1', '甲關', { nextRoleId: 'R2' }))).toBe(true);
  });

  it('勾了「是終點」也算已設定（終點是刻意的鏈結尾，不是漏設）', () => {
    expect(Internals().hasNextStep(mkChainRole('1', 'R1', '甲關', { chainEnd: true }))).toBe(true);
  });

  it('兩者皆無才算沒設定', () => {
    expect(Internals().hasNextStep(mkChainRole('1', 'R1', '甲關'))).toBe(false);
  });

  it('沒有 is_chain_end 欄位時不會出錯', () => {
    expect(Internals().hasNextStep({ roleId: 'R1', nextRoleId: '' })).toBe(false);
  });
});

describe('inspectNextStep', () => {
  const roles = [
    mkChainRole('10', 'R10', '甲關', { nextRoleId: 'R20' }),
    mkChainRole('11', 'R11', '甲關', { nextRoleId: 'R20' }),
    mkChainRole('12', 'R12', '乙關'),
    mkChainRole('13', 'R13', '乙關', { nextRoleId: 'R20' }),
  ];

  it('同名記錄都設好時 hasNext 為 true，沒有要補的記錄', () => {
    const s = Internals().inspectNextStep('R10', roles);
    expect(s.hasNext).toBe(true);
    expect(s.missingIds).toEqual([]);
  });

  it('同名記錄有人沒設時 hasNext 為 false，missingIds 只列缺的那幾筆', () => {
    const s = Internals().inspectNextStep('R13', roles);
    expect(s.hasNext).toBe(false);
    expect(s.missingIds).toEqual(['12']);
    expect(s.recordIds).toEqual(['12', '13']);
  });

  it('找不到對應角色時回 null', () => {
    expect(Internals().inspectNextStep('R99', roles)).toBeNull();
  });

  it('isNextRoleConsistent 沿用同一份判斷', () => {
    expect(Internals().isNextRoleConsistent('R10', roles)).toBe(true);
    expect(Internals().isNextRoleConsistent('R13', roles)).toBe(false);
    expect(Internals().isNextRoleConsistent('R99', roles)).toBeNull();
  });
});

describe('walkBackTo', () => {
  const roles = [
    mkChainRole('1', 'R1', '甲關', { nextRoleId: 'R2' }),
    mkChainRole('2', 'R2', '乙關', { nextRoleId: 'R3' }),
    mkChainRole('3', 'R3', '丙關', { nextRoleId: 'R1' }),
    mkChainRole('4', 'R4', '丁關', { chainEnd: true }),
  ];
  const byId = new Map(roles.map((r) => [r.roleId, r]));

  it('目標的下游繞回來源時回報迴圈，並給出走過的路徑', () => {
    const { cycle, path } = Internals().walkBackTo('R2', '甲關', byId);
    expect(cycle).toBe(true);
    expect(path).toEqual(['乙關', '丙關', '甲關']);
  });

  it('目標就是來源自己也算迴圈', () => {
    expect(Internals().walkBackTo('R1', '甲關', byId).cycle).toBe(true);
  });

  it('走到終點就停，沒有迴圈', () => {
    expect(Internals().walkBackTo('R4', '甲關', byId).cycle).toBe(false);
  });

  it('指到不存在的角色時停下來，不當成迴圈', () => {
    expect(Internals().walkBackTo('R99', '甲關', byId).cycle).toBe(false);
  });
});

describe('planNextStepUpdates', () => {
  it('每筆記錄成對寫入 next_role_id 與 is_chain_end', () => {
    const { updates, conflicts } = Internals().planNextStepUpdates([
      { roleName: '甲關', recordIds: ['1', '2'], value: 'R20', label: '乙關' },
    ]);
    expect(conflicts).toEqual([]);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual({
      id: '1',
      record: { next_role_id: { value: 'R20' }, is_chain_end: { value: [] } },
    });
  });

  it('選「設為終點」時清掉 next_role_id、勾上是終點', () => {
    const { updates } = Internals().planNextStepUpdates([
      { roleName: '甲關', recordIds: ['1'], value: Internals().CHAIN_END_VALUE, label: '（設為終點，不再往上送）' },
    ]);
    expect(updates[0].record).toEqual({
      next_role_id: { value: '' },
      is_chain_end: { value: ['是終點'] },
    });
  });

  it('同一筆記錄被指到相同目標不算衝突，也不會重複寫', () => {
    const { updates, conflicts } = Internals().planNextStepUpdates([
      { roleName: '甲關', recordIds: ['1'], value: 'R20', label: '乙關' },
      { roleName: '甲關', recordIds: ['1'], value: 'R20', label: '乙關' },
    ]);
    expect(conflicts).toEqual([]);
    expect(updates).toHaveLength(1);
  });

  it('同一筆記錄被指到不同目標時回報衝突（呼叫端據此整批擋下）', () => {
    const { conflicts } = Internals().planNextStepUpdates([
      { roleName: '甲關', recordIds: ['1'], value: 'R20', label: '乙關' },
      { roleName: '甲關', recordIds: ['1'], value: 'R30', label: '丙關' },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].roleName).toBe('甲關');
    expect(conflicts[0].labels).toEqual(['乙關', '丙關']);
  });

  it('沒有任何指派時兩邊都是空陣列', () => {
    expect(Internals().planNextStepUpdates([])).toEqual({ updates: [], conflicts: [] });
  });
});

describe('buildBrokenEntries', () => {
  const roles = [
    mkChainRole('10', 'R10', '甲關', { nextRoleId: 'R20' }),
    mkChainRole('20', 'R20', '乙關', { chainEnd: true }),
    mkChainRole('30', 'R30', '丙關'),
    mkChainRole('31', 'R31', '丙關'),
  ];
  const mkEntry = (recordId, code, roleId) => ({ recordId, code, roleId });
  const nameByCode = new Map([['u1', '王一'], ['u2', '王二'], ['u3', '王三']]);

  it('起點角色設定完整的人不會被列出來', () => {
    expect(Internals().buildBrokenEntries({
      entries: [mkEntry('1', 'u1', 'R10'), mkEntry('2', 'u2', 'R20')],
      activeCodes: new Set(['u1', 'u2']),
      nameByCode,
      roles,
    })).toEqual([]);
  });

  it('角色沒設下一關時聚合成一列，同名記錄都列進要補的清單', () => {
    const rows = Internals().buildBrokenEntries({
      entries: [mkEntry('1', 'u1', 'R30'), mkEntry('2', 'u2', 'R31')],
      activeCodes: new Set(['u1', 'u2']),
      nameByCode,
      roles,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].problem).toBe('no-next');
    expect(rows[0].peopleCount).toBe(2);
    expect(rows[0].missingIds).toEqual(['30', '31']);
  });

  it('685 找不到角色時標成 missing，沒有可補的記錄', () => {
    const rows = Internals().buildBrokenEntries({
      entries: [mkEntry('1', 'u1', 'R99')],
      activeCodes: new Set(['u1']),
      nameByCode,
      roles,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].problem).toBe('missing');
    expect(rows[0].missingIds).toEqual([]);
    expect(rows[0].name).toContain('R99');
  });

  it('帳號已停用的人不算（那是 C 區的範圍）', () => {
    expect(Internals().buildBrokenEntries({
      entries: [mkEntry('1', 'gone', 'R30')],
      activeCodes: new Set(['u1']),
      nameByCode,
      roles,
    })).toEqual([]);
  });

  it('沒填 entry_role_id 的起點記錄略過', () => {
    expect(Internals().buildBrokenEntries({
      entries: [mkEntry('1', 'u1', '')],
      activeCodes: new Set(['u1']),
      nameByCode,
      roles,
    })).toEqual([]);
  });

  it('影響人數多的排前面', () => {
    const rows = Internals().buildBrokenEntries({
      entries: [mkEntry('1', 'u1', 'R99'), mkEntry('2', 'u2', 'R30'), mkEntry('3', 'u3', 'R31')],
      activeCodes: new Set(['u1', 'u2', 'u3']),
      nameByCode,
      roles,
    });
    expect(rows[0].peopleCount).toBe(2);
    expect(rows[1].peopleCount).toBe(1);
  });
});

describe('planEntryWrites', () => {
  it('沒有既有記錄的人走新建', () => {
    const { creates, updates } = Internals().planEntryWrites([
      { code: 'u1', roleId: 'R1', recordIds: [] },
    ]);
    expect(updates).toHaveLength(0);
    expect(creates[0]).toEqual({
      employee:      { value: [{ code: 'u1' }] },
      entry_role_id: { value: 'R1' },
      is_active:     { value: ['啟用中'] },
    });
  });

  it('已經有記錄、只是沒填角色的人補填原記錄，不會再建一筆', () => {
    const { creates, updates } = Internals().planEntryWrites([
      { code: 'u1', roleId: 'R1', recordIds: ['77'] },
    ]);
    expect(creates).toHaveLength(0);
    expect(updates).toEqual([{ id: '77', record: { entry_role_id: { value: 'R1' } } }]);
  });

  it('同一人有多筆空白記錄時全部填成同一個角色（留白的那幾筆仍會被取到空值）', () => {
    const { updates } = Internals().planEntryWrites([
      { code: 'u1', roleId: 'R1', recordIds: ['77', '78'] },
    ]);
    expect(updates.map((x) => x.id)).toEqual(['77', '78']);
  });

  it('沒帶 recordIds 時當成沒有既有記錄', () => {
    expect(Internals().planEntryWrites([{ code: 'u1', roleId: 'R1' }]).creates).toHaveLength(1);
  });

  it('同一帳號出現多次只認第一筆（686 是一人一筆起點）', () => {
    const { creates, updates } = Internals().planEntryWrites([
      { code: 'u1', roleId: 'R1', recordIds: [] },
      { code: 'u1', roleId: 'R2', recordIds: ['77'] },
    ]);
    expect(creates).toHaveLength(1);
    expect(updates).toHaveLength(0);
    expect(creates[0].entry_role_id.value).toBe('R1');
  });
});

// ─── 就地新建 685 角色（A 區配不到現有角色時用）────────────────────────────

describe('guessTitleLevel', () => {
  const options = ['擔當', '主任', '課長', '次長', '部長', '本部長'];

  it('完全相同時 exact 為 true', () => {
    expect(Internals().guessTitleLevel('課長', options)).toEqual({ value: '課長', exact: true });
  });

  it('以選項結尾時取最長的：資訊本部長 → 本部長（不是部長）', () => {
    expect(Internals().guessTitleLevel('資訊本部長', options).value).toBe('本部長');
  });

  it('包含選項時取最靠後的：總經理室 擔當 → 擔當', () => {
    expect(Internals().guessTitleLevel('總經理室 擔當', options).value).toBe('擔當');
  });

  it('對不上就回空字串，不亂猜', () => {
    expect(Internals().guessTitleLevel('工讀生', options).value).toBe('');
  });

  it('沒有職務、或沒有選項時回空字串', () => {
    expect(Internals().guessTitleLevel('', options).value).toBe('');
    expect(Internals().guessTitleLevel('課長', []).value).toBe('');
  });
});

describe('guessUnitName', () => {
  const options = ['倉儲（TEPZ）', '海運貨物'];

  it('只接受完全相同（模糊比對會配到隔壁單位）', () => {
    expect(Internals().guessUnitName('倉儲（TEPZ）', options)).toBe('倉儲（TEPZ）');
    expect(Internals().guessUnitName('倉儲', options)).toBe('');
  });

  it('比對前去掉頭尾空白', () => {
    expect(Internals().guessUnitName('  海運貨物 ', options)).toBe('海運貨物');
  });
});

describe('deriveRoleNameSeparator', () => {
  const mk = (roleName, unitName, titleLevel) => ({ roleName, unitName, titleLevel });

  it('反推得出目前畫面上的 " - "', () => {
    expect(Internals().deriveRoleNameSeparator([
      mk('倉儲（TEPZ） - 主任', '倉儲（TEPZ）', '主任'),
      mk('海運貨物 - 課長', '海運貨物', '課長'),
    ])).toBe(' - ');
  });

  it('舊的 "_" 格式一樣反推得出來', () => {
    expect(Internals().deriveRoleNameSeparator([mk('海運貨物_課長', '海運貨物', '課長')])).toBe('_');
  });

  it('兩種格式並存時取多數', () => {
    expect(Internals().deriveRoleNameSeparator([
      mk('A - x', 'A', 'x'), mk('B - y', 'B', 'y'), mk('C_z', 'C', 'z'),
    ])).toBe(' - ');
  });

  it('欄位不齊或對不起來時回 null（呼叫端就不要寫 role_name）', () => {
    expect(Internals().deriveRoleNameSeparator([mk('隨便取的名字', '海運貨物', '課長')])).toBeNull();
    expect(Internals().deriveRoleNameSeparator([])).toBeNull();
  });
});

describe('buildNewRoleRecords', () => {
  const spec = {
    rowId: 'g:倉儲', unitName: '倉儲（TEPZ）', titleLevel: '主任',
    memberCodes: ['u1', 'u2'], nextValue: 'ROLE_0200',
  };

  it('一人一筆同名記錄，role_id 連號（見 §9.5 holder_user 一筆只掛一人）', () => {
    const { records, roleIdByRow } = Internals().buildNewRoleRecords([spec], 31);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.role_id.value)).toEqual(['ROLE_0031', 'ROLE_0032']);
    expect(records[0].holder_user.value).toEqual([{ code: 'u1' }]);
    expect(records[1].holder_user.value).toEqual([{ code: 'u2' }]);
    // 起點指到這一關最先建立的那一筆，與 matchEntryRole 取記錄編號最小者同一個規則
    expect(roleIdByRow.get('g:倉儲')).toBe('ROLE_0031');
  });

  it('新角色直接帶著下一關建立，is_chain_end 清空', () => {
    const { records } = Internals().buildNewRoleRecords([spec], 1);
    expect(records[0].next_role_id).toEqual({ value: 'ROLE_0200' });
    expect(records[0].is_chain_end).toEqual({ value: [] });
  });

  it('選「設為終點」時 next_role_id 清空、勾上是終點', () => {
    const { records } = Internals().buildNewRoleRecords(
      [{ ...spec, nextValue: Internals().CHAIN_END_VALUE }], 1);
    expect(records[0].next_role_id).toEqual({ value: '' });
    expect(records[0].is_chain_end).toEqual({ value: ['是終點'] });
  });

  it('預設指定個人 + 任一人簽 + 啟用中，holder_group 清空', () => {
    const { records } = Internals().buildNewRoleRecords([spec], 1);
    expect(records[0].holder_type.value).toBe('指定個人');
    expect(records[0].signing_mode.value).toBe('任一人簽');
    expect(records[0].is_active.value).toEqual(['啟用中']);
    expect(records[0].holder_group.value).toEqual([]);
  });

  it('沒給分隔符號就完全不寫 role_name（計算欄位不接受寫入）', () => {
    const { records } = Internals().buildNewRoleRecords([spec], 1);
    expect('role_name' in records[0]).toBe(false);
  });

  it('給了分隔符號才自己組 role_name', () => {
    const { records } = Internals().buildNewRoleRecords([spec], 1, { roleNameSeparator: ' - ' });
    expect(records[0].role_name.value).toBe('倉儲（TEPZ） - 主任');
  });

  it('多個關卡的流水號接續，不會重號', () => {
    const { records, roleIdByRow } = Internals().buildNewRoleRecords([
      spec,
      { rowId: 'g:海運', unitName: '海運貨物', titleLevel: '課長',
        memberCodes: ['u3'], nextValue: 'ROLE_0200' },
    ], 10);
    expect(records.map((r) => r.role_id.value)).toEqual(['ROLE_0010', 'ROLE_0011', 'ROLE_0012']);
    expect(roleIdByRow.get('g:海運')).toBe('ROLE_0012');
  });
});
