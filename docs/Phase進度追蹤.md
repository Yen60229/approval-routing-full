# Phase 進度追蹤

> 每完成一個 Phase,在下方打勾並寫下日期。

---

## 當前狀態

- **當前 Phase**:**P1** — 角色定義表 HR 介面（7 支 JS 完成，待上傳 kintone 完整驗收）
- **下一步動作**:上傳 `apps/role-definition/` 下全部 7 支 JS 至 App 685，在瀏覽器驗證所有功能；另需確認 kintone 後台已完成 role_name 計算欄位設定
- **最後更新**:2026-04-28

---

## Phase 清單

### ✅ P0 — 兩表建立 + 環境確認 (完成)
- [x] IT 確認 kintone 群組功能啟用
- [x] IT 確認 `kintone.getMembersByGroupCode()` 可用 ✅ 2026-04-14
- [x] 確認 kintone 環境：**雲端版** ✅ 2026-04-14
- [x] 確認 SweetAlert2 已全域載入 ✅ 2026-04-14
- [x] 建立 App 685「角色定義表」✅ 2026-04-18
- [x] 建立 App 686「員工起點對照表」✅ 2026-04-18（推測）
- [x] App ID 填入 `core/01-config.js` ✅ 2026-04-18

### 🔄 P1 — 角色表 HR 介面（多輪迭代中，待上傳完整版測試）
- [x] `core/01-config.js` — 集中管理 App ID、欄位代碼 ✅ 2026-04-14
- [x] `core/05-vendor.js` — SweetAlert2 存在性檢查 ✅ 2026-04-14
- [x] `core/04-utils.js` — safeHandler、SweetAlert 包裝 ✅ 2026-04-14
- [x] `apps/role-definition/01-role-form-init.js` — 自動產生 role_id ✅ 2026-04-14
  - [x] create.show / edit.show 均隱藏角色代碼欄位（HR 不需看見）✅ 2026-04-19
- [x] `apps/role-definition/02-field-display.js` — holder_type 條件顯示 group/user 欄位 ✅ 2026-04-14
  - [x] detail.show 條件顯示 ✅ 2026-04-18
  - [x] 索引頁「簽核者」欄統一顯示（群組/個人均顯示）✅ 2026-04-18
  - [x] 儲存前強制清除非使用中的 holder 欄位，防殘留 ✅ 2026-04-19
- [x] `apps/role-definition/03-next-role-dropdown.js` — next_role_id 下拉 UI ✅ 2026-04-14
  - [x] 下拉掛載於 chain_preview 空白欄位（Timeline 下方），位置更直覺 ✅ 2026-04-19
  - [x] 切換下拉後即時刷新 Timeline 預覽 ✅ 2026-04-19
  - [x] is_chain_end change 事件改為同步 + fire-and-forget（符合 kintone 規範）✅ 2026-04-19
- [x] `apps/role-definition/04-chain-preview.js` — 詳情/編輯頁視覺化卡片 ✅ 2026-04-14
  - [x] 全新 Timeline 風格（圓點閃爍 + 水平連線）✅ 2026-04-18
  - [x] 支援多源頭上游樹狀結構（多對一匯流）✅ 2026-04-19
  - [x] 切換「下一關角色」後即時顯示 Loading spinner，API 回來後渲染 ✅ 2026-04-19
  - [x] 覆蓋未儲存的編輯中欄位值到 roleMap（解決顯示舊資料問題）✅ 2026-04-19
  - [x] mountPreview 改為 insertBefore，避免覆蓋共存的下拉 UI ✅ 2026-04-19
  - [x] 暴露 `window.ApprovalRouting.ChainPreview.refresh` 供 03 跨模組呼叫 ✅ 2026-04-19
- [x] `apps/role-definition/05-detail-card.js` — 詳情頁自訂卡片 UI ✅ 2026-04-18
  - [x] 隱藏原生欄位、顯示自訂美化卡片 ✅ 2026-04-18
  - [x] 指定群組時額外顯示群組成員列表（呼叫 `/v1/group/users` API）✅ 2026-04-19
  - [x] top-down DOM selector 取得 USER_SELECT 原生元素並移植到卡片中 ✅ 2026-04-19
  - [x] 解除詳情頁 748px 寬度限制 ✅ 2026-04-19
- [x] `apps/role-definition/06-edit-layout.js` — 編輯/新增頁版面美化（**新增**）✅ 2026-04-19
  - [x] 解除編輯頁 748px 寬度限制
  - [x] 注入「簽核者設定」分區標題
  - [x] 注入「簽核鏈 & 下一關設定」分區標題
- [x] `apps/role-definition/07-role-name-selector.js` — unit_name/title_level 詳情頁隱藏 + 送出驗證 ✅ 2026-04-28
  - [x] detail.show 隱藏 unit_name / title_level（role_name 計算結果即足夠）
  - [x] submit 驗證：unit_name + title_level 均不可為空
  - [x] `core/01-config.js` 新增 UNIT_NAME、TITLE_LEVEL 欄位代碼及 TITLE_LEVEL_OPTIONS ✅ 2026-04-28
  - [ ] **kintone 後台前置條件**（Jimmy 手動操作）
    - [ ] App 685 新增 `unit_name` 下拉式選單欄位（IT 維護選項）
    - [ ] App 685 新增 `title_level` 下拉式選單欄位（固定六選項）
    - [ ] 現有記錄資料遷移：role_name 拆解填入 unit_name + title_level
    - [ ] `role_name` 改為計算欄位，公式 `unit_name & "_" & title_level`
- [ ] **上傳全部 7 支 JS 至 App 685，在 kintone 瀏覽器完整驗證**
  - [ ] 新增頁：role_id 自動產生、兩欄位隱藏、分區標題顯示
  - [ ] 新增頁：holder_type 切換 → group/user 欄位條件顯示
  - [ ] 新增頁：next_role_id 下拉 UI 顯示、切換後 Timeline 即時更新
  - [ ] 編輯頁：所有上述功能 + 「更新預覽 spinner」動畫
  - [ ] 詳情頁：自訂卡片 + 群組成員列表 + chain_preview Timeline
  - [ ] 索引頁：「簽核者」欄統一顯示群組/個人
  - [ ] 儲存驗證：holder 必填、next_role_id 必填（或勾 is_chain_end）

### ✅ P2 — 起點表 HR 介面 + 批量匯入（程式碼已完成，待上傳測試）
- [x] `apps/employee-entry/01-entry-form-init.js` — 起點角色下拉選單 ✅ 2026-04-14
- [x] `apps/employee-entry/02-batch-import.js` — CSV 匯入 + dry-run ✅ 2026-04-14
- [ ] 上傳至 kintone 員工起點對照表 App 並測試

### ✅ P3 — 鏈視覺化 + 即時預覽（已整合入 P1，無需另行處理）
- [x] `apps/role-definition/04-chain-preview.js` — 含多源頭 Tree + Timeline ✅ 2026-04-19（含 P3 全部需求）

### ✅ P4 — 核心引擎 ApprovalEngine（程式碼已完成，待上傳測試）
- [x] `core/02-api-client.js` — REST API 封裝 + Cache Map ✅ 2026-04-14
- [x] `core/03-chain-builder.js` — buildChain() 核心 + window.ApprovalRouting 對外介面 ✅ 2026-04-14
- [x] **架構強化 #1～#3** ✅ 2026-04-14
  - [x] Promise singleton 防並發 race condition
  - [x] 角色快取 TTL 5 分鐘 + ensureFreshRoles() API
  - [x] buildChain() 三階段平行化（5 關鏈 1500ms → 300ms 估算）
  - [x] 新增 `forceFresh` 選項，submit 前可強制最新資料
- [ ] 上傳並測試

### ✅ P5 — 健康檢查工具（程式碼已完成，待上傳測試）
- [x] `tools/01-health-check.js` — 循環/斷鏈/孤立/空holder ✅ 2026-04-14
- [ ] 上傳並測試

### ✅ P6 — 測試模擬器（程式碼已完成，待上傳測試）
- [x] `tools/02-simulator.js` — 任選員工模擬簽核鏈 ✅ 2026-04-14
- [ ] 上傳並測試

### ✅ P7 — 反向查詢（程式碼已完成，待上傳測試）
- [x] `tools/03-reverse-query.js` — 展開群組 + 找申請人 ✅ 2026-04-14
- [ ] 上傳並測試

### ⬜ P8 — 第一個試點 App 接入 (2 次會話)
- [ ] 選定試點 App
- [ ] 接入並試跑 2 週
- [ ] 整合 process.proceed 事件

### ⬜ P9 — 大規模切換準備
- [ ] `scripts/migration/` — 舊資料轉換
- [ ] `docs/03-應變指南.md` — 出問題怎麼辦

### ⬜ P10 — 全面切換 + 文件交付
- [ ] 其餘 App 統一切換
- [ ] `docs/01-HR維護操作手冊.md` 定稿
- [ ] `docs/04-開發者整合指南.md` 定稿

---

## Phase 完成記錄

| Phase | 完成日期 | 備註 |
|-------|---------|------|
| P0（建表） | 2026-04-18 | App 685/686 建立，App ID 寫入 config |
| P1（程式碼 v1） | 2026-04-14 | 初版 JS 五支 |
| P1（程式碼 v2） | 2026-04-19 | 多輪迭代：Timeline UI、Loading spinner、群組成員顯示、版面美化（新增第六支 06-edit-layout.js）、清除殘留 holder、同步 change 事件 |
| P1（程式碼 v3） | 2026-04-28 | 新增 07-role-name-selector.js（unit_name/title_level 詳情頁隱藏 + 送出驗證）；config 新增兩欄位代碼 + TITLE_LEVEL_OPTIONS |
| P2（程式碼） | 2026-04-14 | 待上傳 kintone 測試 |
| P3（程式碼） | 2026-04-19 | 已整合入 P1 的 04-chain-preview.js，無獨立待辦 |
| P4（程式碼） | 2026-04-14 | 待上傳 kintone 測試 |
| P5（程式碼） | 2026-04-14 | 待上傳 kintone 測試 |
| P6（程式碼） | 2026-04-14 | 待上傳 kintone 測試 |
| P7（程式碼） | 2026-04-14 | 待上傳 kintone 測試 |
