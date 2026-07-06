# Phase 進度追蹤

> 每完成一個 Phase,在下方打勾並寫下日期。

---

## 當前狀態

- **當前 Phase**:**P1 驗證中** — 角色定義表 HR 介面 7 支 JS 已上傳 App 685，於 kintone 真實資料上邊測邊修
- **下一步動作**:收尾 P1 實測剩餘驗證項；推進 P2 起點表上傳測試與 P8 試點接入
- **最後更新**:2026-07-06（交付全方位評估報告 + 表單路由/代理人兩份設計提案，見下方「v2 擴充提案」區塊）

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

### 🔄 P1 — 角色表 HR 介面（已上傳 App 685，kintone 邊測邊修中）
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
  - [x] 升級為可搜尋下拉元件（input + 浮動清單，打字過濾）✅ 2026-05-10
  - [x] 選項依 unit_name（role_name 開頭/單位）分組排序、完整 role_name 去重 ✅ 2026-06-02
  - [x] 下拉識別改以 role_name 為準（role_id 僅作寫入用），同名角色不論存哪個 role_id 都正確顯示 ✅ 2026-06-02
- [x] `apps/role-definition/04-chain-preview.js` — 詳情/編輯頁視覺化卡片 ✅ 2026-04-14
  - [x] 全新 Timeline 風格（圓點閃爍 + 水平連線）✅ 2026-04-18
  - [x] 支援多源頭上游樹狀結構（多對一匯流）✅ 2026-04-19
  - [x] 切換「下一關角色」後即時顯示 Loading spinner，API 回來後渲染 ✅ 2026-04-19
  - [x] 覆蓋未儲存的編輯中欄位值到 roleMap（解決顯示舊資料問題）✅ 2026-04-19
  - [x] mountPreview 改為 insertBefore，避免覆蓋共存的下拉 UI ✅ 2026-04-19
  - [x] 暴露 `window.ApprovalRouting.ChainPreview.refresh` 供 03 跨模組呼叫 ✅ 2026-04-19
  - [x] 同名節點合併 + hover tooltip 顯示同仁姓名（tooltip 改掛 body 避免被裁切）✅ 2026-05-03
  - [x] 群組角色 tooltip 顯示群組成員姓名（改用 `/v1/group/users` REST API + code 參數）✅ 2026-05-03
  - [x] 補上 HOLDER_GROUP 欄位請求，修正 undefined 錯誤 ✅ 2026-05-03
  - [x] 改用 offset 分頁取全量角色，解決 limit 500 截斷問題 ✅ 2026-05-03
- [x] `apps/role-definition/05-detail-card.js` — 詳情頁自訂卡片 UI ✅ 2026-04-18
  - [x] 隱藏原生欄位、顯示自訂美化卡片 ✅ 2026-04-18
  - [x] 指定群組時額外顯示群組成員列表（呼叫 `/v1/group/users` API）✅ 2026-04-19
  - [x] top-down DOM selector 取得 USER_SELECT 原生元素並移植到卡片中 ✅ 2026-04-19
  - [x] 解除詳情頁 748px 寬度限制 ✅ 2026-04-19
- [x] `apps/role-definition/06-edit-layout.js` — 編輯/新增頁版面美化（**新增**）✅ 2026-04-19
  - [x] 解除編輯頁 748px 寬度限制
  - [x] 注入「簽核者設定」分區標題
  - [x] 注入「簽核鏈 & 下一關設定」分區標題
  - [x] 標題改名改用 TreeWalker，修復欄寬無法拖動 ✅ 2026-05-03
- [x] `apps/role-definition/07-role-name-selector.js` — unit_name/title_level 詳情頁隱藏 + 送出驗證 ✅ 2026-04-28
  - [x] detail.show 隱藏 unit_name / title_level（role_name 計算結果即足夠）
  - [x] submit 驗證：unit_name + title_level 均不可為空
  - [x] `core/01-config.js` 新增 UNIT_NAME、TITLE_LEVEL 欄位代碼 ✅ 2026-04-28
  - [x] **2026-05-01 重構**：移除 `TITLE_LEVEL_OPTIONS` 硬編碼，`tools/04-batch-role-creator.js` 改為呼叫 `kintone.app.getFormFields()` 同步載入 `unit_name` + `title_level` 兩個下拉欄位選項；任一欄位非下拉 / 選項為空時 SweetAlert 報錯停止流程
  - [x] **kintone 後台前置條件**（Jimmy 手動操作）✅ 2026-06-02 確認全部完成
    - [x] App 685 新增 `unit_name` 下拉式選單欄位（IT 維護選項）
    - [x] App 685 新增 `title_level` 下拉式選單欄位（固定六選項）
    - [x] 現有記錄資料遷移：role_name 拆解填入 unit_name + title_level
    - [x] `role_name` 改為計算欄位，公式 `unit_name & "_" & title_level`
- [x] `tools/04-batch-role-creator.js` — 角色批量建立工具（P1 衍生）✅ 2026-05-03
  - [x] 兼任多組織者每組織一列，可分別設定 unit_name / title_level
  - [x] unit_name 改為 datalist 可打字搜尋，送出時驗證值在選項內
  - [x] 每列加刪除鈕、每卡片加「＋ 新增人員」搜尋列
  - [x] role_id 改 `ROLE_0001` 流水號，送出前自動查最大現有號碼
  - [x] 逐卡儲存 + UI 全面提升（35-55 歲使用者優化）、holder 改姓名/帳號雙行
  - [x] 驗證/API 失敗時略過並於結束彙整清單；修正 CB_IL02、saveCard API URL 等
- [x] **上傳全部 7 支 JS 至 App 685** ✅ 已上傳，功能於 kintone 真實資料運作中
  - 下列為正式驗收項，目前邊測邊修，待 Jimmy 逐項最終簽收：
  - [ ] 新增頁：role_id 自動產生、兩欄位隱藏、分區標題顯示
  - [ ] 新增頁：holder_type 切換 → group/user 欄位條件顯示
  - [ ] 新增頁：next_role_id 下拉 UI 顯示、切換後 Timeline 即時更新
  - [ ] 編輯頁：所有上述功能 + 「更新預覽 spinner」動畫
  - [ ] 詳情頁：自訂卡片 + 群組成員列表 + chain_preview Timeline
  - [ ] 索引頁：「簽核者」欄統一顯示群組/個人
  - [ ] 儲存驗證：holder 必填、next_role_id 必填（或勾 is_chain_end）

### ✅ P2 — 起點表 HR 介面 + 批量匯入（程式碼已完成，待上傳測試）
- [x] `apps/employee-entry/01-entry-form-init.js` — 起點角色下拉選單 ✅ 2026-04-14
  - [x] 升級為可搜尋下拉元件 ✅ 2026-05-10
  - [x] 與 role-definition 同步：unit_name 分組排序、完整 role_name 去重、識別改以 role_name 為準 ✅ 2026-06-02
- [x] `apps/employee-entry/02-batch-import.js` — CSV 匯入 + dry-run ✅ 2026-04-14
- [ ] 上傳至 kintone 員工起點對照表 App 並測試
- [ ] `docs/01-HR維護操作手冊.md` 快速上手版（自 P10 提前，理由見 docs/05 評估報告 #11）

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

## 🆕 v2 擴充提案（2026-07-06 交付，待 Jimmy 決策）

三份文件已交付，內容為評估與設計，**尚未動任何程式碼**：

| 文件 | 內容 | 一句話結論 |
|------|------|-----------|
| `docs/05-全方位架構評估報告.md` | 現行後端/前端/文件的全面體檢 | 架構方向正確；#1 起點快取無失效、#2 空簽核者不擋、#11 HR 手冊缺口三項須在 P8 前處理 |
| `docs/06-表單路由與流程標準化設計提案.md` | 第三張表 `form_route_config` + 流程管理標準化 | 建議做；鏈 = 個人段 + 職能段，40-50 表單用同一 adapter + status.json 產生器 |
| `docs/07-代理人功能設計提案.md` | 代理設定表 + 解析層 overlay | 建議做；並列皆可簽、日期自動失效，排在 06 的 adapter 上線之後 |

**建議排程（併入現有 Phase）**：

1. P1 收尾驗收（不變）
2. P2 上傳 + **HR 手冊快速上手版**（已加入 P2 待辦）
3. P4/P5 上傳前：修評估報告 #1（entryCache TTL）、#2（空簽核者報錯）、#4（健康檢查加同名一致性）、#9（統一 escape）
4. P8 前定案 #3（approver_chain 補 signing_mode）；試點直接採 docs/06 的 adapter 規約 + 狀態模板 + 產生器
5. 試點跑穩後實作 docs/07 代理人（預估 1-2 次會話）

**已確認的決策**（2026-07-06）：代理模式 = 原簽核者與代理人並列皆可簽；評估報告發現的引擎問題先列報告、P1 驗收期間不動程式碼。

---

## Phase 完成記錄

| Phase | 完成日期 | 備註 |
|-------|---------|------|
| P0（建表） | 2026-04-18 | App 685/686 建立，App ID 寫入 config |
| P1（程式碼 v1） | 2026-04-14 | 初版 JS 五支 |
| P1（程式碼 v2） | 2026-04-19 | 多輪迭代：Timeline UI、Loading spinner、群組成員顯示、版面美化（新增第六支 06-edit-layout.js）、清除殘留 holder、同步 change 事件 |
| P1（程式碼 v3） | 2026-04-28 | 新增 07-role-name-selector.js（unit_name/title_level 詳情頁隱藏 + 送出驗證）；config 新增兩欄位代碼 + TITLE_LEVEL_OPTIONS |
| P1（程式碼 v4） | 2026-05-01 | 移除 `TITLE_LEVEL_OPTIONS` 硬編碼，`tools/04-batch-role-creator.js` 改為動態載入 unit_name + title_level 下拉選項；錯誤時 SweetAlert 報錯停止流程 |
| P1（程式碼 v5） | 2026-05-03 | chain-preview 系列實測修正（同名節點合併、群組成員 tooltip 改 REST API、limit 500 截斷修正、補 HOLDER_GROUP）；06 標題改 TreeWalker 修欄寬；batch-role-creator 大幅迭代（兼任多組織、datalist、ROLE_0001 流水號、逐卡儲存、UI 提升） |
| P1（程式碼 v6） | 2026-05-10 | 兩表下拉升級為可搜尋元件（input + 浮動清單，打字過濾），修正 index/detail 頁互動 |
| P1（程式碼 v7） | 2026-06-02 | 兩表下拉依 unit_name（role_name 開頭）分組排序、完整 role_name 去重、識別改以 role_name 為準（role_id 僅作寫入用）；employee-entry 同步 |
| kintone 後台前置 | 2026-06-02 | Jimmy 確認完成：unit_name/title_level 下拉欄位建立、舊資料遷移、role_name 改計算欄位（`unit_name & "_" & title_level`） |
| P1（上傳實測） | 2026-05~進行中 | 7 支 JS 已上傳 App 685，於真實資料邊測邊修，正式逐項驗收待簽收 |
| P2（程式碼） | 2026-04-14 | 待上傳 kintone 測試 |
| P3（程式碼） | 2026-04-19 | 已整合入 P1 的 04-chain-preview.js，無獨立待辦 |
| P4（程式碼） | 2026-04-14 | 待上傳 kintone 測試 |
| P5（程式碼） | 2026-04-14 | 待上傳 kintone 測試 |
| P6（程式碼） | 2026-04-14 | 待上傳 kintone 測試 |
| P7（程式碼） | 2026-04-14 | 待上傳 kintone 測試 |
| 架構評估 + v2 提案 | 2026-07-06 | 交付 docs/05、06、07 三份文件（純文件，未動程式碼），待 Jimmy 簽核排程 |
