/**
 * 測試用假角色資料產生器
 * 格式與 kintone record 物件一致
 */

/**
 * 產生一筆角色 record
 * @param {Object} opts
 */
export const makeRole = ({
  roleId,
  roleName,
  nextRoleId   = '',
  isChainEnd   = false,
  holderType   = '指定群組',
  holderGroup  = '',
  holderUser   = '',
}) => ({
  role_id:      { value: roleId },
  role_name:    { value: roleName },
  next_role_id: { value: nextRoleId },
  is_chain_end: { value: isChainEnd ? ['是終點'] : [] },
  holder_type:  { value: holderType },
  holder_group: { value: holderGroup ? [{ code: holderGroup }] : [] },
  holder_user:  { value: holderUser  ? [{ code: holderUser  }] : [] },
  signing_mode: { value: '任一人簽' },
  is_active:    { value: ['啟用中'] },
});

// ─── 常用測試角色集 ────────────────────────────────────────────────────────

/**
 * 正常 3 關鏈（混合 GROUP + USER）
 *
 * ROLE_001（課長群組）→ ROLE_002（部長個人）→ ROLE_003（終點, 總經理群組）
 */
export const ROLES_3_STEPS = {
  ROLE_001: makeRole({
    roleId: 'ROLE_001', roleName: '研發課課長',
    nextRoleId: 'ROLE_002',
    holderType: '指定群組', holderGroup: 'g_rd_section',
  }),
  ROLE_002: makeRole({
    roleId: 'ROLE_002', roleName: '研發部部長',
    nextRoleId: 'ROLE_003',
    holderType: '指定個人', holderUser: 'lin.mingzhi',
  }),
  ROLE_003: makeRole({
    roleId: 'ROLE_003', roleName: '總經理',
    isChainEnd: true,
    holderType: '指定群組', holderGroup: 'g_ceo',
  }),
};

/**
 * 循環鏈：ROLE_A → ROLE_B → ROLE_A
 */
export const ROLES_CIRCULAR = {
  ROLE_A: makeRole({ roleId: 'ROLE_A', roleName: '角色A', nextRoleId: 'ROLE_B', holderType: '指定個人', holderUser: 'user.a' }),
  ROLE_B: makeRole({ roleId: 'ROLE_B', roleName: '角色B', nextRoleId: 'ROLE_A', holderType: '指定個人', holderUser: 'user.b' }),
};

/**
 * 斷鏈：ROLE_X → ROLE_GHOST（不存在）
 */
export const ROLES_BROKEN = {
  ROLE_X: makeRole({ roleId: 'ROLE_X', roleName: '角色X', nextRoleId: 'ROLE_GHOST', holderType: '指定個人', holderUser: 'user.x' }),
};
