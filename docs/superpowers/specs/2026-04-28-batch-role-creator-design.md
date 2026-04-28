# 設計文件：批量建立角色工具（Batch Role Creator）

**日期**：2026-04-28
**狀態**：待實作
**影響範圍**：`tools/` 下新增獨立 HTML 工具，寫入 App 685（角色定義表）

---

## 一、問題陳述

App 685 初始資料建立時，需依據現有員工的 code（USER_SELECT.value?.code）與職稱，批量建立角色記錄。手動逐筆新增約 80 筆效率低且易出錯。

需要一個獨立 HTML 工具，讓 Jimmy 貼入 CSV、設定 holder（個人或群組），一次送出批量建立。

---

## 二、架構決策

### 2.1 工具定位

| 項目 | 決策 |
|------|------|
| 執行環境 | 本機直接開啟 HTML 檔（無需 server） |
| 認證方式 | kintone API Token（手動貼入，存 localStorage） |
| 技術棧 | 純 HTML + Vanilla JS（ES2020+），無框架 |
| 輸入來源 | CSV 貼入或上傳（欄位：code, title） |
| 輸出目標 | App 685 REST API `POST /k/v1/records.json` |

### 2.2 欄位對應

| App 685 欄位 | 來源 |
|-------------|------|
| `role_id` | 工具自動產生：`ROLE_[YYYYMMDDHHmmss]_[001]` |
| `unit_name` | UI 頂部「單位名稱」輸入框（全批套用） |
| `title_level` | CSV 的 `title` 欄 |
| `role_name` | **kintone 計算欄位自動合成**，工具不設定 |
| `holder_type` | 每列可切換：`指定個人` / `指定群組` |
| `holder_user` | 指定個人時：從 CSV 同職稱的 code 清單選取 |
| `holder_group` | 指定群組時：UI 搜尋後填入群組代碼 |
| `is_active` | 固定預設 `['啟用中']` |
| `next_role_id` | 留空，事後手動填 |
| `signing_mode` | 留空，事後手動填 |
| `is_chain_end` | 留空，事後手動填 |

---

## 三、UI 設計

### 3.1 版面（三區塊）

```
┌──────────────────────────────────────────────┐
│ [區塊 1] 設定                                 │
│  API Token: [__________________]  [儲存]      │
│  單位名稱:  [__________________]              │
│  App ID:    685（固定）                       │
├──────────────────────────────────────────────┤
│ [區塊 2] CSV 輸入                             │
│  格式：code,title（第一列可為標題列）          │
│  [textarea 貼入] 或 [上傳 .csv 檔]  [解析]   │
├──────────────────────────────────────────────┤
│ [區塊 3] 角色設定表                           │
│  role_name     │ holder_type │ holder         │
│  MIS_課長      │ [個人 ▼]   │ [user001 ▼]   │
│  MIS_次長      │ [個人 ▼]   │ [user002 ▼]   │
│  MIS_部長      │ [群組 ▼]   │ [搜尋群組...] │
│  MIS_部門長    │ [群組 ▼]   │ [搜尋群組...] │
│                                               │
│          [預覽 JSON]   [送出建立]             │
└──────────────────────────────────────────────┘
```

### 3.2 群組搜尋 Autocomplete

- 頁面載入後自動呼叫 `GET /k/v1/groups.json`（分頁撈完所有群組）
- 使用 `<input>` + `<datalist>` 實作，輸入 1-2 字即篩選
- 顯示：群組名稱；儲存：群組代碼（code）

### 3.3 個人 holder 選取

- CSV 同職稱有多人時：顯示 `<select>` 下拉讓 Jimmy 選擇 holder
- 同職稱只有一人時：直接顯示該 code（不需選）

---

## 四、資料邏輯

### 4.1 CSV 解析

1. 支援第一列為標題列（自動偵測是否含 `code` 字樣）
2. 以職稱（`title`）去重：每個唯一職稱建一列設定列
3. 保留同職稱的所有 code，供個人 holder 下拉使用

### 4.2 role_id 生成

```
ROLE_[YYYYMMDDHHmmss]_[零補位三碼序號]
範例：ROLE_20260428143022_001
```

同一次批量建立的所有 role_id 使用相同時間戳，序號遞增。

### 4.3 批量送出

- 一次最多 100 筆（kintone 限制）
- 超過 100 筆時自動分批，循序送出
- 每批送出後顯示進度（例：已建立 50 / 80）
- 任一批失敗時顯示錯誤，停止後續批次，保留已建立筆數資訊

---

## 五、API 呼叫

| 時機 | API | 用途 |
|------|-----|------|
| 頁面載入 | `GET /k/v1/groups.json` | 撈所有群組建 autocomplete |
| 送出時 | `POST /k/v1/records.json` | 批量建立角色記錄 |

**認證**：所有請求帶 `X-Cybozu-API-Token` header。
**kintone URL 格式**：`https://[subdomain].cybozu.com/k/v1/...`，subdomain 由工具自動從 API Token 輸入旁的欄位取得，或直接讀 `window.location.hostname`（若在 kintone domain 下開啟）。

> ⚠️ 在本機（非 kintone domain）開啟會遇到 CORS，需透過 kintone 的 `https://[subdomain].cybozu.com` 直接開啟此 HTML，或由 IT 在 kintone 上掛為附件開啟。

---

## 六、Edge Cases

| 情境 | 處理方式 |
|------|---------|
| CSV 欄位順序不一致 | 解析時以標題列判斷 code/title 欄位位置 |
| 同職稱多人但選擇群組 | 群組 holder 不限人數，正常處理 |
| 群組代碼打錯 | 送出前不驗證群組是否存在；kintone API 會回傳錯誤 |
| 批量超過 100 筆 | 自動分批循序送出 |
| API Token 無效 | 送出時 kintone 回傳 401，顯示錯誤提示 |
| 重複建立相同角色 | 工具不做去重；由 Jimmy 自行確認，避免重複送出 |

---

## 七、不在本次範圍

- App 686 起點對照表的 `entry_role_id` 批量指派（獨立工具）
- `next_role_id` / `signing_mode` / `is_chain_end` 的批量設定（手動填）
- 既有角色的更新（update）操作，只做新增（create）

---

## 八、成功驗收標準

- [ ] 貼入 CSV → 解析 → 顯示每個唯一職稱一列
- [ ] 切換 holder_type → 對應 holder UI 即時切換（個人下拉 / 群組搜尋）
- [ ] 群組搜尋：輸入 1-2 字即篩選出對應群組
- [ ] 送出後 App 685 出現正確筆數的角色記錄
- [ ] role_id 格式符合 `ROLE_[timestamp]_[index]`
- [ ] unit_name、title_level 寫入正確，role_name 計算欄位自動顯示
