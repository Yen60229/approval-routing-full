# A 區跨單位批次建立起點 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 `tools/05-coverage-check.js` 的 A 分頁能一次替多個不同單位的人建立 686 起點記錄，不必一個單位做一輪。

**Architecture:** A 分頁不再共用 `buildTab`，改用專屬的 `buildEntryTab`。人員先由純函式 `groupNoEntryUsers` 依「單位＋職稱」分流成「可分組」與「例外」兩塊，再由純函式 `matchEntryRole` 比對 685 的 `unit_name` / `title_level` 自動帶入起點角色。兩個純函式掛到 `window.ApprovalRouting.CoverageInternals` 供 vitest 測試。B～F 分頁與 `buildTab` 完全不動。

**Tech Stack:** Vanilla JS（ES2020+，IIFE）、kintone REST API、SweetAlert2、vitest + jsdom

## Global Constraints

- 語言：所有註解、UI 文案、commit 訊息一律**繁體中文**
- `const` 取代 `var`；async/await，不用 callback
- 沿用既有的檔頭註解區塊（用途／影響的欄位／依賴／變更履歷）
- **禁止**用字串處理組織名稱或判斷職稱字面值；配對一律比 `unit_name` / `title_level` 欄位相等
- App ID 一律由 `Config.APP_ID` 取得，不得硬編碼
- 寫入批次上限 `CONFIG.WRITE_BATCH`（100）
- commit 訊息**不得**含 `Co-Authored-By` 之類的 AI 署名
- 每個 Task 結束前都要跑 `node --check tools/05-coverage-check.js`

---

### Task 1: 測試環境補齊，讓 tools/05 能被 vitest 載入

`tests/setup.js` 目前缺 `ApprovalRouting.Utils`，且 `ROLE_FIELDS` 少了 `UNIT_NAME` / `TITLE_LEVEL`。不補的話後續 Task 的測試連 import 都會炸。

**Files:**
- Modify: `tests/setup.js`
- Test: `tests/coverage-check.test.js`（新建）

**Interfaces:**
- Consumes: 無
- Produces: `window.ApprovalRouting.Utils`（含 `safeHandler` / `showWarning` / `kintoneApi` 等）；`Config.ROLE_FIELDS.UNIT_NAME = 'unit_name'`；`Config.ROLE_FIELDS.TITLE_LEVEL = 'title_level'`；`global.__mocks__.showWarning`

- [ ] **Step 1: 寫失敗的測試**

新建 `tests/coverage-check.test.js`：

```javascript
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
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
npx vitest run tests/coverage-check.test.js
```

預期：FAIL，錯誤訊息類似 `Cannot destructure property 'safeHandler' of 'window.ApprovalRouting.Utils' as it is undefined.`

- [ ] **Step 3: 補上缺少的欄位代碼**

在 `tests/setup.js` 的 `ROLE_FIELDS` 區塊，於 `ROLE_NAME` 之後插入兩行：

```javascript
  ROLE_FIELDS: Object.freeze({
    ROLE_ID:      'role_id',
    ROLE_NAME:    'role_name',
    UNIT_NAME:    'unit_name',
    TITLE_LEVEL:  'title_level',
    HOLDER_TYPE:  'holder_type',
```

- [ ] **Step 4: 補上 Utils mock**

在 `tests/setup.js` 中，`global.window.ApprovalRouting = { ... };` 這段**之後**、`// 暴露 mock 函式給測試檔案使用` 之前，插入：

```javascript
// ─── ApprovalRouting.Utils mock（tools/ 下的工具會解構它） ────────────────

const mockShowWarning = vi.fn().mockResolvedValue(undefined);
const mockShowSuccess = vi.fn().mockResolvedValue(undefined);
const mockShowConfirm = vi.fn().mockResolvedValue(true);

global.window.ApprovalRouting.Utils = Object.freeze({
  // 測試不驗證錯誤包裝行為，直接原樣回傳處理函式
  safeHandler:       (fn) => fn,
  showSuccess:       mockShowSuccess,
  showWarning:       mockShowWarning,
  showConfirm:       mockShowConfirm,
  kintoneApi:        kintoneApiMock,
  pushSubmitError:   vi.fn(),
  flushSubmitErrors: vi.fn(),
});
```

再於 `global.__mocks__ = { ... }` 物件內加一行：

```javascript
  showWarning:       mockShowWarning,
```

- [ ] **Step 5: 在 tools/05 掛上測試用出口**

`tools/05-coverage-check.js` 目前沒有 `CoverageInternals`。先掛空殼，Task 2/3 再往裡面加函式。

找到檔案末尾的事件註冊：

```javascript
  kintone.events.on(['app.record.index.show'], safeHandler(async (event) => {
```

在這一行**之前**插入：

```javascript
  // 單元測試用的出口；瀏覽器端不依賴它，不影響任何行為
  window.ApprovalRouting.CoverageInternals = Object.freeze({});
```

- [ ] **Step 6: 跑測試確認通過**

```bash
npx vitest run tests/coverage-check.test.js
```

預期：PASS，1 passed

- [ ] **Step 7: 語法檢查**

```bash
node --check tools/05-coverage-check.js
```

預期：無輸出（正常結束）

- [ ] **Step 8: Commit**

```bash
git add tests/setup.js tests/coverage-check.test.js tools/05-coverage-check.js
git commit -m "test: 補齊測試環境，讓 tools/05 可以被單元測試載入

setup.js 原本缺 ApprovalRouting.Utils 的 mock，欄位代碼也少了 unit_name
與 title_level，tools 下的工具一 import 就會炸。這次補齊，並在 tools/05
掛上 CoverageInternals 出口，後續的分組與配對邏輯才測得到。"
```

---

### Task 2: 人員分流純函式 `groupNoEntryUsers`

同單位同職稱的人起點角色必然相同，分組後一組只要選一次。無法明確歸類的人（兼任多單位、多職稱、缺職稱、單位是「（未分類）」）另立例外區逐人手選。兩邊互斥是「一人不會建出兩筆起點」的第一道保險。

**Files:**
- Modify: `tools/05-coverage-check.js`（在 `buildRoleOptions` 之前新增函式）
- Test: `tests/coverage-check.test.js`

**Interfaces:**
- Consumes: `UNGROUPED_LABEL`（`tools/05-coverage-check.js:77` 既有常數，值為 `'（未分類）'`）
- Produces: `groupNoEntryUsers(users)` → `{ groups: Array<{key: string, unit: string, title: string, members: Array}>, exceptions: Array }`
  - `users` 元素需含 `code`、`name`、`jobTitle`（字串，多個職稱以 `、` 串接）、`units`（字串陣列）
  - `groups` 依 unit、title 以 zh-Hant 排序；`exceptions` 依 name 排序

- [ ] **Step 1: 寫失敗的測試**

在 `tests/coverage-check.test.js` 的 `describe('tools/05 載入', ...)` 之後追加：

```javascript
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
    expect(groups.map((g) => g.title)).toEqual(['課員', '課長']);
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
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
npx vitest run tests/coverage-check.test.js
```

預期：FAIL，`TypeError: Internals(...).groupNoEntryUsers is not a function`

- [ ] **Step 3: 實作 `groupNoEntryUsers`**

在 `tools/05-coverage-check.js` 中找到這一行：

```javascript
  /** 由角色清單組出選擇器選項（依單位分組、同名去重；filter 可再限縮類型） */
```

在它**之前**插入：

```javascript
  /**
   * A 區人員分流：能明確歸到「單位＋職稱」的走分組，其餘走例外區
   *
   * 同單位同職稱的人起點角色必然相同，所以分組後一組只要選一次角色。
   * 兼任多單位、職稱有多個、沒有職稱、或單位是「（未分類）」的人無法歸類，
   * 一律進例外區逐人手選——把他們硬綁成一組，會逼 HR 給不同狀況的人同一個起點。
   *
   * 兩邊互斥，同一個人只會出現在其中一列，這是「不會建出兩筆起點」的第一道保險。
   *
   * @param {Array} users - A 區人員，需含 code / name / jobTitle / units
   * @returns {{groups: Array<{key, unit, title, members}>, exceptions: Array}}
   */
  const groupNoEntryUsers = (users) => {
    const map = new Map();
    const exceptions = [];

    for (const u of users) {
      const units = u.units || [];
      const title = (u.jobTitle || '').trim();
      const unit = units[0] || '';
      // 職稱以「、」串接多個時，代表這人身兼數職，同樣無法機械式歸類
      if (units.length !== 1 || unit === UNGROUPED_LABEL || !title || title.includes('、')) {
        exceptions.push(u);
        continue;
      }
      // \u0000 不可能出現在單位或職稱裡，拿來當組合鍵的分隔字元最安全
      const key = `${unit}\u0000${title}`;
      if (!map.has(key)) map.set(key, { key, unit, title, members: [] });
      map.get(key).members.push(u);
    }

    const groups = [...map.values()].sort((a, b) =>
      a.unit.localeCompare(b.unit, 'zh-Hant') || a.title.localeCompare(b.title, 'zh-Hant'));
    exceptions.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-Hant'));
    return { groups, exceptions };
  };

```

接著把測試出口改成實際掛上函式。找到：

```javascript
  window.ApprovalRouting.CoverageInternals = Object.freeze({});
```

改為：

```javascript
  window.ApprovalRouting.CoverageInternals = Object.freeze({ groupNoEntryUsers });
```

- [ ] **Step 4: 跑測試確認通過**

```bash
npx vitest run tests/coverage-check.test.js
```

預期：PASS，8 passed

- [ ] **Step 5: 語法檢查**

```bash
node --check tools/05-coverage-check.js
```

預期：無輸出

- [ ] **Step 6: Commit**

```bash
git add tools/05-coverage-check.js tests/coverage-check.test.js
git commit -m "feat(tools): A 區人員依單位＋職稱分流的純函式

同單位同職稱的人起點角色必然相同，分組後一組只要選一次角色。
兼任多單位、職稱有多個、沒職稱、單位未分類的人無法機械式歸類，
另立例外區逐人手選。兩邊互斥，同一個人只會出現一次。"
```

---

### Task 3: 起點角色自動配對純函式 `matchEntryRole`

**Files:**
- Modify: `tools/05-coverage-check.js`（緊接在 `groupNoEntryUsers` 之後）
- Test: `tests/coverage-check.test.js`

**Interfaces:**
- Consumes: `model.roles` 的元素形狀（由 `fetchRoleCoverage` 產出）：`{ recordId, roleId, roleName, unitName, titleLevel, nextRoleId, holderType, holderUsers }`
- Produces: `matchEntryRole(unit, title, roles)` → `{ roleId: string, roleName: string, nextConsistent: boolean } | null`

- [ ] **Step 1: 寫失敗的測試**

在 `tests/coverage-check.test.js` 末尾追加：

```javascript
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
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
npx vitest run tests/coverage-check.test.js
```

預期：FAIL，`TypeError: Internals(...).matchEntryRole is not a function`

- [ ] **Step 3: 實作 `matchEntryRole`**

在 `groupNoEntryUsers` 結尾的 `};` **之後**插入：

```javascript
  /**
   * 依「單位＋職稱」在啟用角色裡找對應的起點角色
   *
   * 直接比 unit_name / title_level 兩個欄位，不去拆 role_name 字串——
   * role_name 是這兩欄組出來的計算欄位，比原始欄位才不會被分隔符號綁死。
   *
   * 同名角色有多筆是正常的（一筆記錄只掛一個人），固定取記錄編號最小者，
   * 讓每次執行的結果一致。
   *
   * @returns {{roleId, roleName, nextConsistent}|null} 配不到時回 null
   */
  const matchEntryRole = (unit, title, roles) => {
    const hits = roles
      .filter((r) => r.unitName === unit && r.titleLevel === title)
      .sort((a, b) => Number(a.recordId) - Number(b.recordId));
    if (!hits.length) return null;

    const picked = hits[0];
    const sameName = roles.filter((r) => r.roleName === picked.roleName);
    return {
      roleId: picked.roleId,
      roleName: picked.roleName,
      // 同名記錄的下一關不一致時，起點指到哪一筆會走出不同的鏈，要提醒 HR
      nextConsistent: new Set(sameName.map((r) => r.nextRoleId)).size <= 1,
    };
  };

```

再把出口補上：

```javascript
  window.ApprovalRouting.CoverageInternals = Object.freeze({ groupNoEntryUsers, matchEntryRole });
```

- [ ] **Step 4: 跑測試確認通過**

```bash
npx vitest run tests/coverage-check.test.js
```

預期：PASS，14 passed

- [ ] **Step 5: 語法檢查**

```bash
node --check tools/05-coverage-check.js
```

預期：無輸出

- [ ] **Step 6: Commit**

```bash
git add tools/05-coverage-check.js tests/coverage-check.test.js
git commit -m "feat(tools): 起點角色自動配對純函式

拿單位＋職稱去比 685 的 unit_name / title_level 兩個欄位，
不拆 role_name 字串。同名角色有多筆時固定取記錄編號最小者，
每次執行結果才會一致；同名記錄下一關不一致時一併回報，供 UI 提醒。"
```

---

### Task 4: `buildRoleCombo` 支援帶入預設值與向下展開

自動配對要把角色**帶入**每一列的下拉，但 `buildRoleCombo` 目前只能讀不能寫。它的面板也固定向上展開（原本只用在底部動作列），放進表格列會蓋掉上方內容。

另外 `buildRoleOptions` 同名去重時取「第一筆遇到的」`role_id`，而 `matchEntryRole` 取「記錄編號最小的」。兩者不一致的話 `setValue` 會找不到選項、看起來像沒配對到，所以一併統一。

**Files:**
- Modify: `tools/05-coverage-check.js`（`buildRoleCombo`、`buildRoleOptions`）

**Interfaces:**
- Consumes: 無
- Produces:
  - `buildRoleCombo(groups, onChange, { openUp = true, minWidth = '300px' } = {})` → `{ el, getValue, getLabel, setValue }`
  - `setValue(roleId)`：設定選取值但**不觸發** `onChange`（大量初始化時由呼叫端統一刷新一次）
  - `buildRoleOptions` 同名去重固定取記錄編號最小者，分組改用 `unitName`

- [ ] **Step 1: 讓 `buildRoleCombo` 接受選項參數**

找到：

```javascript
  const buildRoleCombo = (groups, onChange) => {
    const options = groups.flatMap((g) => g.items.map((it) => ({ ...it, unit: g.unit })));
```

改為：

```javascript
  const buildRoleCombo = (groups, onChange, { openUp = true, minWidth = '300px' } = {}) => {
    const options = groups.flatMap((g) => g.items.map((it) => ({ ...it, unit: g.unit })));
```

- [ ] **Step 2: 讓輸入框寬度與面板方向可調**

找到 input 的樣式：

```javascript
    input.style.cssText =
      'font-size:14px; padding:8px 10px; min-width:300px; box-sizing:border-box; ' +
      'border:1px solid #ccc; border-radius:6px;';
```

改為：

```javascript
    input.style.cssText =
      `font-size:14px; padding:8px 10px; min-width:${minWidth}; box-sizing:border-box; ` +
      'border:1px solid #ccc; border-radius:6px;';
```

再找到 panel 的樣式：

```javascript
    panel.style.cssText =
      'position:absolute; bottom:calc(100% + 4px); left:0; min-width:340px; max-height:300px; ' +
      'overflow-y:auto; background:#fff; border:1px solid #ccc; border-radius:6px; ' +
      'box-shadow:0 4px 16px rgba(0,0,0,.18); z-index:10; display:none;';
```

改為（表格列裡要向下展開，才不會蓋住上面的列）：

```javascript
    panel.style.cssText =
      'position:absolute; left:0; min-width:340px; max-height:300px; ' +
      `${openUp ? 'bottom' : 'top'}:calc(100% + 4px); ` +
      'overflow-y:auto; background:#fff; border:1px solid #ccc; border-radius:6px; ' +
      'box-shadow:0 4px 16px rgba(0,0,0,.18); z-index:10; display:none;';
```

- [ ] **Step 3: 加上 `setValue`**

找到函式結尾的 return：

```javascript
    wrap.append(input, panel);
    return {
      el: wrap,
      getValue: () => selected?.value || '',
      getLabel: () => selected?.label || '',
    };
  };
```

改為：

```javascript
    wrap.append(input, panel);
    return {
      el: wrap,
      getValue: () => selected?.value || '',
      getLabel: () => selected?.label || '',
      /**
       * 由外部指定選取值（自動配對帶入用）。
       * 刻意不觸發 onChange——大量初始化時由呼叫端最後統一刷新一次即可。
       * 傳入的值找不到對應選項時視為未選取。
       */
      setValue: (value) => {
        const o = options.find((x) => x.value === value);
        selected = o ? { value: o.value, label: o.label } : null;
        input.value = selected?.label || '';
      },
    };
  };
```

- [ ] **Step 4: 統一 `buildRoleOptions` 的取值與分組**

找到：

```javascript
  const buildRoleOptions = (roles, { userTypeOnly = false, valueBy = 'roleId' } = {}) => {
    const seen = new Set();
    const groups = new Map();
    for (const r of roles) {
      if (userTypeOnly && r.holderType !== HT.USER) continue;
      if (seen.has(r.roleName)) continue;
      seen.add(r.roleName);
      const unit = r.roleName.split('_')[0] || UNGROUPED_LABEL;
```

改為：

```javascript
  const buildRoleOptions = (roles, { userTypeOnly = false, valueBy = 'roleId' } = {}) => {
    const seen = new Set();
    const groups = new Map();
    // 同名角色有多筆時固定取記錄編號最小者，與 matchEntryRole 的選法一致，
    // 自動配對帶入的 role_id 才一定找得到對應選項
    const sorted = [...roles].sort((a, b) => Number(a.recordId) - Number(b.recordId));
    for (const r of sorted) {
      if (userTypeOnly && r.holderType !== HT.USER) continue;
      if (seen.has(r.roleName)) continue;
      seen.add(r.roleName);
      // 直接用 unit_name 欄位，不從 role_name 切字串（分隔符號不見得是底線）
      const unit = r.unitName || UNGROUPED_LABEL;
```

- [ ] **Step 5: 語法檢查與回歸測試**

```bash
node --check tools/05-coverage-check.js
```

預期：無輸出

```bash
npx vitest run
```

預期：全部 PASS（既有 api-client / chain-builder 測試不受影響）

- [ ] **Step 6: Commit**

```bash
git add tools/05-coverage-check.js
git commit -m "refactor(tools): 角色選擇器支援帶入預設值與向下展開

自動配對要把角色寫進每一列的下拉，所以補上 setValue；
放在表格列裡的面板改成向下展開，不會蓋住上方的列。
同時把角色選項的同名去重改成固定取記錄編號最小者，
與自動配對的選法一致，帶入的值才一定找得到選項；
分組也改用 unit_name 欄位，不再從 role_name 切字串。"
```

---

### Task 5: A 分頁專屬渲染 `buildEntryTab`

**Files:**
- Modify: `tools/05-coverage-check.js`（新增於 `groupNoEntryUsers` 之前）

**Interfaces:**
- Consumes: `groupNoEntryUsers(users)`、`matchEntryRole(unit, title, roles)`、`buildRoleCombo(groups, onChange, opts)`、`esc(s)`
- Produces: `buildEntryTab({ users, roles, roleOptions, onAction, onExport })` → `HTMLElement`
  - `onAction(pairs, skipped)`：`pairs` 為 `Array<{code: string, roleId: string}>`；`skipped` 為尚未指定角色的列數
  - `onExport(members)`：`members` 為目前顯示中所有列展開後的人員物件陣列

- [ ] **Step 1: 實作 `buildEntryTab`**

在 `tools/05-coverage-check.js` 中找到這一行（Task 2、3 完成後，它就落在 `matchEntryRole` 的下方）：

```javascript
  /** 由角色清單組出選擇器選項（依單位分組、同名去重；filter 可再限縮類型） */
```

在它**之前**插入整個函式：

```javascript
  /**
   * A 分頁：未設定起點（依「單位＋職稱」分組，可跨多個單位一次建立）
   *
   * 主表一組一列，自動配到的角色先帶入，配不到的整列標紅且勾不動；
   * 兼任多單位／多職稱／資料不全者另立一區逐人手選。
   *
   * DOM 只建一次，搜尋與篩選僅切換每列的 display——整個重建會把使用者
   * 已經挑好的角色一起洗掉。
   */
  const buildEntryTab = ({ users, roles, roleOptions, onAction, onExport }) => {
    const { groups, exceptions } = groupNoEntryUsers(users);

    const rows = [
      ...groups.map((g) => ({
        id: `g:${g.key}`, isException: false,
        unit: g.unit, title: g.title, members: g.members,
        match: matchEntryRole(g.unit, g.title, roles),
      })),
      ...exceptions.map((u) => ({
        id: `u:${u.code}`, isException: true,
        unit: (u.units || []).join('、'), title: u.jobTitle || '', members: [u],
        match: null,   // 單位／職稱本來就不明確，不做自動配對
      })),
    ];

    const root = document.createElement('div');
    root.style.cssText = 'display:flex; flex-direction:column; height:100%;';

    // ── 工具列（分組後列數已大幅減少，不再需要單位篩選下拉）──
    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'display:flex; gap:12px; align-items:center; margin-bottom:10px; flex-wrap:wrap;';
    toolbar.innerHTML = `
      <input data-role="search" type="text" placeholder="搜尋單位、職稱、姓名或帳號…"
             style="font-size:14px; padding:6px 10px; border:1px solid #ccc; border-radius:4px; min-width:240px;">
      <label style="font-size:14px;"><input type="checkbox" data-role="only-unset"> 只看尚未指定</label>
      <label style="font-size:14px;"><input type="checkbox" data-role="check-all"> 全選（目前顯示且已指定）</label>
      <span data-role="count" style="font-size:13px; color:#666; margin-left:auto;"></span>
    `;

    // ── 表格 ──
    const listWrap = document.createElement('div');
    listWrap.style.cssText = 'flex:1; overflow-y:auto; border:1px solid #e0e0e0; border-radius:6px;';
    const table = document.createElement('table');
    table.style.cssText = 'width:100%; border-collapse:collapse; font-size:14px;';
    table.innerHTML = `
      <thead>
        <tr style="background:#f5f5f5; position:sticky; top:0; z-index:2;">
          <th style="padding:8px; width:36px;"></th>
          <th style="padding:8px; text-align:left;">單位</th>
          <th style="padding:8px; text-align:left;">職稱</th>
          <th style="padding:8px; text-align:right; width:64px;">人數</th>
          <th style="padding:8px; text-align:left;">起點角色</th>
        </tr>
      </thead>
      <tbody></tbody>`;
    listWrap.appendChild(table);
    const tbody = table.querySelector('tbody');

    // ── 底部動作列 ──
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex; gap:12px; align-items:center; margin-top:12px; flex-wrap:wrap;';
    const actionBtn = document.createElement('button');
    actionBtn.style.cssText =
      'font-size:15px; padding:10px 24px; background:#3498db; color:#fff; border:none; border-radius:6px; cursor:pointer;';
    const exportBtn = document.createElement('button');
    exportBtn.textContent = '匯出 CSV';
    exportBtn.style.cssText =
      'font-size:14px; padding:10px 18px; background:#fff; color:#333; border:1px solid #ccc; border-radius:6px; cursor:pointer; margin-left:auto;';

    const state = new Map();   // row.id → { row, tr, combo, cb }
    let dividerTr = null;

    /** 依搜尋與篩選切換每列顯示，並更新計數與按鈕狀態 */
    const refresh = () => {
      const kw = toolbar.querySelector('[data-role="search"]').value.trim();
      const onlyUnset = toolbar.querySelector('[data-role="only-unset"]').checked;

      let assigned = 0;
      let pickedRows = 0;
      let pickedPeople = 0;
      let exceptionVisible = false;

      for (const s of state.values()) {
        const hasRole = Boolean(s.combo.getValue());
        if (hasRole) assigned += 1;

        // 沒指定角色就勾不動，不可能送出不完整的資料
        s.cb.disabled = !hasRole;
        if (!hasRole && s.cb.checked) s.cb.checked = false;
        s.tr.style.background = hasRole ? '' : '#fdecea';

        const haystack = [s.row.unit, s.row.title,
          ...s.row.members.map((m) => `${m.name} ${m.code}`)].join(' ');
        const show = (!kw || haystack.includes(kw)) && (!onlyUnset || !hasRole);
        s.tr.style.display = show ? '' : 'none';
        if (show && s.row.isException) exceptionVisible = true;

        if (s.cb.checked) {
          pickedRows += 1;
          pickedPeople += s.row.members.length;
        }
      }

      if (dividerTr) dividerTr.style.display = exceptionVisible ? '' : 'none';

      toolbar.querySelector('[data-role="count"]').textContent =
        `已指定 ${assigned}/${state.size} 列・已勾選 ${pickedRows} 列（${pickedPeople} 人）`;
      actionBtn.textContent = pickedPeople
        ? `一次建立 ${pickedPeople} 筆起點設定`
        : '一次建立起點設定';
      actionBtn.disabled = pickedRows === 0;
      actionBtn.style.opacity = actionBtn.disabled ? '0.5' : '1';
    };

    /** 例外區的分隔標題列 */
    const appendDivider = (text) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td colspan="5" style="padding:8px 10px; background:#f7f9fc; border-top:1px solid #e5e7eb; font-size:13px; font-weight:700; color:#555;">${esc(text)}</td>`;
      tbody.appendChild(tr);
      return tr;
    };

    const appendRow = (row) => {
      const tr = document.createElement('tr');
      tr.style.borderTop = '1px solid #eee';

      const tdCheck = document.createElement('td');
      tdCheck.style.cssText = 'padding:6px 8px; text-align:center;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.addEventListener('change', () => refresh());
      tdCheck.appendChild(cb);

      const tdUnit = document.createElement('td');
      tdUnit.style.cssText = 'padding:6px 8px;';
      tdUnit.textContent = row.unit || '—';

      const tdTitle = document.createElement('td');
      tdTitle.style.cssText = 'padding:6px 8px;';
      tdTitle.innerHTML = row.title
        ? `<span style="display:inline-block; padding:1px 8px; border-radius:4px; background:#eef2ff; border:1px solid #c7d2fe; color:#3730a3; font-weight:600;">${esc(row.title)}</span>`
        : '<span style="color:#bbb;">—</span>';

      const tdCount = document.createElement('td');
      tdCount.style.cssText = 'padding:6px 8px; text-align:right;';
      tdCount.textContent = String(row.members.length);
      // 滑過去看得到這組是誰，送出前可以確認
      tdCount.title = row.members.map((m) => `${m.name}（${m.code}）`).join('\n');

      const tdRole = document.createElement('td');
      tdRole.style.cssText = 'padding:6px 8px;';
      const combo = buildRoleCombo(roleOptions, () => refresh(), { openUp: false, minWidth: '260px' });
      if (row.match) combo.setValue(row.match.roleId);
      tdRole.appendChild(combo.el);

      // 同名記錄的下一關不一致，起點指到哪一筆會走出不同的鏈
      if (row.match && !row.match.nextConsistent) {
        const warn = document.createElement('div');
        warn.textContent = '同名角色的下一關設定不一致，建議先用「批次設定下一關」統一';
        warn.style.cssText = 'margin-top:4px; font-size:12px; color:#92400e;';
        tdRole.appendChild(warn);
      }

      tr.append(tdCheck, tdUnit, tdTitle, tdCount, tdRole);
      tbody.appendChild(tr);
      state.set(row.id, { row, tr, combo, cb });
    };

    rows.filter((r) => !r.isException).forEach(appendRow);
    const exceptionRows = rows.filter((r) => r.isException);
    if (exceptionRows.length) {
      dividerTr = appendDivider(
        `兼任多單位／多職稱／資料不全（${exceptionRows.length} 人）— 請逐人指定`);
      exceptionRows.forEach(appendRow);
    }
    if (!rows.length) {
      tbody.innerHTML =
        '<tr><td colspan="5" style="padding:16px; color:#999; text-align:center;">沒有未設定起點的人員</td></tr>';
    }

    toolbar.querySelector('[data-role="search"]').addEventListener('input', refresh);
    toolbar.querySelector('[data-role="only-unset"]').addEventListener('change', refresh);
    toolbar.querySelector('[data-role="check-all"]').addEventListener('change', (e) => {
      for (const s of state.values()) {
        if (s.tr.style.display === 'none' || s.cb.disabled) continue;
        s.cb.checked = e.target.checked;
      }
      refresh();
    });

    actionBtn.addEventListener('click', () => {
      const pairs = [];
      for (const s of state.values()) {
        const roleId = s.combo.getValue();
        if (!s.cb.checked || !roleId) continue;
        for (const m of s.row.members) pairs.push({ code: m.code, roleId });
      }
      const skipped = [...state.values()].filter((s) => !s.combo.getValue()).length;
      onAction(pairs, skipped);
    });

    exportBtn.addEventListener('click', () => {
      const members = [...state.values()]
        .filter((s) => s.tr.style.display !== 'none')
        .flatMap((s) => s.row.members);
      onExport(members);
    });

    footer.append(actionBtn, exportBtn);
    root.append(toolbar, listWrap, footer);
    root.dataset.tab = 'A';
    refresh();
    return root;
  };

```

- [ ] **Step 2: 語法檢查**

```bash
node --check tools/05-coverage-check.js
```

預期：無輸出

- [ ] **Step 3: 回歸測試**

```bash
npx vitest run
```

預期：全部 PASS（此步只確認新程式碼沒有破壞既有載入）

- [ ] **Step 4: Commit**

```bash
git add tools/05-coverage-check.js
git commit -m "feat(tools): A 分頁改用分組式的專屬渲染

一組一列，自動配到的角色直接帶入，配不到的整列標紅且勾不動，
逼使用者先指定才送得出去。兼任多單位或資料不全的人另立一區逐人選。
DOM 只建一次，搜尋與篩選只切換顯示，不會把已經挑好的角色洗掉。"
```

---

### Task 6: 寫入函式與 A 分頁接線

**Files:**
- Modify: `tools/05-coverage-check.js`（`createEntries` 換成 `createEntriesFromPairs`；`tabA` 改用 `buildEntryTab`）

**Interfaces:**
- Consumes: `buildEntryTab`、`chunk`、`kintoneApi`、`CONFIG.WRITE_BATCH`、`EF`、`CHECKBOX`、`APP_ID`
- Produces: `createEntriesFromPairs(pairs)` → `Promise<number>`（實際建立的筆數）

- [ ] **Step 1: 換掉寫入函式**

找到：

```javascript
  /** A 區：批量建立 686 起點記錄 */
  const createEntries = async (userCodes, roleId) => {
    for (const part of chunk(userCodes, CONFIG.WRITE_BATCH)) {
      await kintoneApi('/k/v1/records', 'POST', {
        app: APP_ID.EMPLOYEE_ENTRY,
        records: part.map((code) => ({
          [EF.EMPLOYEE]:      { value: [{ code }] },
          [EF.ENTRY_ROLE_ID]: { value: roleId },
          [EF.IS_ACTIVE]:     { value: [CHECKBOX.ACTIVE] },
        })),
      });
    }
  };
```

整段換成：

```javascript
  /**
   * A 區：依 {code, roleId} 清單批量建立 686 起點記錄
   *
   * 每個人的起點角色可以不同，所以一次能跨多個單位建立。
   */
  const createEntriesFromPairs = async (pairs) => {
    // 分區已經互斥，這裡再對帳號去重一次當保險——686 是一人一筆起點，
    // 同一個人建出兩筆，之後查起點取到哪一筆就變成看運氣
    const byCode = new Map();
    for (const p of pairs) if (!byCode.has(p.code)) byCode.set(p.code, p.roleId);

    const records = [...byCode.entries()].map(([code, roleId]) => ({
      [EF.EMPLOYEE]:      { value: [{ code }] },
      [EF.ENTRY_ROLE_ID]: { value: roleId },
      [EF.IS_ACTIVE]:     { value: [CHECKBOX.ACTIVE] },
    }));

    for (const part of chunk(records, CONFIG.WRITE_BATCH)) {
      await kintoneApi('/k/v1/records', 'POST', {
        app: APP_ID.EMPLOYEE_ENTRY,
        records: part,
      });
    }
    return records.length;
  };
```

- [ ] **Step 2: 換掉 A 分頁的建構**

找到整段：

```javascript
    const tabA = buildTab({
      key: 'A',
      users: model.noEntry,
      roleOptions: buildRoleOptions(model.roles, { valueBy: 'roleId' }),
      actionLabel: '建立起點設定',
      onAction: async (codes, roleId, roleLabel) => {
        if (!codes.length || !roleId) return;
        const ok = (await Swal.fire({
          icon: 'question',
          title: `建立 ${codes.length} 筆起點設定？`,
          html: `起點角色：<strong>${esc(roleLabel)}</strong><br>對象：${codes.length} 人`,
          showCancelButton: true, confirmButtonText: '確定建立', cancelButtonText: '取消',
        })).isConfirmed;
        if (!ok) return;

        Swal.fire({ title: '建立中…', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        await createEntries(codes, roleId);
        await Swal.fire({ icon: 'success', title: `已建立 ${codes.length} 筆起點設定`, timer: 1800, showConfirmButton: false });
        rescan(); // 重新掃描刷新報告
      },
      onExport: (rows) => exportCsv(rows, `未設定起點_${new Date().toISOString().slice(0, 10)}.csv`),
    });
```

整段換成：

```javascript
    const tabA = buildEntryTab({
      users: model.noEntry,
      roles: model.roles,
      roleOptions: buildRoleOptions(model.roles, { valueBy: 'roleId' }),
      onAction: async (pairs, skipped) => {
        if (!pairs.length) return;
        const people = new Set(pairs.map((p) => p.code)).size;

        const ok = (await Swal.fire({
          icon: 'question',
          title: `建立 ${people} 筆起點設定？`,
          html:
            `<div style="text-align:left;">` +
            `這批涵蓋 <strong>${people}</strong> 位同仁，每人各建一筆，同一個人不會重複建立。` +
            (skipped
              ? `<br><span style="color:#92400e;">另有 ${skipped} 列還沒指定起點角色，這次會略過。</span>`
              : '') +
            `</div>`,
          width: '560px',
          showCancelButton: true, confirmButtonText: '確定建立', cancelButtonText: '取消',
        })).isConfirmed;
        if (!ok) return;

        Swal.fire({ title: '建立中…', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        const created = await createEntriesFromPairs(pairs);
        await Swal.fire({
          icon: 'success',
          title: `已建立 ${created} 筆起點設定`,
          timer: 2000, showConfirmButton: false,
        });
        rescan(); // 重新掃描刷新報告
      },
      onExport: (rows) => exportCsv(rows, `未設定起點_${new Date().toISOString().slice(0, 10)}.csv`),
    });
```

- [ ] **Step 3: 確認舊識別字已清乾淨**

```bash
grep -n "createEntries\b" tools/05-coverage-check.js
```

預期：無輸出（舊的 `createEntries` 已完全移除）

- [ ] **Step 4: 語法檢查與回歸測試**

```bash
node --check tools/05-coverage-check.js
```

預期：無輸出

```bash
npx vitest run
```

預期：全部 PASS

- [ ] **Step 5: Commit**

```bash
git add tools/05-coverage-check.js
git commit -m "feat(tools): A 區一次建立跨單位的起點設定

寫入改成吃 {帳號, 起點角色} 清單，每個人的起點角色可以不同，
所以多個單位能一次送出。送出前再對帳號去重一次，
686 是一人一筆起點，重複建會讓之後查起點取到哪一筆變成看運氣。
確認視窗會說明涵蓋幾人，以及有幾列因為還沒指定角色被略過。"
```

---

### Task 7: 檔頭註解與專案文件同步

**Files:**
- Modify: `tools/05-coverage-check.js`（檔頭註解）
- Modify: `docs/Phase進度追蹤.md`

**Interfaces:**
- Consumes: 無
- Produces: 無

- [ ] **Step 1: 更新檔頭的 A 區說明**

找到：

```
 *   A. 未設定起點 — 使用中、但 686 沒有起點記錄的人（無法送單，最優先處理）
 *        → 勾選多人 + 選一個起點角色 → 批量建立 686 記錄
```

改為：

```
 *   A. 未設定起點 — 使用中、但 686 沒有起點記錄的人（無法送單，最優先處理）
 *        → 依「單位＋職稱」分組，一組一列各選起點角色，可**跨多個單位一次建立**
 *          （同單位同職稱的人起點必然相同，所以一組只要選一次；
 *            比對 685 的 unit_name / title_level 自動帶入，配不到的整列標紅且勾不動；
 *            兼任多單位／多職稱／資料不全者另立一區逐人手選，兩區互斥不會重複建）
```

- [ ] **Step 2: 更新檔頭的「影響的欄位」**

找到：

```
 *   - 686 employee / entry_role_id / is_active：A 區批量建立寫入；C 區取消啟用中
```

改為：

```
 *   - 686 employee / entry_role_id / is_active：A 區批量建立寫入（每人一筆，
 *     起點角色可逐列不同）；C 區取消啟用中
```

- [ ] **Step 3: 補變更履歷**

在檔頭 `【變更履歷】` 的最後一行之後、`*/` 之前插入：

```
 *   2026-08-19  Jimmy/Claude  A 區改為依「單位＋職稱」分組，可跨多個單位一次建立起點。
 *                             原本一次只能選一個起點角色，單位一多就要重複做很多輪。
 *                             自動配對只比 unit_name / title_level 欄位，不拆 role_name
```

- [ ] **Step 4: 更新進度追蹤**

在 `docs/Phase進度追蹤.md` 找到：

```
  - A 區「未設定起點」：顯示單位、可依單位篩選勾選 → 選起點角色一鍵批量建立 686 記錄
```

改為：

```
  - A 區「未設定起點」：依「單位＋職稱」分組，一組一列各選起點角色，
    **可跨多個單位一次建立** 686 記錄 ✅ 2026-08-19 改版
    - 同單位同職稱的人起點必然相同，所以一組只要選一次；比對 685 的
      unit_name / title_level 自動帶入，配不到的整列標紅且勾不動
    - 兼任多單位／多職稱／資料不全者另立一區逐人手選；兩區互斥 + 送出前帳號去重，
      同一個人不會被建出兩筆起點
    - 原本一次只能選一個起點角色，跨多單位要一個單位做一輪
```

- [ ] **Step 5: 語法檢查**

```bash
node --check tools/05-coverage-check.js
```

預期：無輸出

- [ ] **Step 6: Commit**

```bash
git add tools/05-coverage-check.js docs/Phase進度追蹤.md
git commit -m "docs: A 區改版的檔頭註解與進度追蹤同步"
```

---

## 人工驗收（上傳 kintone 後）

自動化測試碰不到真的 kintone，以下由 Jimmy 在 685 或 686 清單頁實測，對照 spec 的驗收條件：

- [ ] 開啟「未設定名單」→ A 分頁，列數明顯少於人數；各組人數加總 + 例外區人數 = 分頁標題的總人數
- [ ] 職稱與 `title_level` 吻合的組，一開啟角色欄就已經帶好
- [ ] 配不到的組整列紅底，checkbox 點不動
- [ ] 滑過「人數」欄，tooltip 列出該組是誰
- [ ] 勾選多個**不同單位**的組 → 按一次建立 → 686 一次生出全部記錄，每人剛好一筆
- [ ] 重新掃描後，這些人不再出現在 A 區
- [ ] 搜尋框輸入單位、職稱、姓名、帳號都能命中
- [ ] 勾「只看尚未指定」後只剩紅底的列
- [ ] 展開角色下拉時面板向下開，不會蓋住上面的列
