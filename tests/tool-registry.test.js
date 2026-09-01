/**
 * core/09-tool-registry.js 的單元測試
 *
 * 註冊表決定「哪顆按鈕在哪張表出現」，判斷錯的話 HR 會在 686 看到只能在 685 跑的工具，
 * 點下去才發現失敗。分組與 App 守門因此要有測試守著。
 * 選單的視覺樣式不測，只測「有沒有畫出來、點了會不會跑對工具」。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

await import('../core/09-tool-registry.js');

const Registry = () => window.ApprovalRouting.ToolRegistry;

const ROLE_APP  = 685;
const ENTRY_APP = 686;

/** 每個測試用不同的 id，避免互相覆蓋（register 以 id 去重） */
let seq = 0;
const uniq = (prefix) => `${prefix}-${++seq}`;

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('register / listFor', () => {
  it('依 App ID 過濾：只列出這張表用得到的工具', () => {
    const a = uniq('only685');
    const b = uniq('only686');
    Registry().register({ id: a, group: 'inspect', label: 'A', apps: [ROLE_APP], run: () => {} });
    Registry().register({ id: b, group: 'inspect', label: 'B', apps: [ENTRY_APP], run: () => {} });

    const ids = (appId) => Registry().listFor(appId).flatMap((g) => g.tools.map((t) => t.id));
    expect(ids(ROLE_APP)).toContain(a);
    expect(ids(ROLE_APP)).not.toContain(b);
    expect(ids(ENTRY_APP)).toContain(b);
  });

  it('沒給 apps 的工具在哪張表都會出現', () => {
    const id = uniq('anywhere');
    Registry().register({ id, group: 'query', label: '不限', run: () => {} });
    expect(Registry().listFor(999).flatMap((g) => g.tools.map((t) => t.id))).toContain(id);
  });

  it('同一個 id 重複註冊會覆蓋，不會長出兩顆', () => {
    const id = uniq('dup');
    Registry().register({ id, group: 'inspect', label: '舊的', apps: [ROLE_APP], run: () => {} });
    Registry().register({ id, group: 'inspect', label: '新的', apps: [ROLE_APP], run: () => {} });

    const hits = Registry().listFor(ROLE_APP).flatMap((g) => g.tools).filter((t) => t.id === id);
    expect(hits).toHaveLength(1);
    expect(hits[0].label).toBe('新的');
  });

  it('group 不合法就拒絕註冊（打錯字不會靜靜消失）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const id = uniq('badgroup');
    Registry().register({ id, group: '體檢', label: '中文 group', apps: [ROLE_APP], run: () => {} });
    expect(Registry().listFor(ROLE_APP).flatMap((g) => g.tools).some((t) => t.id === id)).toBe(false);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('缺 run 就拒絕註冊', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const id = uniq('norun');
    Registry().register({ id, group: 'inspect', label: '沒有進入點', apps: [ROLE_APP] });
    expect(Registry().listFor(ROLE_APP).flatMap((g) => g.tools).some((t) => t.id === id)).toBe(false);
    spy.mockRestore();
  });

  it('分組順序固定為 體檢→查詢→維護→部署', () => {
    expect(Registry().GROUPS.map((g) => g.key)).toEqual(['inspect', 'query', 'maintain', 'deploy']);
  });
});

describe('mountInto', () => {
  it('一個分組畫一顆按鈕，沒有工具的分組不出現', () => {
    const appId = 7001;   // 這個測試專屬的假 App，避免被其他測試註冊的工具干擾
    Registry().register({ id: uniq('m'), group: 'inspect', label: '體檢一', apps: [appId], run: () => {} });
    Registry().register({ id: uniq('m'), group: 'inspect', label: '體檢二', apps: [appId], run: () => {} });
    Registry().register({ id: uniq('m'), group: 'query', label: '查詢一', apps: [appId], run: () => {} });

    const host = document.createElement('div');
    document.body.appendChild(host);
    Registry().mountInto(host, appId);

    const labels = [...host.querySelectorAll('button[data-group]')].map((b) => b.textContent);
    expect(labels).toEqual(['體檢 ▾', '查詢 ▾']);
  });

  it('重複掛載不會疊出第二條工具列', () => {
    const appId = 7002;
    Registry().register({ id: uniq('m'), group: 'inspect', label: '只有一支', apps: [appId], run: () => {} });

    const host = document.createElement('div');
    document.body.appendChild(host);
    Registry().mountInto(host, appId);
    Registry().mountInto(host, appId);

    expect(document.querySelectorAll(`#${Registry().CONTAINER_ID}`)).toHaveLength(1);
  });

  it('找不到 header 容器就安靜跳過（kintone 版面改版時不要整支掛掉）', () => {
    expect(Registry().mountInto(null, 7003)).toBeNull();
  });

  it('點分組按鈕展開選單，點選項會執行那支工具', () => {
    const appId = 7004;
    const run = vi.fn();
    Registry().register({ id: uniq('m'), group: 'maintain', label: '要被點的', apps: [appId], hint: '說明', run });

    const host = document.createElement('div');
    document.body.appendChild(host);
    Registry().mountInto(host, appId);

    const btn = host.querySelector('button[data-group="maintain"]');
    const panel = btn.nextElementSibling;
    expect(panel.style.display).toBe('none');

    btn.click();
    expect(panel.style.display).toBe('block');

    panel.querySelector('[data-idx="0"]').click();
    expect(run).toHaveBeenCalledTimes(1);
    expect(panel.style.display).toBe('none');   // 執行前先收起選單
  });
});

describe('runTool', () => {
  it('工具丟例外時關掉 loading 並顯示錯誤，不讓例外往外炸', async () => {
    const boom = { id: uniq('boom'), group: 'inspect', label: '會炸的', run: async () => { throw new Error('壞掉了'); } };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(Registry().runTool(boom)).resolves.toBeUndefined();

    expect(Swal.close).toHaveBeenCalled();
    expect(Swal.fire).toHaveBeenCalledWith(expect.objectContaining({ icon: 'error', text: '壞掉了' }));
    spy.mockRestore();
  });
});
