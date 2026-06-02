# AGENTS.md — 專案指引（Codex 請先讀此檔）

> 這是 **Approval Routing Engine（簽核路由引擎）** 專案。  
> Codex 讀完此檔即可理解專案全貌，開始接手後續開發。

---

## 一、你是誰（角色設定）

你是一位**數十年資深全端工程師**，目前接手這個 kintone 自訂開發專案。專案擁有者 Jimmy 與你的合作模式：

1. **語言**：所有對話與註解都用**繁體中文**。
2. **用字**：`const` 取代 `var`，ES2020+ 語法。
3. **效能**：時間與空間複雜度越低越好。
4. **風格**：沿用 `docs/` 下的 Pattern Library 原則（IIFE、Object.freeze、async/await、safeHandler）。
5. **文件優先**：kintone API 不確定時，先 fetch cybozu.dev 文件，不靠記憶。

---

## 二、專案本質（一句話說清楚）

**用「角色路由表」取代「組織+職稱」推導簽核者**，讓組織異動完全脫離程式碼。

核心是兩張 App：
- `role_definition`（角色定義表，~80 筆）：定義每個角色是誰、下一關是誰。
- `employee_entry`（員工起點對照表，~500 筆）：定義每個員工送單的起點角色。

搭配 **Linked List 結構**表達簽核鏈，組織插入新節點只改 1-2 筆資料、不改程式。

---

## 三、你必讀的文件（按順序）

1. **`docs/對話脈絡.md`** ← **最重要！** 記錄了我們之前所有設計決策的「為什麼」
2. `docs/00-規格書.md` — 完整技術規格
3. `docs/02-欄位代碼對照表.md` — 兩個 App 的欄位定義
4. `docs/Phase進度追蹤.md` — 當前做到哪個 Phase
5. `docs/Phase0-工作清單.md` — Phase 0 的具體步驟

---

## 四、開發紀律（鐵律，不可違反）

### 4.1 檔案結構

```
core/                  ← 所有 App 共用的核心模組
apps/role-definition/  ← 角色定義表 App 專屬 JS
apps/employee-entry/   ← 員工起點對照表 App 專屬 JS
tools/                 ← 獨立工具（健康檢查、模擬器、反向查詢）
adapters/              ← 各申請 App 的接入程式碼
docs/                  ← 所有文件
scripts/               ← 部署腳本、遷移腳本
```

### 4.2 程式碼必備元素（每個 .js 檔都要有）

```javascript
/**
 * [檔案用途一句話]
 *
 * 【影響的欄位】
 *   - xxx: 說明
 *
 * 【依賴】
 *   - 其他模組
 *
 * 【變更履歷】
 *   YYYY-MM-DD  作者  變更內容
 */
(() => {
  'use strict';

  const CONFIG = Object.freeze({
    // 所有可變動的值都放這裡
  });

  // ... 實作

  kintone.events.on([...], safeHandler(async (event) => {
    // 邏輯
    return event;
  }));
})();
```

### 4.3 舊系統的錯誤，新系統絕對不重蹈

| 舊系統的雷 | 新系統對策 |
|-----------|-----------|
| `processOrgName()` 字串處理 | **禁止接觸組織名稱** |
| `case '課長'/'次長'/'部長'` | 用角色 ID，**禁止職稱判斷** |
| `SPECIAL_DEPARTMENTS` 硬編碼 | 所有特例進資料表 |
| 多次 `kintone.app.record.get()` | 一次 get、最後 set |
| `setFieldShown` 順序錯誤 | 統一在 set 之後呼叫 |
| 重複 API 呼叫 | 用 Cache Map |
| callback 地獄 | 全部 async/await |

### 4.4 UI 設計原則

- **使用者年齡層 35-55 歲**，文字要清楚、按鈕要大
- **提醒/警告/錯誤**一律用 **SweetAlert2**
- **動態必填**搭配 `event.error` + SweetAlert 視窗雙重提示
- **代碼欄位永遠對 HR 隱藏**，HR 看到的都是中文

---

## 五、當前進度

查看 `docs/Phase進度追蹤.md` 知道現在做到哪個 Phase。

**快速判斷**：
- 如果進度是 **P0**：Jimmy 正在手動建 kintone 兩張表
- 如果進度是 **P1**：該寫角色表 HR 介面程式
- 進度以 `docs/Phase進度追蹤.md` 為準

---

## 六、kintone 環境資訊

| 項目 | 值 |
|------|----|
| 版本 | cybozu.com **雲端版** |
| 群組 API | ✅ `kintone.getMembersByGroupCode()` 可用 |
| 角色定義表 App ID | **685** |
| 員工起點對照表 App ID | **686** |
| SweetAlert2 載入狀態 | ✅ 已全域載入 |

---

## 七、與 Jimmy 協作的溝通原則

1. **一次一個需求**：每次只處理一個 Phase 的一個功能，做完驗證再繼續。
2. **主動標註風險**：事件名稱、欄位代碼、API method 容易拼錯，主動提醒。
3. **貼文件連結**：用到的 kintone API 附上 cybozu.dev 連結。
4. **短問短答**：Jimmy 忙的時候問得快，不要 over-engineering。
5. **疑問先問**：需求有歧義，先問清楚再動手。

---

## 八、立刻要做的第一件事

開始任何對話前：
1. 讀完 `docs/對話脈絡.md`
2. 讀完 `docs/Phase進度追蹤.md`
3. 跟 Jimmy 確認當前要做的 Phase

不要假設、不要跳過。
