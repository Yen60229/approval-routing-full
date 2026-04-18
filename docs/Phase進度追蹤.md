# Phase 進度追蹤

> 每完成一個 Phase,在下方打勾並寫下日期。

---

## 當前狀態

- **當前 Phase**:**P0** — 建表中（程式碼已寫到 P3）
- **下一步動作**:Jimmy 在 kintone 後台建好兩張表 → 填入 App ID → 上傳 JS 測試
- **最後更新**:2026-04-14

---

## Phase 清單

### 🔲 P0 — 兩表建立 + 環境確認 (進行中)
- [x] IT 確認 kintone 群組功能啟用
- [x] IT 確認 `kintone.getMembersByGroupCode()` 可用 ✅ 2026-04-14
- [x] 確認 kintone 環境：**雲端版** ✅ 2026-04-14
- [x] 確認 SweetAlert2 已全域載入 ✅ 2026-04-14
- [ ] 建立 App 1「簽核角色定義表」
- [ ] 建立 App 2「員工起點對照表」
- [ ] 設定兩個 App 的權限
- [ ] 回報 App ID → 填入 `core/01-config.js`

### ✅ P1 — 角色表 HR 介面（程式碼已完成，待上傳測試）
- [x] `core/01-config.js` — 集中管理 App ID、欄位代碼 ✅ 2026-04-14
- [x] `core/05-vendor.js` — SweetAlert2 存在性檢查 ✅ 2026-04-14
- [x] `core/04-utils.js` — safeHandler、SweetAlert 包裝 ✅ 2026-04-14
- [x] `apps/role-definition/01-role-form-init.js` — 自動產生 role_id ✅ 2026-04-14
- [x] `apps/role-definition/02-field-display.js` — holder_type 條件顯示 group/user 欄位 ✅ 2026-04-14
- [x] `apps/role-definition/03-next-role-dropdown.js` — next_role_id 下拉 UI ✅ 2026-04-14
- [ ] 上傳至 kintone 角色定義表 App 並測試

### ✅ P2 — 起點表 HR 介面 + 批量匯入（程式碼已完成，待上傳測試）
- [x] `apps/employee-entry/01-entry-form-init.js` — 起點角色下拉選單 ✅ 2026-04-14
- [x] `apps/employee-entry/02-batch-import.js` — CSV 匯入 + dry-run ✅ 2026-04-14
- [ ] 上傳至 kintone 員工起點對照表 App 並測試

### ✅ P3 — 鏈視覺化 + 即時預覽（程式碼已完成，待上傳測試）
- [x] `apps/role-definition/04-chain-preview.js` — 詳情/編輯頁視覺化卡片 ✅ 2026-04-14
- [x] 編輯頁即時預覽（next_role_id / is_chain_end 變更時自動重繪）✅ 2026-04-14
- [ ] 上傳至 kintone 角色定義表 App 並測試

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
| P1（程式碼） | 2026-04-14 | 待上傳 kintone 測試 |
| P2（程式碼） | 2026-04-14 | 待上傳 kintone 測試 |
| P3（程式碼） | 2026-04-14 | 待上傳 kintone 測試 |
| P4（程式碼） | 2026-04-14 | 待上傳 kintone 測試 |
| P5（程式碼） | 2026-04-14 | 待上傳 kintone 測試 |
| P6（程式碼） | 2026-04-14 | 待上傳 kintone 測試 |
| P7（程式碼） | 2026-04-14 | 待上傳 kintone 測試 |
