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
  signingMode  = '任一人簽',
}) => ({
  role_id:      { value: roleId },
  role_name:    { value: roleName },
  next_role_id: { value: nextRoleId },
  is_chain_end: { value: isChainEnd ? ['是終點'] : [] },
  holder_type:  { value: holderType },
  holder_group: { value: holderGroup ? [{ code: holderGroup }] : [] },
  holder_user:  { value: holderUser  ? [{ code: holderUser  }] : [] },
  signing_mode: { value: signingMode },
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

/**
 * 第 2 關沒有任何簽核者（結構完整、但 holder 是空的）
 *
 * 鏈本身走得通，只有解析 holder 之後才看得出問題——
 * 正是 docs/05 評估 #2 描述的情境：單子送得出去，流程跑到該關才卡死。
 */
export const ROLES_EMPTY_HOLDER = {
  ROLE_E1: makeRole({
    roleId: 'ROLE_E1', roleName: '第一關有人',
    nextRoleId: 'ROLE_E2',
    holderType: '指定個人', holderUser: 'user.first',
  }),
  ROLE_E2: makeRole({
    roleId: 'ROLE_E2', roleName: '第二關沒人',
    isChainEnd: true,
    holderType: '指定個人', holderUser: '',
  }),
};

/**
 * 混合簽核模式：第 2 關是「全員會簽」
 * 用於驗證 signing_mode 快照有正確寫進子表格（docs/05 評估 #3）
 */
export const ROLES_MIXED_SIGNING = {
  ROLE_M1: makeRole({
    roleId: 'ROLE_M1', roleName: '任一人簽的關卡',
    nextRoleId: 'ROLE_M2',
    holderType: '指定個人', holderUser: 'user.any',
    signingMode: '任一人簽',
  }),
  ROLE_M2: makeRole({
    roleId: 'ROLE_M2', roleName: '全員會簽的關卡',
    isChainEnd: true,
    holderType: '指定個人', holderUser: 'user.all',
    signingMode: '全員會簽',
  }),
};
