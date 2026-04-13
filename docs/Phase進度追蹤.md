# Phase 進度追蹤

> 每完成一個 Phase,在下方打勾並寫下日期。

---

## 當前狀態

- **當前 Phase**:**P0** — 建表中
- **下一步動作**:Jimmy 在 kintone 後台建兩張表
- **最後更新**:2026-04-13

---

## Phase 清單

### ⬜ P0 — 兩表建立 + 環境確認 (進行中)
- [ ] IT 確認 kintone 群組功能啟用
- [ ] IT 確認 `kintone.getMembersByGroupCode()` 可用
- [ ] 建立 App 1「簽核角色定義表」
- [ ] 建立 App 2「員工起點對照表」
- [ ] 設定兩個 App 的權限
- [ ] 回報 App ID 與環境資訊

### ⬜ P1 — 角色表 HR 介面 (2 次會話)
- [ ] `apps/role-definition/01-form-init.js` — 自動產生 role_id
- [ ] `apps/role-definition/02-field-display.js` — holder_type 條件顯示 group/user 欄位
- [ ] `apps/role-definition/03-next-role-dropdown.js` — next_role_id 下拉 UI
- [ ] `core/01-config.js` — 集中管理 App ID、欄位代碼
- [ ] `core/04-utils.js` — safeHandler、SweetAlert 包裝
- [ ] `core/05-vendor.js` — SweetAlert2 載入

### ⬜ P2 — 起點表 HR 介面 + 批量匯入
- [ ] `apps/employee-entry/01-form-init.js`
- [ ] `apps/employee-entry/02-batch-import.js` (CSV 匯入 + dry-run)

### ⬜ P3 — 鏈視覺化 + 即時預覽
- [ ] `apps/role-definition/04-chain-preview.js`
- [ ] 編輯頁即時預覽

### ⬜ P4 — 核心引擎 ApprovalEngine (2 次會話)
- [ ] `core/02-api-client.js` — REST API 封裝 + 快取
- [ ] `core/03-chain-builder.js` — buildChain() 核心
- [ ] `window.ApprovalRouting` 對外介面

### ⬜ P5 — 健康檢查工具
- [ ] `tools/01-health-check.js`

### ⬜ P6 — 測試模擬器
- [ ] `tools/02-simulator.js`

### ⬜ P7 — 反向查詢 + 主管快捷介面
- [ ] `tools/03-reverse-query.js`

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
| (尚無) | | |
