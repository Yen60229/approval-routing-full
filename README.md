# Approval Routing Engine

> kintone 簽核路由引擎 — 用資料驅動的角色路由表取代「組織+職稱」推導

---

## 快速開始

### 如果你是 Claude Code 或任何 AI 助手
**請先讀 `CLAUDE.md`**,那是專案入口指引。

### 如果你是新進開發者
1. 讀 `CLAUDE.md` 理解整體規範
2. 讀 `docs/對話脈絡.md` 理解為什麼這樣設計
3. 讀 `docs/00-規格書.md` 看技術細節
4. 看 `docs/Phase進度追蹤.md` 知道目前做到哪

### 如果你是 HR 或 IT 維護人員
- HR:讀 `docs/01-HR維護操作手冊.md` (尚未完成)
- IT:讀 `docs/Phase0-工作清單.md` Step 1-2 的群組設定要點

---

## 資料夾說明

| 資料夾 | 用途 |
|-------|------|
| `docs/` | 所有文件(規格、手冊、脈絡) |
| `core/` | 所有 App 共用的核心模組 |
| `apps/role-definition/` | 角色定義表 App 專屬 JS |
| `apps/employee-entry/` | 員工起點對照表 App 專屬 JS |
| `tools/` | 獨立工具(健康檢查、模擬器、反向查詢) |
| `adapters/` | 各申請 App 的接入程式碼 |
| `scripts/` | 部署腳本、遷移腳本 |

---

## 專案狀態

當前 Phase:見 `docs/Phase進度追蹤.md`
