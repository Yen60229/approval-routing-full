/**
 * apps/form-route/01-route-form.js 的純函式測試（validateRouteSteps）
 *
 * DOM 掛載（RolePicker、淡化、observer）不在此範圍，只測 submit 驗證邏輯。
 */
import { describe, it, expect } from 'vitest';

await import('../apps/form-route/01-route-form.js');

const { validateRouteSteps } = window.ApprovalRouting.RouteFormInternals;

const EMP = '員工鏈段';
const FIX = '指定角色段';

const row = ({ seg = '', roleId = '', stopAt = '', skip = [], mode = '', stepNo = '' } = {}) => ({
  value: {
    step_no:             { value: stepNo },
    segment_type:        { value: seg },
    role_id:             { value: roleId },
    stop_at_title_level: { value: stopAt },
    skip_title_levels:   { value: skip },
    step_signing_mode:   { value: mode },
  },
});

const KNOWN = new Set(['ROLE_ACC', 'ROLE_GA']);

describe('validateRouteSteps', () => {

  it('✅ 空子表格 → 要求至少一列', () => {
    expect(validateRouteSteps([], KNOWN)).toEqual(['「路由關卡」至少要有一列。']);
    expect(validateRouteSteps(null, KNOWN)[0]).toContain('至少要有一列');
  });

  it('✅ 乾淨的員工鏈段（有截止＋跳關）→ 無錯', () => {
    expect(validateRouteSteps([row({ seg: EMP, stopAt: '部長', skip: ['次長'] })], KNOWN)).toEqual([]);
  });

  it('✅ 員工鏈段無截止職稱也合法（走到終點）', () => {
    expect(validateRouteSteps([row({ seg: EMP })], KNOWN)).toEqual([]);
  });

  it('✅ 員工鏈段填了指定角色 → 錯', () => {
    const e = validateRouteSteps([row({ seg: EMP, roleId: 'ROLE_ACC' })], KNOWN);
    expect(e).toHaveLength(1);
    expect(e[0]).toContain('員工鏈段不需要「指定角色」');
  });

  it('✅ 員工鏈段選「全員會簽」 → 錯', () => {
    const e = validateRouteSteps([row({ seg: EMP, mode: '全員會簽' })], KNOWN);
    expect(e[0]).toContain('「全員會簽」僅限指定角色段');
  });

  it('✅ 員工鏈段「任一人簽」可以', () => {
    expect(validateRouteSteps([row({ seg: EMP, mode: '任一人簽' })], KNOWN)).toEqual([]);
  });

  it('✅ 乾淨的指定角色段（角色存在）→ 無錯', () => {
    expect(validateRouteSteps([row({ seg: FIX, roleId: 'ROLE_ACC' })], KNOWN)).toEqual([]);
  });

  it('✅ 指定角色段沒選角色 → 錯', () => {
    const e = validateRouteSteps([row({ seg: FIX })], KNOWN);
    expect(e[0]).toContain('必須選一個角色');
  });

  it('✅ 指定角色段選了不存在的角色 → 錯', () => {
    const e = validateRouteSteps([row({ seg: FIX, roleId: 'ROLE_GHOST' })], KNOWN);
    expect(e[0]).toContain('找不到啟用中的角色（ROLE_GHOST）');
  });

  it('✅ known 為 null 時略過存在性檢查', () => {
    expect(validateRouteSteps([row({ seg: FIX, roleId: 'ROLE_WHATEVER' })], null)).toEqual([]);
  });

  it('✅ 指定角色段填了截止職稱 / 跳過職稱 → 各一錯', () => {
    const e = validateRouteSteps([row({ seg: FIX, roleId: 'ROLE_ACC', stopAt: '部長', skip: ['次長'] })], KNOWN);
    expect(e).toHaveLength(2);
    expect(e.join()).toContain('不需要「簽到職稱為止」');
    expect(e.join()).toContain('不需要「跳過的職稱」');
  });

  it('✅ 沒選段類型 → 錯', () => {
    const e = validateRouteSteps([row({ roleId: '' })], KNOWN);
    expect(e[0]).toContain('請選擇「段類型」');
  });

  it('✅ 多列：錯誤訊息帶「第 N 列」前綴', () => {
    const e = validateRouteSteps([
      row({ seg: EMP }),                          // ok
      row({ seg: FIX }),                          // 第 2 列：沒選角色
      row({ seg: EMP, roleId: 'ROLE_ACC' }),      // 第 3 列：不該有角色
    ], KNOWN);
    expect(e).toHaveLength(2);
    expect(e[0]).toContain('第 2 列');
    expect(e[1]).toContain('第 3 列');
  });

  // ── step_no：順序決定段的接續關係，排錯等於鏈錯 ───────────────────────────

  it('✅ step_no 全部留空 → 合法（以畫面列順序為準）', () => {
    expect(validateRouteSteps([row({ seg: EMP }), row({ seg: FIX, roleId: 'ROLE_ACC' })], KNOWN)).toEqual([]);
  });

  it('✅ step_no 全部填好且不重複 → 合法', () => {
    expect(validateRouteSteps([
      row({ stepNo: '1', seg: EMP }),
      row({ stepNo: '2', seg: FIX, roleId: 'ROLE_ACC' }),
    ], KNOWN)).toEqual([]);
  });

  it('✅ step_no 混填（有的填有的空）→ 錯：留空的會被當 0 竄到最前面', () => {
    const e = validateRouteSteps([
      row({ stepNo: '1', seg: EMP }),
      row({ seg: FIX, roleId: 'ROLE_ACC' }),
    ], KNOWN);
    expect(e).toHaveLength(1);
    expect(e[0]).toContain('請全部填寫，或全部留空');
  });

  it('✅ step_no 重複 → 錯：關卡先後不確定', () => {
    const e = validateRouteSteps([
      row({ stepNo: '2', seg: EMP }),
      row({ stepNo: '2', seg: FIX, roleId: 'ROLE_ACC' }),
    ], KNOWN);
    expect(e).toHaveLength(1);
    expect(e[0]).toContain('有重複值（2）');
  });

  it('✅ step_no 不必連號，只要不重複（1、5、9 合法）', () => {
    expect(validateRouteSteps([
      row({ stepNo: '1', seg: EMP }),
      row({ stepNo: '5', seg: FIX, roleId: 'ROLE_ACC' }),
      row({ stepNo: '9', seg: FIX, roleId: 'ROLE_GA' }),
    ], KNOWN)).toEqual([]);
  });

});
