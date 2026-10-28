# role_name 可搜尋選單 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 App 685 角色定義表的新增/編輯頁，以可搜尋的 `<input>+<datalist>` 替換 `unit_name` 和 `title_level` 的原生下拉選單，選定後自動寫回欄位，submit 時驗證兩者必填。

**Architecture:** 新增 `apps/role-definition/07-role-name-selector.js`，於 `create.show` / `edit.show` 事件讀取原生 select 選項後隱藏原生欄位，插入可搜尋 input+datalist；使用者選定有效值後透過 `kintone.app.record.set` 寫回；submit 事件驗證必填，缺失時彈 SweetAlert 並 return null 中止儲存。`role_name` 為 kintone 計算欄位，JS 完全不碰。

**Tech Stack:** kintone JS customization API（`kintone.app.record.*`）、ES2020+、IIFE、SweetAlert2（已全域載入）
> 注：此 feature 為純 DOM 操作，不寫 Vitest 單元測試；驗收在 kintone 瀏覽器執行（Task 3）。

---

## 前置條件（Jimmy 在 kintone 後台完成，才能執行此計畫）

1. App 685 已新增 `unit_name`（下拉式選單）欄位，含公司所有單位選項
2. App 685 已新增 `title_level`（下拉式選單）欄位，含固定六個職級選項
3. 所有現有角色記錄已填入 `unit_name` + `title_level`（資料遷移）
4. `role_name` 已改為計算欄位，公式 `unit_name & "_" & title_level`，確認計算正確

> ⚠️ 若前置條件未完成，JS 上傳後選單清單將為空，`unit_name`/`title_level` 欄位也不存在。

---

## 檔案對照

| 動作 | 檔案 | 說明 |
|------|------|------|
| **修改** | `core/01-config.js` | 新增 `UNIT_NAME`、`TITLE_LEVEL` 欄位代碼；新增 `TITLE_LEVEL_OPTIONS` 固定清單 |
| **新增** | `apps/role-definition/07-role-name-selector.js` | 可搜尋 UI 注入 + submit 驗證 |

---

## Task 1：更新 `core/01-config.js`

**Files:**
- Modify: `core/01-config.js`

- [ ] **Step 1：在 ROLE_FIELDS 加入兩個新欄位代碼**

  找到 `const ROLE_FIELDS = Object.freeze({` 區塊，在 `ROLE_ID` 後加入：

  ```javascript
  const ROLE_FIELDS = Object.freeze({
    ROLE_ID:        'role_id',
    ROLE_NAME:      'role_name',
    UNIT_NAME:      'unit_name',      // ← 新增
    TITLE_LEVEL:    'title_level',    // ← 新增
    HOLDER_TYPE:    'holder_type',
    HOLDER_GROUP:   'holder_group',
    HOLDER_USER:    'holder_user',
    NEXT_ROLE_ID:   'next_role_id',
    IS_CHAIN_END:   'is_chain_end',
    SIGNING_MODE:   'signing_mode',
    IS_ACTIVE:      'is_active',
  });
  ```

- [ ] **Step 2：新增 TITLE_LEVEL_OPTIONS 固定清單**

  在 `SIGNING_MODE_OPTIONS` 常數之後加入：

  ```javascript
  /** title_level 固定職級選項（由低至高） */
  const TITLE_LEVEL_OPTIONS = Object.freeze([
    '課長', '次長', '部長', '部門長', '本部長', '總經理',
  ]);
  ```

- [ ] **Step 3：將 TITLE_LEVEL_OPTIONS 掛到 Config 物件**

  找到 `window.ApprovalRouting.Config = Object.freeze({` 區塊，加入：

  ```javascript
  window.ApprovalRouting.Config = Object.freeze({
    APP_ID,
    ROLE_FIELDS,
    HOLDER_TYPE_OPTIONS,
    CHECKBOX,
    SIGNING_MODE_OPTIONS,
    TITLE_LEVEL_OPTIONS,   // ← 新增
    ENTRY_FIELDS,
    CHAIN_FIELDS,
    ROLE_ID_PREFIX,
  });
  ```

- [ ] **Step 4：確認語法無誤，commit**

  ```bash
  git add core/01-config.js
  git commit -m "feat(config): 新增 unit_name/title_level 欄位代碼與 TITLE_LEVEL_OPTIONS"
  ```

---

## Task 2：建立 `07-role-name-selector.js` 完整實作

**Files:**
- Create: `apps/role-definition/07-role-name-selector.js`

- [ ] **Step 1：建立完整檔案**

  建立 `apps/role-definition/07-role-name-selector.js`，內容如下：

  ```javascript
  /**
   * 角色定義表 — role_name 可搜尋選單
   *
   * 【影響的欄位】
   *   - unit_name:   隱藏原生下拉，注入可搜尋 input+datalist
   *   - title_level: 隱藏原生下拉，注入可搜尋 input+datalist（固定六選項）
   *   - role_name:   計算欄位，JS 不碰
   *
   * 【依賴】
   *   - core/01-config.js（Config.ROLE_FIELDS, Config.TITLE_LEVEL_OPTIONS）
   *   - core/04-utils.js（Utils.safeHandler）
   *
   * 【變更履歷】
   *   2026-04-27  Jimmy/Claude  初版建立
   */
  (() => {
    'use strict';

    const { ROLE_FIELDS: F, TITLE_LEVEL_OPTIONS } = window.ApprovalRouting.Config;
    const { safeHandler } = window.ApprovalRouting.Utils;

    const CONFIG = Object.freeze({
      UNIT_INPUT_ID:  'ar-unit-search',
      TITLE_INPUT_ID: 'ar-title-search',
      INPUT_STYLE: [
        'width:100%',
        'padding:10px 14px',
        'font-size:15px',
        'border:2px solid #b0bec5',
        'border-radius:6px',
        'box-sizing:border-box',
        'background:#fff',
      ].join(';'),
    });

    // ─── 工具函式 ───────────────────────────────────────────

    /**
     * 從原生 <select> 讀取所有選項值（必須在 setFieldShown=false 之前呼叫）
     * @param {string} fieldCode
     * @returns {string[]}
     */
    const readNativeOptions = (fieldCode) => {
      const fieldEl = kintone.app.record.getFieldElement(fieldCode);
      if (!fieldEl) return [];
      const select = fieldEl.querySelector('select');
      if (!select) return [];
      return [...select.options].map((o) => o.value).filter((v) => v !== '');
    };

    /**
     * 隱藏原生欄位，並在其前方插入可搜尋 input+datalist
     * @param {string}   fieldCode    - kintone 欄位代碼
     * @param {string}   inputId      - 注入 input 的 DOM id
     * @param {string[]} options      - 下拉選項清單
     * @param {string}   currentValue - 預填值（編輯頁用，空字串則空白）
     * @param {string}   placeholder  - 輸入框提示文字
     */
    const injectSearchInput = (fieldCode, inputId, options, currentValue, placeholder) => {
      if (document.getElementById(inputId)) return; // 避免重複注入

      const fieldEl = kintone.app.record.getFieldElement(fieldCode);
      if (!fieldEl) {
        console.warn(`[AR-07] 找不到欄位 ${fieldCode}，請確認 kintone 後台已新增此欄位`);
        return;
      }

      kintone.app.record.setFieldShown(fieldCode, false);

      const listId = `${inputId}-list`;

      const input = document.createElement('input');
      input.type        = 'text';
      input.id          = inputId;
      input.placeholder = placeholder;
      input.value       = currentValue || '';
      input.setAttribute('list', listId);
      input.style.cssText = CONFIG.INPUT_STYLE;

      const datalist = document.createElement('datalist');
      datalist.id = listId;
      options.forEach((opt) => {
        const option   = document.createElement('option');
        option.value   = opt;
        datalist.appendChild(option);
      });

      // 使用者選定後寫回 kintone 欄位（只有在選項清單內才接受）
      input.addEventListener('change', () => {
        if (!options.includes(input.value)) return;
        kintone.app.record.set({
          record: { [fieldCode]: { value: input.value } },
        });
      });

      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'margin-bottom:8px;';
      wrapper.appendChild(input);
      wrapper.appendChild(datalist);

      // 插入在原生欄位容器之前
      fieldEl.parentElement.insertBefore(wrapper, fieldEl);
    };

    // ─── 主要邏輯 ───────────────────────────────────────────

    const mountSelectorUI = (record) => {
      // unit_name：從原生 select 讀取選項（IT 在 App 設定維護）
      const unitOptions  = readNativeOptions(F.UNIT_NAME);
      const currentUnit  = record[F.UNIT_NAME]?.value  || '';

      // title_level：固定清單，直接使用 Config 常數
      const titleOptions = [...TITLE_LEVEL_OPTIONS];
      const currentTitle = record[F.TITLE_LEVEL]?.value || '';

      injectSearchInput(
        F.UNIT_NAME,
        CONFIG.UNIT_INPUT_ID,
        unitOptions,
        currentUnit,
        '輸入單位名稱（如 MIS、HR…）',
      );

      injectSearchInput(
        F.TITLE_LEVEL,
        CONFIG.TITLE_INPUT_ID,
        titleOptions,
        currentTitle,
        '輸入職級（如 課長、部長…）',
      );
    };

    // ─── 事件綁定 ───────────────────────────────────────────

    // 新增 / 編輯頁：注入可搜尋 UI
    kintone.events.on(
      ['app.record.create.show', 'app.record.edit.show'],
      safeHandler(async (event) => {
        mountSelectorUI(event.record);
        return event;
      }),
    );

    // 送出前驗證：unit_name + title_level 均不可為空
    kintone.events.on(
      ['app.record.create.submit', 'app.record.edit.submit'],
      safeHandler(async (event) => {
        const record   = event.record;
        const unitVal  = record[F.UNIT_NAME]?.value  || '';
        const titleVal = record[F.TITLE_LEVEL]?.value || '';

        if (unitVal && titleVal) return event; // 正常通過

        const missing = [];
        if (!unitVal)  missing.push('單位名稱');
        if (!titleVal) missing.push('職級');

        await Swal.fire({
          icon:             'warning',
          title:            '必填欄位未填寫',
          html:             `請填寫：<strong>${missing.join('、')}</strong>`,
          confirmButtonText: '確定',
        });

        return null; // null = 中止儲存
      }),
    );
  })();
  ```

- [ ] **Step 2：確認語法正確（無 typo、大括號對齊），commit**

  ```bash
  git add apps/role-definition/07-role-name-selector.js
  git commit -m "feat(role-def): 新增 07-role-name-selector.js 可搜尋單位+職級選單"
  ```

---

## Task 3：瀏覽器驗收測試（上傳 kintone）

> 此 Task 為手動操作，無法自動化。需 Jimmy 上傳後在 kintone 瀏覽器驗證。

**上傳檔案順序（App 685）：**
1. `core/01-config.js`（Task 1 更新後版本）
2. `apps/role-definition/07-role-name-selector.js`

- [ ] **Step 1：驗收「新增頁」**

  前往 App 685 新增頁：
  - `unit_name` 欄位消失，出現文字輸入框
  - 輸入「M」→ 過濾出含 M 的單位選項
  - 選定後切換到 `title_level` 輸入框
  - 輸入「課」→ 顯示「課長」
  - 選定後 `role_name` 計算欄位自動顯示 `MIS_課長`

- [ ] **Step 2：驗收「編輯頁」**

  開啟現有角色記錄的編輯頁：
  - 輸入框顯示現有的 `unit_name` 和 `title_level` 值
  - 修改後 `role_name` 即時更新

- [ ] **Step 3：驗收「必填驗證」**

  清空 unit_name 輸入框（直接刪除文字），直接按儲存：
  - 出現 SweetAlert 提示「請填寫：單位名稱」
  - 儲存被攔截，不送出

- [ ] **Step 4：更新 Phase 進度追蹤**

  在 `docs/Phase進度追蹤.md` 的 P1 清單補上：
  ```
  - [x] `apps/role-definition/07-role-name-selector.js` — role_name 可搜尋選單 ✅ YYYY-MM-DD
  ```

  ```bash
  git add docs/Phase進度追蹤.md
  git commit -m "docs: 更新 P1 進度 — 07-role-name-selector.js 完成"
  git push origin main
  ```

---

## 補充：`core/01-config.js` 完整修改後樣貌（Task 1 參考）

```javascript
const ROLE_FIELDS = Object.freeze({
  ROLE_ID:        'role_id',
  ROLE_NAME:      'role_name',
  UNIT_NAME:      'unit_name',
  TITLE_LEVEL:    'title_level',
  HOLDER_TYPE:    'holder_type',
  HOLDER_GROUP:   'holder_group',
  HOLDER_USER:    'holder_user',
  NEXT_ROLE_ID:   'next_role_id',
  IS_CHAIN_END:   'is_chain_end',
  SIGNING_MODE:   'signing_mode',
  IS_ACTIVE:      'is_active',
});

/** title_level 固定職級選項（由低至高） */
const TITLE_LEVEL_OPTIONS = Object.freeze([
  '課長', '次長', '部長', '部門長', '本部長', '總經理',
]);

// ...（其他常數不動）

window.ApprovalRouting.Config = Object.freeze({
  APP_ID,
  ROLE_FIELDS,
  HOLDER_TYPE_OPTIONS,
  CHECKBOX,
  SIGNING_MODE_OPTIONS,
  TITLE_LEVEL_OPTIONS,
  ENTRY_FIELDS,
  CHAIN_FIELDS,
  ROLE_ID_PREFIX,
});
```
