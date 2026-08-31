# Phase 進度追蹤

> 每完成一個 Phase,在下方打勾並寫下日期。

---

## 當前狀態

- **當前 Phase**:**P8 Phase B — 程式碼完成，待 kintone 端驗證** — config / api-client / route-engine / role-picker / route-form 全部完成，**149 項測試全過**；App 736 已建好並驗證
- **下一步動作**:(1) 上傳 736 的三支 core + `07-role-picker` + `apps/form-route/01-route-form.js`，手動驗 UI；(2) `03-next-role-dropdown.js` 重新上傳 685 手動回歸；(3) 測試 App 實測「更新執行者 API」→ 進 Phase C／D（產生器 + 標準 adapter）
- **最後更新**:2026-09-01（Phase B 收尾：`core/07-role-picker.js` 抽共用 + `03` 改用它、`apps/form-route/01-route-form.js`（子表格逐列淡化 + RolePicker + submit 驗證）。App 736 schema 驗證通過、App ID 回填 736。**基石假設否決** → 執行者用「更新執行者 API」`PUT /k/v1/record/assignees`。149 項測試全過）

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

### ✅ P1 — 角色表 HR 介面（2026-07-12 逐項驗收通過，正式簽收）
- [x] **正式驗收**：14 項白話驗收清單全數通過 ✅ 2026-07-12（`docs/P1驗收清單.md`）
  - [x] 驗收中發現 3 項問題並當場修正：新增頁預覽誤報「找不到角色」、
        多欄位漏填連續彈窗、`return null` 擋不住儲存（詳見清單文末表格）
  - [x] core/04-utils.js 新增 `pushSubmitError` / `flushSubmitErrors` 共用錯誤彙整
        （⚠️ 依賴 07 為最後上傳的 JS，調整上傳順序時注意）
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
- [x] **正式逐項驗收** ✅ 2026-07-12 全數通過並簽收（清單移至 `docs/P1驗收清單.md`）

### ✅ P2 — 起點表 HR 介面 + 批量匯入（程式碼已完成，待上傳測試）
- [x] `apps/employee-entry/01-entry-form-init.js` — 起點角色下拉選單 ✅ 2026-04-14
  - [x] 升級為可搜尋下拉元件 ✅ 2026-05-10
  - [x] 與 role-definition 同步：unit_name 分組排序、完整 role_name 去重、識別改以 role_name 為準 ✅ 2026-06-02
- [x] `apps/employee-entry/02-batch-import.js` — CSV 匯入 + dry-run ✅ 2026-04-14
  - [x] CSV 第二欄改用角色名稱（HR 看得懂）；dry-run 加驗員工帳號存在、
        已有起點者跳過（中斷後重傳同一份 CSV 安全）✅ 2026-07-12
- [x] `tools/05-coverage-check.js` — 涵蓋率檢查工具（P2 衍生，Jimmy 需求）✅ 2026-07-12
  - 685/686 清單頁「未設定名單」按鈕：找出「使用中」但未納入簽核系統的使用者
  - A 區「未設定起點」：依「單位＋職稱」分組，一組一列各選起點角色，
    **可跨多個單位一次建立** 686 記錄 ✅ 2026-08-19 改版
    - 同單位同職稱的人起點必然相同，所以一組只要選一次；比對 685 的
      unit_name / title_level 自動帶入，配不到的整列標紅且勾不動
    - 兼任多單位／多職稱／資料不全者另立一區逐人手選；兩區互斥 + 送出前帳號去重，
      同一個人不會被建出兩筆起點
    - 原本一次只能選一個起點角色，跨多單位要一個單位做一輪
  - B 區「不具簽核身分」：勾人 → 選「指定個人」角色 → **每人各建一筆新的同名角色記錄**
    （holder_user 一筆只掛一人，同一關有幾個簽核者就有幾筆同名記錄；新記錄沿用
    記錄編號最小那筆的下一關等設定，既有記錄一概不動；同名記錄的下一關若不一致會警告）
    ✅ 2026-08-19 改版
    - 舊做法是把勾選的人「附加」進**所有**同名記錄，N 人 × M 筆 = 同一人被重複掛
      在同一關的多筆記錄上，這是 tools/06 掃出大量重複的主因
  - C 區「已停用仍有起點」：勾人 → 批量取消 686 記錄的「啟用中」（保留不刪）✅ 2026-07-12
  - D 區「已停用仍是簽核者」：勾人 → **批量取消該角色的「啟用中」**；
    holder_user 一律不動（簽核者名單誤刪無法自動復原）；角色若還有其他在職簽核者
    會醒目警告；簽核群組內的停用帳號列橫幅提醒請 IT 處理 ✅ 2026-08-19 改版
  - E 區「姓名格式異常」：姓名未同時具備中文與英文者獨立歸類，並自 A～D 排除 ✅ 2026-08-19
  - F 區「角色沒有簽核者」：啟用中 + 指定個人 + holder_user 空白 → 批量取消啟用中；
    「鏈上游」欄顯示有幾條鏈指向它，有上游者停用會讓那些鏈建立失敗 ✅ 2026-08-19
  - A/B 區角色選擇改為可打字搜尋（↑↓/Enter）；各區新增「職稱」欄並可搜尋 ✅ 2026-08-19
  - 各區均可匯出 CSV（含 BOM，Excel 直開不亂碼）
  - A/B/C/D/F 五處批量寫入補上錯誤處理：抽出共用 helper 統一 try/catch/finally，
    寫入失敗會關轉圈、跳錯誤並提醒「部分可能已經寫入，請重新掃描確認」，
    rescan() 成功／失敗都會跑（原本失敗時轉圈永遠不關、使用者不知道已寫入一半）
    ✅ 2026-08-19
  - **起點（686）與下一關（685）改為同步設定** ✅ 2026-08-20（Jimmy 需求）
    - A 區選好起點角色後，若那一關在 685 沒設下一關（next_role_id 空、也沒勾終點），
      同一列會出現「下一關」選擇器，補齊之前該列勾不動；送出時**先寫 685 再建 686**，
      「有起點卻沒有下一關」的斷鏈不會再從這個流程產生
    - 同名記錄若已經有人設過下一關就自動帶入同一個值；起點本身是最後一關時可選「設為終點」
    - 兩列指到同一個角色卻選了不同下一關時整批擋下（同名角色是同一關，只能有一個下一關）
    - 逐列即時偵測迴圈（含指到自己），會繞回來的選擇直接鎖住不給勾
  - G 區「起點角色設定不完整」：收拾既有資料 ✅ 2026-08-20
    - 一列是一個「被當成起點的關卡」而不是一個人——補一次就救回所有以它為起點的同仁
    - `沒有設下一關` → 選好下一關後批量補進 685（同名記錄一起補）
    - `685 沒有這個角色`（沒建、或已取消啟用中）→ 整列紅底、勾不動，只提示請 HR 用
      「批量建立角色」補建或到 686 改指到現有角色；新建角色要決定簽核者／單位／職稱，
      是人的判斷，工具不代勞
    - 帳號已停用的人不列入（那是 C 區的範圍）
  - **修正 A 區漏人**：原本只看「686 有沒有這個人的記錄」，記錄在、`entry_role_id`
    空白的人被當成已設定而看不到（G 區又因為沒有 role_id 跳過，兩邊都漏）。
    改為以「有沒有填角色」判斷；寫入改成 upsert——有空白記錄就補填原記錄，
    沒有記錄才新建，不會對同一人建出第二筆起點 ✅ 2026-08-20
  - **A 區可就地新建 685 角色** ✅ 2026-08-20（Jimmy 需求）
    - 配不到現有角色的列，角色清單最前面多一個「＋ 在 685 建立這個角色」；
      選了就地填 unit_name / title_level（依組織名稱與 kintone 職務自動帶入、可手改）
    - 一關有幾個人就建幾筆同名記錄各掛一人；起點指到最先建立的那一筆
    - 單位＋職稱若已經有角色會整列擋下，請 HR 直接從清單選，不重複建
    - `role_name` 是計算欄位不寫入；欄位型別與下拉選項用 REST 讀 685
      （`kintone.app.getFormFields()` 從 686 開會拿到 686 的欄位）
  - ⚠️ **待確認**：`tools/04-batch-role-creator.js` 仍在 POST `role_name`（舊的 `_` 格式），
    計算欄位不接受寫入，很可能就是部分角色建不起來的原因
  - **A 區「人數」欄可展開名單、可拆成一人一列各自編輯** ✅ 2026-08-20（Jimmy 需求）
    - 多人一組時按「名單」展開看完整成員姓名／帳號；單人列直接顯示姓名
    - 按「拆開設定」把整組拆成一人一列，各自挑不同的起點角色（含就地新建角色）；
      原組列只隱藏不刪除，按「合併回整組」可復原，不必重新配對
- [x] `tools/06-holder-duplicate-check.js` — 簽核者重複檢查（Jimmy 需求）✅ 2026-08-19
  - 685 清單頁「簽核者重複檢查」按鈕，只掃啟用中 + holder_type「指定個人」
  - **前提規則**：一筆記錄只掛一人（見 `docs/對話脈絡.md` §9.5），
    所以同名角色有多筆是正常的，違規的是「一筆掛多人」與「同一人佔同一關多筆」
  - ① 一筆記錄掛了多人 → **拆成一人一筆**：原記錄留第一人（role_id 不變，
    指向它的鏈不會斷），其餘每人各建一筆新記錄沿用原設定，沒有人會被移除
    ✅ 2026-08-19 改版（原本是「同一筆內同一人重複 → 去重」）
  - ② 同一人在同一關被掛了多筆 → 逐筆勾選後可**刪除**或**停用**，附「保留第一筆」快捷；
    每筆顯示 role_id／下一關／簽核方式／簽核者人數／被指向數，供判斷保留哪筆
    - 同一筆記錄若出現在多個人的區塊，各區塊的勾選狀態會同步（原本不同步會刪錯筆）
  - ③ 一人身兼多個角色 → 純檢視，供確認沒有誤設
  - 刪除／停用前先算「被指向數」：685 其他角色的 next_role_id、686 啟用中起點的
    entry_role_id；有被指向的記錄直接鎖住不可勾選，避免斷鏈
- [x] `tools/07-batch-next-role.js` — 批次設定下一關角色（Jimmy 需求）✅ 2026-08-19
  - 以 role_name 為單位列出關卡，勾多個來源 → 選一個下一關 → 一次寫入所有同名記錄
  - 三道防護：自我循環、迴圈偵測（列出完整路徑）、來源原為終點時一併取消 is_chain_end
  - 「目前的下一關」欄會標紅提示同名記錄設定不一致的關卡
- [x] `tools/08-role-chain-search.js` — 角色簽核鏈快搜（Jimmy 需求）✅ 2026-08-27
  - 685 清單頁「查簽核鏈」按鈕：輸入角色名稱或 role_id 即時過濾，選一個關卡就看到
    完整上下游鏈（沿用詳情頁的預覽渲染，不重寫一套）
  - 清單以 `role_name` 分組（一組＝一個關卡，同名多筆是一人一筆的正常狀態），
    右側可切換要看哪一筆記錄的鏈，並附「開啟記錄」連結
  - 同組記錄的 `next_role_id` 不一致會標紅示警（可用 tools/07 統一）
  - ↑↓ 選取、Enter 確認、Esc 關閉；唯讀工具不寫入任何欄位
  - ⚠️ 相依 `apps/role-definition/04-chain-preview.js`（需排在本檔之前載入），
    該檔新增對外介面 `ChainPreview.loadRoles / renderInto`
- [x] `tools/09-role-id-format-check.js` — role_id 位數對照與批次修正（Jimmy 需求）✅ 2026-08-27
  - 685／686 清單頁「role_id 位數對照」按鈕
  - ① 列出數字不足 4 碼的代碼（如 `ROLE_599`），並把要一起改的三處攤平：
    685 `role_id` 本體、685 `next_role_id`、686 `entry_role_id`，附記錄連結與啟用狀態；
    可勾選後**一鍵批次補零**，或複製 TSV 貼進 Excel 手動處理
  - **寫入順序固定為「引用 → 本體」**：① 685 next_role_id → ② 686 entry_role_id →
    ③ 685 role_id。三步之間必然有幾秒鐘鏈是斷的，選這個順序是因為中途失敗還能
    「重掃 + 再按一次」補完；反過來先改本體，殘留的引用就掃不到了
  - 補零後若已有相同代碼會標紅、不可勾選（違反唯一值），實務上不該發生——所有產號器都是
    `parseInt` 後取 max，兩種位數共用同一條號碼線
  - ② 另列出指向不存在代碼的記錄，判斷是否為「位數寫錯」（換一種位數就找得到），
    可一鍵把這些引用接回正確代碼（只動引用、不動本體）
  - ② 也可勾選後**批次指定要指向的角色**（685 寫 `next_role_id`、686 寫 `entry_role_id`），
    附即時過濾的角色選擇器；套用前偵測迴圈（目標的下游走得回來源就擋下），
    來源原本標記終點的一併取消 `is_chain_end`
    - 與 `tools/07-batch-next-role.js` 的分工：07 以 role_name 整個關卡為單位改，
      09 是針對「這幾筆壞掉的記錄」改
  - 寫入一律走 records 批量 API，每 100 筆一批
- [ ] 上傳至 kintone 員工起點對照表 App 並測試（core 3 支 + employee-entry 2 支 + tools/05）
- [ ] tools/05 一併上傳至 App 685（涵蓋率按鈕兩表都能開）
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

### 🔄 P8 — 表單路由 + 流程管理標準化 + 試點接入（進行中）

> 設計定案見 `docs/06`（v1.1）與 `docs/對話脈絡.md` §9.8。
> 核心決策：**`form_route_config` 是唯一設定源**，同時驅動執行期建鏈與部署期產生 status.json。
> 全部關卡一律即時解析，不做混合方案。

#### ✅ Phase A — 引擎前置修復（2026-08-31 完成，91 項測試全過）
- [x] **#1** `core/02-api-client.js` — `entryCache` 補 TTL（60 秒）+ 新增 `ensureFresh()` 一次清兩個快取
  - `buildChain` 的 `forceFresh` 同步改呼叫 `ensureFresh()`——**只改 api-client 不改呼叫端，這個修復等於白做**
- [x] **#2** `core/03-chain-builder.js` — 抽出 `findEmptyHolderError()`，解析後有空簽核者的關卡即回 `ok:false`
  - 錯誤訊息指出第幾關與角色名；Phase B 的 `buildChainForForm` 可直接複用同一支函式
- [x] **#3** `assembleChainStep` 帶入 `signing_mode` 快照 + `CHAIN_FIELDS` / `docs/02` 同步
  - 趁子表格尚未嵌入任何申請 App 才是零成本，上線後再改是遷移工程
- [x] **#4** `tools/01-health-check.js` — 新增第 6 條規則「同名角色設定一致性」
  - 同名＝同一關，`next_role_id`／`is_chain_end`／`signing_mode` 三者不一致列 🔴，可用 tools/07 統一
- [x] 測試補回歸案例：空簽核者（個人／群組兩種）、`signing_mode` 逐關快照

#### 🔄 Phase B — 路由設定層（進行中）
- [x] **Jimmy 手動建立 `form_route_config` App** = **App 736** ✅ 2026-09-01
      schema 逐欄驗證通過（主表 9 欄 + `form_app_id` unique + 子表格 6 欄，型別／選項全對，
      `stop_at_title_level`／`skip_title_levels` 選項＝685 `title_level`）；`skip_title_levels`
      實建為 `MULTI_SELECT`（值為字串陣列，引擎相容）。`APP_ID.FORM_ROUTE_CONFIG` 已回填 736
- [x] `core/01-config.js` — 新增 `APP_ID.FORM_ROUTE_CONFIG`、`ROUTE_FIELDS`、`ROUTE_STEP_FIELDS`、
      `SEGMENT_TYPE_OPTIONS`、`STEP_SIGNING_MODE_OPTIONS`、`REJECT_TARGET_OPTIONS`、`ADAPTER_FIELDS` ✅ 2026-08-31
- [x] `core/02-api-client.js` — `getRouteConfig()` / `clearRouteConfigCache()`，比照 `loadAllRoles()`
      三道防線（TTL 5 分鐘 + Promise singleton + 全量快取，key＝form_app_id 字串）；
      `ensureFresh()` 一併清路由快取 ✅ 2026-08-31
- [x] `core/03-chain-builder.js` — 沿鏈走訪抽為 `walkSegment()`（支援 `stop_at_title_level` /
      `skip_title_levels` / 跨段共用 `visited`）；Phase 2+3 抽為 `finalizeChain()`；
      `walkChainStructure` 改為薄包裝，行為不變（15 項既有測試全過）✅ 2026-08-31
- [x] `core/06-route-engine.js` — `buildChainForForm()` ✅ 2026-08-31
  - 逐段展開：員工鏈段呼叫 `walkSegment`、指定角色段直接 `getRole`
  - `skip_title_levels` 命中者**照走 next_role_id，只是不 push**——跳關不是斷鏈
  - `visited` Set 跨段共用；查無路由或未啟用 → fallback 走 `buildChain()`，向下相容
  - docs/06 §4 兩個待決點採提案傾向：連續兩關同一人**保留兩關**、個人段起點即截止職稱則**個人段為空**
  - 員工鏈段指定「全員會簽」直接回 `ok:false`（位置浮動，產生器生不出 ALL 狀態，docs/06 §5.4）
  - `step_signing_mode` 非「沿用角色表」時，覆寫該段每一關的 `signing_mode` 快照
- [x] `core/07-role-picker.js` — 可搜尋分組下拉元件，由 `03-next-role-dropdown.js` 抽出共用
      （方案 A）✅ 2026-09-01
  - 純 UI，不認得 kintone 欄位；呼叫端給 options + onSelect
  - `03-next-role-dropdown.js` 改用它（保留抓角色 / 綁 next_role_id / 事件），順帶多了 ↑↓／Enter／Esc
  - ⚠️ **`03` 無自動測試（DOM/kintone），上傳後要在 685 手動回歸一次**（下一關下拉的選、還原、預覽刷新）
  - ⚠️ 上傳順序：`core/07` 必須在 `apps/role-definition/03` 與 `apps/form-route/01` 之前（core 一律先載，自動滿足）
- [x] `apps/form-route/01-route-form.js` ✅ 2026-09-01
  - 子表格每列：依段類型 **DOM 淡化**（`opacity`+`pointer-events`）不相關欄位——子表格內欄位
    不能用 `setFieldShown`；段類型切換靠 radio 的 `change` DOM 事件（子表格內欄位的 kintone
    change 事件官方未載明，不依賴）
  - `指定角色` 格掛 `RolePicker`，隱藏原生 input，`onSelect` 寫回 `route_steps[i].role_id`
    後 `kintone.app.record.set()`（會重繪）→ **MutationObserver** 統一重掛（列增刪、set 重繪一把抓）
  - **不寫死子表格欄位 ID**：每列儲存格用 `control-<型別>-field-gaia` class 分類，兩個
    single_check（段類型／簽核模式）再用 radio value 區分；欄位重建 ID 會變、此法不受影響
  - submit 驗證 `validateRouteSteps`（純函式、13 項測試）：段類型↔欄位配對、「全員會簽」僅指定角色段、
    指定角色須存在於啟用中角色、至少一列
  - 載入時比對 `stop_at_title_level`／`skip_title_levels` 選項 vs 685 `title_level`（集合比，不看順序），
    不一致跳一次 `showWarning`
  - ⚠️ **DOM 部分無自動測試**，上傳 736 後手動驗：列增刪會重掛 picker、選角色寫得進 role_id、
    切段類型會淡化對應欄位、submit 擋錯、職稱不同步會警告
  - ⚠️ **同名角色限制**：picker 依 role_name 去重、寫第一筆 role_id；指定角色段目前解析成
    **單一**簽核者。若某職能關要「同名多人全簽」需再擴充（引擎 fixed-role 段展開同名 role_id）——待 Jimmy 確認是否需要
- [x] 測試：`route-engine`（20）+ `getRouteConfig`（9）+ `role-picker`（16）+ `route-form`（13）；合計 **149 項全過** ✅ 2026-09-01
- [x] ~~驗證基石假設：proceed 寫 `current_approvers` + return event~~ **已否決** ✅ 2026-08-31
  - Jimmy 實務回報「這樣直接寫入有時候會失敗」；查證確認是已知行為（執行者＝「指定欄位」時
    用按鈕按下前的值解析）。**決策：執行者改用「更新執行者 API」（`PUT /k/v1/record/assignees`）**
    為權威機制，proceed 欄位寫入降為 best-effort，`detail.show` 當安全網補正。
    詳見 `docs/對話脈絡.md` §9.8、`docs/06` §5.3（已同步更新）
- [ ] 驗證更新執行者 API：測試 App 上確認「狀態已設執行者時 `PUT /k/v1/record/assignees`
      帶 revision 可成功換人、換完該人能執行動作」（比 proceed 改欄位穩，但仍要實測一次）← **需測試 App**

#### ⬜ Phase C／D — 產生器與 adapter（第三輪）
- [ ] `tools/10-status-generator.js` — 掛在路由表列表頁
  - K 值算法：取 686 的 distinct `entry_role_id`（~80 個）各展開一次取 max，**不要掃 500 名員工**
  - 管線：GET 備份 → generate → validate → PUT preview → 人工確認 → deploy → 回寫 `max_depth`/`deployed_at`/`deployed_hash`
- [ ] `adapters/00-standard-adapter.js` — 一支掛所有申請 App
  - submit 需檢查 `chain.length > max_depth`（組織變動會讓鏈長超過已部署狀態數，單子會卡在最後一關）
  - submit 僅在「草稿」狀態重算鏈；proceed 需防 race（`current_step` 與動作關卡不一致即擋下）
  - **執行者寫入**：proceed best-effort 寫 `current_approvers`；`detail.show` 當安全網——
    狀態為簽核中(n) 但實際執行者 ≠ 子表格第 n 關 `expected_signers` → 即時解析 →
    `PUT /k/v1/record/assignees`（帶 revision，衝突重試一次）+ 同步更新 `current_approvers`
- [ ] 全新測試表單端到端：三種路由（純個人段／含職能段／**含跳關**）× 兩種鏈深度
- [ ] 在途單改 685 的 `holder_user`，確認跑到該關拿到新的人（驗證即時解析 + 更新執行者 API 補正）
- [ ] kintone 權限設定：記錄權限依狀態開放 + JS disabled（見 `docs/02` 權限節）

### ⬜ P9 — 大規模切換準備
- [ ] `scripts/migration/` — 舊資料轉換
- [ ] `docs/03-應變指南.md` — 出問題怎麼辦

### ⬜ P10 — 全面切換 + 文件交付
- [ ] 其餘 App 統一切換
- [ ] `docs/01-HR維護操作手冊.md` 定稿
- [ ] `docs/04-開發者整合指南.md` 定稿

---

## 🆕 v2 擴充提案（2026-07-06 交付，✅ 2026-07-11 Jimmy 拍板：照建議排程採納）

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

**已確認的決策**（2026-07-11）：三份提案照上方建議排程全數採納——docs/06 表單路由在 P8 前實作、docs/07 代理人在試點跑穩後、approver_chain 子表格同步補 `signing_mode`。

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
| P1（上傳實測） | 2026-05~2026-07 | 7 支 JS 已上傳 App 685，於真實資料邊測邊修 |
| **P1（驗收簽收）** | **2026-07-12** | 14 項白話驗收清單全數通過（`docs/P1驗收清單.md`）；驗收中修正 3 項問題：新增頁預覽誤報、連續彈窗改單一彙整、`return null` 擋不住儲存 |
| P2（程式碼） | 2026-04-14 | 待上傳 kintone 測試 |
| P3（程式碼） | 2026-04-19 | 已整合入 P1 的 04-chain-preview.js，無獨立待辦 |
| P4（程式碼） | 2026-04-14 | 待上傳 kintone 測試 |
| P5（程式碼） | 2026-04-14 | 待上傳 kintone 測試 |
| P6（程式碼） | 2026-04-14 | 待上傳 kintone 測試 |
| P7（程式碼） | 2026-04-14 | 待上傳 kintone 測試 |
| 架構評估 + v2 提案 | 2026-07-06 | 交付 docs/05、06、07 三份文件（純文件，未動程式碼） |
| v2 提案拍板 | 2026-07-11 | Jimmy 決策：照建議排程全數採納（06 於 P8 前、07 於試點後、子表格補 signing_mode） |
| **P8 設計定案** | **2026-08-31** | docs/06 升版 1.1：員工鏈段補 `skip_title_levels`、廢除 repo spec 檔改由路由表驅動流程管理；確認全部關卡即時解析不做混合（理由見對話脈絡 §9.8） |
| **P8 Phase A** | **2026-08-31** | 引擎前置修復 4 項（docs/05 #1#2#3#4）完成，91 項測試全過 |
| **P8 Phase B a/b/c** | **2026-08-31** | ROUTE 欄位代碼、`getRouteConfig` 全量快取、`core/06-route-engine.js` `buildChainForForm`；`walkSegment`/`finalizeChain` 由 03 抽出共用；120 項測試全過。剩 d（表單 UI）卡 App 736 掛載 |
| **P8 執行者機制定案** | **2026-08-31** | 基石假設否決：proceed 直寫欄位不穩（已知行為），執行者改用「更新執行者 API」`PUT /k/v1/record/assignees` 為權威 + `detail.show` 安全網；docs/06 升 1.2、docs/02 與對話脈絡 §9.8 同步 |
| **P8 Phase B 收尾** | **2026-09-01** | App 736 建好＋schema 驗證、App ID 回填 736；`core/07-role-picker.js` 抽共用（方案 A）＋`03` 改用；`apps/form-route/01-route-form.js`（子表格逐列 DOM 淡化＋RolePicker＋`validateRouteSteps`）。149 項測試全過。剩：736／685 手動回歸、更新執行者 API 實測 |
