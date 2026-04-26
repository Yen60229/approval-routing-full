# 設計文件：role_name UI 優化 + 計算欄位重構

**日期**：2026-04-26
**狀態**：待實作
**影響範圍**：App 685（角色定義表）、`apps/role-definition/01-role-form-init.js`（新增或調整）

---

## 一、問題陳述

現況：HR 在新增角色時，`role_name` 是純文字輸入欄位，容易打錯（如 `MIS_課長` 手誤成 `MS_課長`），且當部門縮寫異動時（如 `MIS` 改名為 `資訊部`），必須人工逐筆修改所有相關角色名稱。

目標：
1. **防打錯**：以兩個下拉選單取代自由文字輸入
2. **可搜尋**：下拉清單支援文字過濾，避免清單過長難以選取
3. **關聯式更新**：改部門名稱一次，所有角色名稱自動連動

---

## 二、架構決策

### 2.1 欄位設計

在 App 685 新增兩個欄位，並將 `role_name` 改為計算欄位：

| 欄位代碼 | 欄位類型 | 說明 |
|---------|---------|------|
| `unit_name` | 下拉式選單 | 單位名稱，IT 在 App 設定中維護選項清單 |
| `title_level` | 下拉式選單 | 職級，固定六個選項（見下方）|
| `role_name` | **計算欄位** | 公式：`unit_name & "_" & title_level`，唯讀 |

### 2.2 title_level 固定選項（順序即簽核鏈方向）

```
課長 / 次長 / 部長 / 部門長 / 本部長 / 總經理
```

> 送單人（課員、主任、專任、副課長）為起點角色，不在此清單內。

### 2.3 關聯更新機制（純 kintone 原生，無 JS）

```
IT 在 App 設定改 unit_name 選項名稱
      「MIS」→「資訊部」
             ↓ kintone 原生
所有記錄的 unit_name 欄位值自動更新
             ↓ kintone 計算欄位重算
role_name 同步變成「資訊部_課長」
```

**JS 完全不介入此流程。**

---

## 三、JS 設計（純 UI 層）

### 3.1 目標

隱藏 kintone 原生的 `unit_name`、`title_level` 下拉選單，注入可搜尋的自訂 UI，選定後寫回原生欄位（觸發 kintone 自動計算 `role_name`）。

### 3.2 實作方式：`<input>` + `<datalist>`（方案 A）

```
原生 unit_name 下拉（<select>）→ 隱藏前先讀取所有 <option> 建成陣列
→ setFieldShown('unit_name', false) 隱藏
→ 注入 <input list="ar-unit-list"> + <datalist id="ar-unit-list">（從陣列生成 <option>）
→ 使用者打字過濾 → 選定後 → kintone.app.record.set({ unit_name: 選定值 })

同樣做法套用至 title_level
```

### 3.3 事件觸發時機

| kintone 事件 | JS 動作 |
|-------------|---------|
| `app.record.create.show` | 隱藏原生欄位、注入兩個搜尋 UI（空白，等待輸入）|
| `app.record.edit.show` | 隱藏原生欄位、注入兩個搜尋 UI，並預填目前欄位值 |
| 自訂 input 的 `change` 事件 | 驗證值是否在選項清單內，若是則呼叫 `kintone.app.record.set` 寫回 |
| `app.record.create.submit` / `edit.submit` | 確認 unit_name + title_level 均非空白，否則 `event.error` + Swal 提示攔截 |

### 3.4 不需處理的事項

- `role_name` 欄位：計算欄位，唯讀，JS **不碰**
- 詳情頁（`detail.show`）：`unit_name` + `title_level` 均已有值，直接顯示即可，無需特殊處理

### 3.5 檔案位置

**新增** `apps/role-definition/07-role-name-selector.js`

> `01-role-form-init.js` 只負責 `role_id` 自動產生，不納入此功能。

---

## 四、Jimmy 在 kintone 後台的操作清單

**順序不可顛倒（3 是關鍵，必須在現有記錄補值之後才能執行）：**

1. App 685 → 新增欄位 `unit_name`（下拉式選單）
   - 初始選項：目前公司所有單位縮寫（MIS、HR、財務、採購…等，Jimmy 自行填入）
2. App 685 → 新增欄位 `title_level`（下拉式選單）
   - 固定選項：`課長 / 次長 / 部長 / 部門長 / 本部長 / 總經理`（依序填入）
3. ⚠️ **資料遷移（改欄位類型前必做）**：逐筆編輯所有現有角色記錄，從原 `role_name`（如 `MIS_課長`）拆解，填入 `unit_name = MIS`、`title_level = 課長`。完成後確認所有記錄的 unit_name + title_level 均非空白。
4. App 685 → `role_name` 欄位類型改為**計算欄位**
   - 公式：`unit_name & "_" & title_level`
   - 儲存後確認所有記錄的 role_name 顯示正確
5. 確認計算結果正確後，上傳 `07-role-name-selector.js`

---

## 五、Edge Cases

| 情境 | 處理方式 |
|------|---------|
| 現有 role_name 舊記錄（文字格式） | 欄位改為計算欄位後，kintone 會以公式重算；若 unit_name 或 title_level 舊記錄為空，role_name 結果為 `"_"` 或缺值 → **Jimmy 需在改欄位類型前，先確認所有舊記錄都有 unit_name + title_level 的值** |
| 新單位（現有清單沒有的）| IT 到 App 設定 → unit_name 欄位 → 新增選項 → 即時生效 |
| 雙職位人員作為送單起點 | 由 kintone 優先組織決定 entry_role_id；例外情況由 employee_entry（App 686）手動覆蓋，**無需程式** |
| unit_name 或 title_level 任一為空時送出 | `07-role-name-selector.js` 的 submit 事件攔截，顯示 SweetAlert 提示 |

---

## 六、不在本次範圍內

- employee_entry（App 686）的起點選擇 UI — 獨立議題
- P8 試點 App 接入 — 暫緩
- kintone 主頁流程名稱統一化 — 另一條獨立軌道

---

## 七、成功驗收標準

- [ ] 新增頁：unit_name + title_level 均顯示可搜尋輸入框，打 2 字即可過濾選項
- [ ] 新增頁：選定後 role_name 欄位自動顯示正確拼合結果（計算欄位）
- [ ] 編輯頁：原有值預填入搜尋框，可重新選取
- [ ] IT 在 App 設定改 unit_name 選項名稱 → 所有對應記錄 role_name 自動更新
- [ ] unit_name 或 title_level 空白時，送出表單被攔截並提示
