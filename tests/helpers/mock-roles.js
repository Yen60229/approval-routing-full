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
  titleLevel   = '',
  unitName     = '',
}) => ({
  role_id:      { value: roleId },
  role_name:    { value: roleName },
  unit_name:    { value: unitName },
  title_level:  { value: titleLevel },
  next_role_id: { value: nextRoleId },
  is_chain_end: { value: isChainEnd ? ['是終點'] : [] },
  holder_type:  { value: holderType },
  holder_group: { value: holderGroup ? [{ code: holderGroup }] : [] },
  holder_user:  { value: holderUser  ? [{ code: holderUser  }] : [] },
  signing_mode: { value: signingMode },
  is_active:    { value: ['啟用中'] },
});

/**
 * 產生一筆 form_route_config record
 * @param {Object} opts
 * @param {number} opts.formAppId
 * @param {Array<Object>} opts.steps - 每個元素給 makeRouteStep
 * @param {boolean} [opts.isActive=true]
 */
export const makeRouteConfig = ({
  formAppId,
  formName = '測試表單',
  steps = [],
  isActive = true,
  rejectTarget = '退回申請人',
}) => ({
  form_app_id:   { value: String(formAppId) },
  form_name:     { value: formName },
  is_active:     { value: isActive ? ['啟用中'] : [] },
  reject_target: { value: rejectTarget },
  cancel_groups: { value: [] },
  max_depth:     { value: '' },
  deployed_at:   { value: '' },
  deployed_hash: { value: '' },
  route_steps:   { value: steps.map((s, i) => makeRouteStep({ stepNo: i + 1, ...s })) },
});

/**
 * 產生一列 route_steps 子表格記錄
 * @param {Object} opts
 */
export const makeRouteStep = ({
  stepNo,
  segmentType,                       // '員工鏈段' | '指定角色段'
  stopAtTitleLevel = '',
  skipTitleLevels  = [],
  roleId           = '',
  stepSigningMode  = '',             // '' ＝ 沿用角色表
}) => ({
  id: String(stepNo),
  value: {
    step_no:             { value: String(stepNo) },
    segment_type:        { value: segmentType },
    stop_at_title_level: { value: stopAtTitleLevel },
    skip_title_levels:   { value: skipTitleLevels },
    role_id:             { value: roleId },
    step_signing_mode:   { value: stepSigningMode },
  },
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

// ─── P8 Phase B：路由引擎測試角色集 ────────────────────────────────────────

/**
 * 帶 title_level 的個人鏈（供員工鏈段 stop_at / skip 測試）
 *
 * ROLE_P1 職員 → ROLE_P2 課長 → ROLE_P3 次長 → ROLE_P4 部長 → ROLE_P5 總經理（終點）
 * 每一關都是「指定個人」，holder = user.p1 … user.p5
 */
export const ROLES_TITLED_CHAIN = {
  ROLE_P1: makeRole({ roleId: 'ROLE_P1', roleName: '研發課_職員', titleLevel: '職員', nextRoleId: 'ROLE_P2', holderType: '指定個人', holderUser: 'user.p1' }),
  ROLE_P2: makeRole({ roleId: 'ROLE_P2', roleName: '研發課_課長', titleLevel: '課長', nextRoleId: 'ROLE_P3', holderType: '指定個人', holderUser: 'user.p2' }),
  ROLE_P3: makeRole({ roleId: 'ROLE_P3', roleName: '研發部_次長', titleLevel: '次長', nextRoleId: 'ROLE_P4', holderType: '指定個人', holderUser: 'user.p3' }),
  ROLE_P4: makeRole({ roleId: 'ROLE_P4', roleName: '研發部_部長', titleLevel: '部長', nextRoleId: 'ROLE_P5', holderType: '指定個人', holderUser: 'user.p4' }),
  ROLE_P5: makeRole({ roleId: 'ROLE_P5', roleName: '總經理室_總經理', titleLevel: '總經理', isChainEnd: true, holderType: '指定個人', holderUser: 'user.p5' }),
};

/**
 * 職能段固定角色（與申請人無關，直接指定 role_id）
 */
export const ROLES_FUNCTIONAL = {
  ROLE_ACC:  makeRole({ roleId: 'ROLE_ACC',  roleName: '會計_經辦',   titleLevel: '經辦', isChainEnd: true, holderType: '指定個人', holderUser: 'user.acc' }),
  ROLE_GA:   makeRole({ roleId: 'ROLE_GA',   roleName: '總務_經辦',   titleLevel: '經辦', isChainEnd: true, holderType: '指定個人', holderUser: 'user.ga' }),
  ROLE_GAH:  makeRole({ roleId: 'ROLE_GAH',  roleName: '總務_部長',   titleLevel: '部長', isChainEnd: true, holderType: '指定群組', holderGroup: 'g_ga_head' }),
  ROLE_EMPTY:makeRole({ roleId: 'ROLE_EMPTY',roleName: '沒有簽核者的職能角色', titleLevel: '經辦', isChainEnd: true, holderType: '指定個人', holderUser: '' }),
};

/** ROLES_TITLED_CHAIN + ROLES_FUNCTIONAL 合併，多數路由測試直接用這個 */
export const ROLES_ROUTE_ALL = { ...ROLES_TITLED_CHAIN, ...ROLES_FUNCTIONAL };
