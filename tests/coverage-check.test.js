/**
 * tools/05-coverage-check.js 的純函式單元測試
 *
 * 載入策略：import IIFE → 掛上 window.ApprovalRouting.CoverageInternals
 * UI 與 API 呼叫不在此測試範圍，只測分組與配對這兩段純邏輯。
 */
import { describe, it, expect } from 'vitest';

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
