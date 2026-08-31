/**
 * core/07-role-picker.js 單元測試（jsdom）
 *
 * 純 DOM 元件，直接建立、派發事件、驗證 DOM 與 onSelect 呼叫。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

await import('../core/07-role-picker.js');

const RolePicker = () => window.ApprovalRouting.RolePicker;

const OPTIONS = [
  { id: 'R1', name: '研發課_職員', group: '研發課' },
  { id: 'R2', name: '研發課_課長', group: '研發課' },
  { id: 'R3', name: '研發部_部長', group: '研發部' },
  { id: 'R4', name: '會計_經辦',   group: '' }, // 未分類
];

const fire = (el, type, init = {}) => el.dispatchEvent(new Event(type, { bubbles: true, ...init }));
const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const mousedown = (el) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

const mk = (over = {}) => {
  const onSelect = vi.fn();
  const p = RolePicker().create({ options: OPTIONS, onSelect, ...over });
  document.body.appendChild(p.el);
  const input = p.el.querySelector('input');
  const panel = p.el.querySelector('div > div:last-child') || p.el.querySelectorAll('div')[1];
  return { p, onSelect, input, panel: p.el.querySelector('input').nextElementSibling };
};

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { vi.useRealTimers(); });

describe('建立與初始狀態', () => {

  it('✅ 渲染 input，套用 placeholder 與初始顯示文字', () => {
    const { input } = mk({ placeholder: '找角色…', initialId: 'R2', initialName: '研發課_課長' });
    expect(input.placeholder).toBe('找角色…');
    expect(input.value).toBe('研發課_課長');
  });

  it('✅ labelText 有值才渲染 <label>', () => {
    const withLabel = mk({ labelText: '下一關角色：' });
    expect(withLabel.p.el.querySelector('label')?.textContent).toBe('下一關角色：');
    const without = mk();
    expect(without.p.el.querySelector('label')).toBeNull();
  });

  it('✅ getValue 回傳初始 {id,name}', () => {
    const { p } = mk({ initialId: 'R3', initialName: '研發部_部長' });
    expect(p.getValue()).toEqual({ id: 'R3', name: '研發部_部長' });
  });

});

describe('面板與過濾', () => {

  it('✅ focus 打開面板，依 group 插入標題', () => {
    const { input, panel } = mk();
    fire(input, 'focus');
    expect(panel.style.display).toBe('block');
    const headers = [...panel.querySelectorAll('[data-group-header]')].map((h) => h.textContent);
    expect(headers).toEqual(['研發課', '研發部', '（未分類）']);
    expect(panel.querySelectorAll('[data-opt-index]')).toHaveLength(4);
  });

  it('✅ 輸入關鍵字過濾（依 name.includes）', () => {
    const { input, panel } = mk();
    fire(input, 'focus');
    input.value = '課';
    fire(input, 'input');
    const rows = [...panel.querySelectorAll('[data-opt-index]')].map((r) => r.textContent);
    expect(rows).toEqual(['研發課_職員', '研發課_課長']);
  });

  it('✅ 無符合項目顯示 emptyText', () => {
    const { input, panel } = mk({ emptyText: '查無此角色' });
    fire(input, 'focus');
    input.value = 'zzz';
    fire(input, 'input');
    expect(panel.textContent).toContain('查無此角色');
    expect(panel.querySelectorAll('[data-opt-index]')).toHaveLength(0);
  });

  it('✅ group 空字串時用 ungroupedLabel', () => {
    const { input, panel } = mk({ ungroupedLabel: '其他' });
    fire(input, 'focus');
    const headers = [...panel.querySelectorAll('[data-group-header]')].map((h) => h.textContent);
    expect(headers).toContain('其他');
  });

});

describe('選取', () => {

  it('✅ 點選（mousedown）→ onSelect 帶該選項、input 更新、面板收起', () => {
    const { input, panel, onSelect, p } = mk();
    fire(input, 'focus');
    const row = panel.querySelectorAll('[data-opt-index]')[2]; // 研發部_部長
    mousedown(row);
    expect(onSelect).toHaveBeenCalledWith({ id: 'R3', name: '研發部_部長', group: '研發部' });
    expect(input.value).toBe('研發部_部長');
    expect(panel.style.display).toBe('none');
    expect(p.getValue()).toEqual({ id: 'R3', name: '研發部_部長' });
  });

  it('✅ ↓↓ + Enter：移動高亮後確認', () => {
    const { input, onSelect } = mk();
    fire(input, 'focus');       // activeIndex = 0
    key(input, 'ArrowDown');    // 1
    key(input, 'ArrowDown');    // 2
    key(input, 'Enter');
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'R3' }));
  });

  it('✅ ↑ 在第一項時繞回最後一項', () => {
    const { input, onSelect } = mk();
    fire(input, 'focus');       // activeIndex = 0
    key(input, 'ArrowUp');      // -> 3（繞回）
    key(input, 'Enter');
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'R4' }));
  });

  it('✅ 面板關閉時按 ↓ 只重新打開、不選取', () => {
    const { input, panel, onSelect } = mk();
    key(input, 'ArrowDown');
    expect(panel.style.display).toBe('block');
    expect(onSelect).not.toHaveBeenCalled();
  });

});

describe('失焦 / Esc 還原', () => {

  it('✅ 輸入無效字串後失焦 → 還原成最後選取', () => {
    vi.useFakeTimers();
    const { input, panel } = mk({ initialId: 'R1', initialName: '研發課_職員' });
    fire(input, 'focus');
    input.value = '亂打的字';
    fire(input, 'input');
    fire(input, 'blur');
    vi.advanceTimersByTime(200);
    expect(panel.style.display).toBe('none');
    expect(input.value).toBe('研發課_職員');
  });

  it('✅ 選過之後再亂打、失焦 → 還原成選過的值', () => {
    vi.useFakeTimers();
    const { input } = mk();
    fire(input, 'focus');
    mousedown(input.nextElementSibling.querySelectorAll('[data-opt-index]')[1]); // 研發課_課長
    input.value = 'xxx';
    fire(input, 'blur');
    vi.advanceTimersByTime(200);
    expect(input.value).toBe('研發課_課長');
  });

  it('✅ Esc 關閉面板並還原', () => {
    const { input, panel } = mk({ initialName: '研發課_職員', initialId: 'R1' });
    fire(input, 'focus');
    input.value = '半形';
    fire(input, 'input');
    key(input, 'Escape');
    expect(panel.style.display).toBe('none');
    expect(input.value).toBe('研發課_職員');
  });

});

describe('setSelection / destroy', () => {

  it('✅ setSelection 更新顯示與 getValue', () => {
    const { p, input } = mk();
    p.setSelection('R2', '研發課_課長');
    expect(input.value).toBe('研發課_課長');
    expect(p.getValue()).toEqual({ id: 'R2', name: '研發課_課長' });
  });

  it('✅ destroy 從 DOM 移除', () => {
    const { p } = mk();
    expect(document.body.contains(p.el)).toBe(true);
    p.destroy();
    expect(document.body.contains(p.el)).toBe(false);
  });

});
