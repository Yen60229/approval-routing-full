# Batch Role Creator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立獨立 HTML 工具，讓 Jimmy 貼入 CSV（code, title），設定每個職稱的 holder（個人或群組），一次批量建立 App 685 角色記錄。

**Architecture:** 單一 HTML 檔（`tools/04-batch-role-creator.html`），純 Vanilla JS，透過 kintone REST API + API Token 操作。分三個 UI 區塊：設定、CSV 輸入、角色設定表。無構建流程，需在 kintone 域名下開啟以避免 CORS。

**Tech Stack:** HTML5、Vanilla JS（ES2020+）、kintone REST API（`/k/v1/records.json`、`/k/v1/groups.json`）

> ⚠️ **CORS 注意**：本機直接開啟 `file://` 會遇到 CORS 限制。請將此 HTML 上傳至 kintone 某 App 的附件欄位，再從 kintone 介面開啟（此時在 `*.cybozu.com` 域名下，API 呼叫正常）。

---

## 檔案對照

| 動作 | 檔案 | 說明 |
|------|------|------|
| **新增** | `tools/04-batch-role-creator.html` | 完整獨立工具，含 CSS/JS |

---

## Task 1：HTML 骨架 + CSS + Config 區塊

**Files:**
- Create: `tools/04-batch-role-creator.html`

- [ ] **Step 1：建立 HTML 骨架與 CSS**

  建立 `tools/04-batch-role-creator.html`，寫入以下內容：

  ```html
  <!DOCTYPE html>
  <html lang="zh-TW">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>批量建立角色 — App 685</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: 'Microsoft JhengHei', sans-serif; font-size: 14px; padding: 24px; background: #f5f5f5; color: #333; }
      h1 { font-size: 20px; font-weight: 700; margin-bottom: 20px; }
      .section { background: #fff; border-radius: 8px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
      .section h2 { font-size: 15px; font-weight: 700; margin-bottom: 14px; }
      label { display: block; font-size: 12px; color: #666; margin-bottom: 4px; margin-top: 8px; }
      input[type="text"], input[type="password"], textarea, select {
        width: 100%; padding: 8px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px; color: #333;
      }
      .form-row { display: flex; gap: 12px; flex-wrap: wrap; }
      .form-group { flex: 1; min-width: 200px; }
      button { padding: 8px 18px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 600; }
      .btn-primary { background: #3498db; color: #fff; }
      .btn-primary:hover { background: #2980b9; }
      .btn-success { background: #27ae60; color: #fff; }
      .btn-success:hover { background: #219a52; }
      .btn-secondary { background: #95a5a6; color: #fff; }
      table { width: 100%; border-collapse: collapse; margin-top: 8px; }
      th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #eee; vertical-align: middle; }
      th { background: #f8f9fa; font-weight: 600; font-size: 13px; }
      #status { margin-top: 12px; padding: 10px 14px; border-radius: 4px; display: none; font-size: 14px; }
      .status-success { display: block !important; background: #d4edda; color: #155724; }
      .status-error   { display: block !important; background: #f8d7da; color: #721c24; }
      code { background: #f1f1f1; padding: 2px 5px; border-radius: 3px; font-size: 12px; }
      #previewModal {
        display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,.5); z-index: 100; overflow-y: auto; padding: 40px 20px;
      }
      #previewModalInner {
        background: #fff; margin: 0 auto; width: 90%; max-width: 800px;
        border-radius: 8px; padding: 24px;
      }
      #previewContent { background: #f5f5f5; padding: 12px; border-radius: 4px; font-size: 12px; overflow: auto; max-height: 60vh; }
    </style>
  </head>
  <body>

  <h1>⚙️ 批量建立角色 — App 685</h1>

  <!-- Section 1: Config -->
  <div class="section" id="sec-config">
    <h2>1. 設定</h2>
    <div class="form-row">
      <div class="form-group">
        <label>kintone 子網域（subdomain）</label>
        <input type="text" id="subdomain" placeholder="your-company（不含 .cybozu.com）" />
      </div>
      <div class="form-group">
        <label>API Token（App 685 需有新增權限）</label>
        <input type="password" id="apiToken" placeholder="貼入 API Token" />
      </div>
      <div class="form-group">
        <label>單位名稱（全批套用，例：MIS）</label>
        <input type="text" id="unitName" placeholder="MIS" />
      </div>
    </div>
    <button class="btn-primary" onclick="saveConfig()">儲存設定並載入群組</button>
    <span id="configStatus" style="margin-left:12px;font-size:13px;color:#666;"></span>
  </div>

  <!-- Section 2: CSV Input -->
  <div class="section" id="sec-csv">
    <h2>2. CSV 輸入</h2>
    <p style="color:#666;font-size:13px;margin-bottom:8px">
      格式：<code>code,title</code>（每列一筆，第一列可為標題列）<br>
      範例：<code>user001,課長</code>
    </p>
    <textarea id="csvInput" rows="8" placeholder="user001,課長&#10;user002,次長&#10;user003,部長&#10;user004,部長"></textarea>
    <div style="margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button class="btn-primary" onclick="parseCSV()">解析 CSV</button>
      <span style="color:#999">或上傳檔案：</span>
      <input type="file" id="csvFile" accept=".csv,.txt" onchange="loadCSVFile(event)" />
    </div>
  </div>

  <!-- Section 3: Role Table -->
  <div class="section" id="sec-table" style="display:none">
    <h2>3. 角色設定</h2>
    <p style="color:#666;font-size:13px;margin-bottom:10px">
      每個唯一職稱對應一筆角色記錄。設定 holder_type 與 holder 後送出。
    </p>
    <table id="roleTable">
      <thead>
        <tr>
          <th style="width:220px">role_name（預覽）</th>
          <th style="width:130px">holder_type</th>
          <th>holder</th>
        </tr>
      </thead>
      <tbody id="roleTableBody"></tbody>
    </table>
    <div style="margin-top:16px;display:flex;gap:10px;align-items:center">
      <button class="btn-secondary" onclick="previewJSON()">預覽 JSON</button>
      <button class="btn-success" onclick="submitBatch()">送出建立</button>
    </div>
    <div id="status"></div>
  </div>

  <!-- Preview Modal -->
  <div id="previewModal" onclick="closePreviewOnBackdrop(event)">
    <div id="previewModalInner">
      <h3 style="margin-bottom:12px">JSON 預覽（送出內容）</h3>
      <pre id="previewContent"></pre>
      <button class="btn-secondary" onclick="closePreview()" style="margin-top:12px">關閉</button>
    </div>
  </div>

  <!-- Group datalist (populated after loadGroups) -->
  <datalist id="group-datalist"></datalist>

  <script>
  'use strict';
  // JS will be added in subsequent tasks
  </script>
  </body>
  </html>
  ```

- [ ] **Step 2：在瀏覽器開啟確認 HTML 骨架正確**

  用瀏覽器開啟 `tools/04-batch-role-creator.html`。
  預期：看到標題「批量建立角色」、三個 section（設定、CSV 輸入、角色設定隱藏中）。

- [ ] **Step 3：commit**

  ```bash
  git add tools/04-batch-role-creator.html
  git commit -m "feat(tools): 新增 04-batch-role-creator.html 骨架與 CSS"
  ```

---

## Task 2：Config 區塊 JS（localStorage + API Helpers）

**Files:**
- Modify: `tools/04-batch-role-creator.html`（`<script>` 區塊）

- [ ] **Step 1：在 `<script>` 區塊加入狀態變數與 Config 函式**

  將 `<script>` 內的 `// JS will be added in subsequent tasks` 替換為：

  ```javascript
  'use strict';

  // ─── 狀態 ────────────────────────────────────────────────────────────────────
  let _groups      = [];  // [{ code, name }]
  let _uniqueTitles = []; // [{ title, codes[] }]

  // ─── API Helpers ──────────────────────────────────────────────────────────────

  function getBase() {
    const sub = localStorage.getItem('ar_subdomain') || '';
    return `https://${sub}.cybozu.com`;
  }

  function getHeaders() {
    return {
      'X-Cybozu-API-Token': localStorage.getItem('ar_apiToken') || '',
      'Content-Type': 'application/json',
    };
  }

  // ─── Config ───────────────────────────────────────────────────────────────────

  function saveConfig() {
    const subdomain = document.getElementById('subdomain').value.trim();
    const apiToken  = document.getElementById('apiToken').value.trim();
    const unitName  = document.getElementById('unitName').value.trim();

    if (!subdomain || !apiToken || !unitName) {
      alert('請填寫所有設定欄位（子網域、API Token、單位名稱）');
      return;
    }

    localStorage.setItem('ar_subdomain', subdomain);
    localStorage.setItem('ar_apiToken',  apiToken);
    localStorage.setItem('ar_unitName',  unitName);

    document.getElementById('configStatus').textContent = '⏳ 載入群組中…';
    loadGroups();
  }

  function loadSavedConfig() {
    document.getElementById('subdomain').value = localStorage.getItem('ar_subdomain') || '';
    document.getElementById('apiToken').value  = localStorage.getItem('ar_apiToken')  || '';
    document.getElementById('unitName').value  = localStorage.getItem('ar_unitName')  || '';
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────
  loadSavedConfig();
  ```

- [ ] **Step 2：瀏覽器驗證**

  重新整理頁面，填入任意值後按「儲存設定並載入群組」。
  預期：`configStatus` 顯示「⏳ 載入群組中…」（loadGroups 尚未實作，JS error 在 console，但 localStorage 已寫入）。
  重整頁面後欄位應自動還原填入值。

- [ ] **Step 3：commit**

  ```bash
  git add tools/04-batch-role-creator.html
  git commit -m "feat(tools): 新增 Config 區塊 JS 與 localStorage 儲存"
  ```

---

## Task 3：群組載入 + Autocomplete

**Files:**
- Modify: `tools/04-batch-role-creator.html`

- [ ] **Step 1：在 `// ─── Init` 之前加入 loadGroups 與 rebuildGroupDatalist**

  ```javascript
  // ─── Groups ───────────────────────────────────────────────────────────────────

  async function loadGroups() {
    const statusEl = document.getElementById('configStatus');
    try {
      // kintone 每次最多回傳 100 筆，循環分頁直到取完
      let offset = 0;
      const SIZE = 100;
      _groups = [];

      while (true) {
        const resp = await fetch(
          `${getBase()}/k/v1/groups.json?offset=${offset}&size=${SIZE}`,
          { headers: getHeaders() },
        );
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.message || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        const batch = data.groups || [];
        _groups.push(...batch.map(g => ({ code: g.code, name: g.name })));
        if (batch.length < SIZE) break;
        offset += SIZE;
      }

      rebuildGroupDatalist();
      statusEl.textContent = `✅ 已載入 ${_groups.length} 個群組`;
    } catch (err) {
      statusEl.textContent = `❌ 載入群組失敗：${err.message}`;
      console.error('[batch-role-creator] loadGroups error', err);
    }
  }

  function rebuildGroupDatalist() {
    const dl = document.getElementById('group-datalist');
    dl.innerHTML = _groups
      .map(g => `<option value="${g.code}">${g.name}（${g.code}）</option>`)
      .join('');
  }
  ```

- [ ] **Step 2：瀏覽器驗證**

  填入正確的 subdomain + API Token + 單位名稱，按「儲存設定並載入群組」。
  預期：configStatus 顯示「✅ 已載入 X 個群組」。
  開 DevTools → Network，確認 `/k/v1/groups.json` 回傳 200。

- [ ] **Step 3：commit**

  ```bash
  git add tools/04-batch-role-creator.html
  git commit -m "feat(tools): 群組 API 載入 + autocomplete datalist"
  ```

---

## Task 4：CSV 解析

**Files:**
- Modify: `tools/04-batch-role-creator.html`

- [ ] **Step 1：在 `// ─── Groups` 之後加入 CSV 相關函式**

  ```javascript
  // ─── CSV ──────────────────────────────────────────────────────────────────────

  function loadCSVFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      document.getElementById('csvInput').value = e.target.result;
      parseCSV();
    };
    reader.readAsText(file, 'UTF-8');
  }

  function parseCSV() {
    const raw = document.getElementById('csvInput').value.trim();
    if (!raw) { alert('請輸入 CSV 資料'); return; }

    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) { alert('CSV 內容為空'); return; }

    // 偵測標題列：第一列全為文字且含常見標頭關鍵字
    const firstLower = lines[0].toLowerCase();
    const isHeader = ['code', 'title', '員工', '職稱', '代碼'].some(k => firstLower.includes(k));
    const dataLines = isHeader ? lines.slice(1) : lines;

    const rows = dataLines.map(line => {
      // 支援逗號分隔，處理引號包覆
      const parts = line.split(',').map(p => p.trim().replace(/^"|"$/g, ''));
      return { code: parts[0] || '', title: parts[1] || '' };
    }).filter(r => r.code && r.title);

    if (!rows.length) {
      alert('CSV 解析後無有效資料，請確認格式為 code,title（每行一筆）');
      return;
    }

    // 以 title 去重，保留同 title 的所有 code 供個人 holder 選取
    const titleMap = new Map();
    rows.forEach(({ code, title }) => {
      if (!titleMap.has(title)) titleMap.set(title, []);
      if (!titleMap.get(title).includes(code)) titleMap.get(title).push(code);
    });

    _uniqueTitles = [...titleMap.entries()].map(([title, codes]) => ({ title, codes }));

    renderTable();
  }
  ```

- [ ] **Step 2：瀏覽器驗證**

  在 CSV textarea 貼入：
  ```
  code,title
  user001,課長
  user002,次長
  user003,部長
  user004,部長
  ```
  按「解析 CSV」。
  預期：Section 3 出現，table 顯示 3 列（課長/次長/部長），部長列的個人 holder 下拉有 user003、user004 兩個選項。

- [ ] **Step 3：commit**

  ```bash
  git add tools/04-batch-role-creator.html
  git commit -m "feat(tools): CSV 解析 + 標題列偵測 + 去重邏輯"
  ```

---

## Task 5：角色設定表渲染

**Files:**
- Modify: `tools/04-batch-role-creator.html`

- [ ] **Step 1：在 `// ─── CSV` 之後加入 renderTable 與 onHolderTypeChange**

  ```javascript
  // ─── Table ────────────────────────────────────────────────────────────────────

  function renderTable() {
    const unitName = document.getElementById('unitName').value.trim()
                  || localStorage.getItem('ar_unitName') || '';
    const tbody = document.getElementById('roleTableBody');

    tbody.innerHTML = _uniqueTitles.map(({ title, codes }, idx) => {
      const roleName   = unitName ? `${unitName}_${title}` : title;
      const codeOpts   = codes.map(c => `<option value="${c}">${c}</option>`).join('');

      return `
        <tr data-idx="${idx}" data-title="${title}">
          <td><code>${roleName}</code></td>
          <td>
            <select class="holder-type-select"
                    onchange="onHolderTypeChange(this, ${idx})"
                    style="width:100%">
              <option value="指定個人">指定個人</option>
              <option value="指定群組">指定群組</option>
            </select>
          </td>
          <td>
            <div id="holder-ind-${idx}">
              <select class="holder-user-select" style="width:100%">
                ${codeOpts}
              </select>
            </div>
            <div id="holder-grp-${idx}" style="display:none">
              <input type="text"
                     class="holder-group-input"
                     list="group-datalist"
                     placeholder="輸入群組代碼或名稱…"
                     style="width:100%" />
            </div>
          </td>
        </tr>
      `;
    }).join('');

    document.getElementById('sec-table').style.display = '';
    document.getElementById('sec-table').scrollIntoView({ behavior: 'smooth' });
  }

  function onHolderTypeChange(select, idx) {
    const isGroup = select.value === '指定群組';
    document.getElementById(`holder-ind-${idx}`).style.display = isGroup ? 'none' : '';
    document.getElementById(`holder-grp-${idx}`).style.display = isGroup ? ''     : 'none';
  }
  ```

- [ ] **Step 2：瀏覽器驗證**

  解析 CSV 後確認：
  - 每個唯一職稱顯示一列，role_name 欄顯示 `單位_職稱`
  - holder_type 切換「指定群組」→ 出現群組 input；切回「指定個人」→ 出現 user select
  - 群組 input 輸入 1-2 字後，datalist 顯示對應群組選項（需已載入群組）

- [ ] **Step 3：commit**

  ```bash
  git add tools/04-batch-role-creator.html
  git commit -m "feat(tools): 角色設定表渲染 + holder_type 切換"
  ```

---

## Task 6：role_id 產生 + buildRecords + JSON 預覽

**Files:**
- Modify: `tools/04-batch-role-creator.html`

- [ ] **Step 1：在 `// ─── Table` 之後加入以下函式**

  ```javascript
  // ─── role_id ──────────────────────────────────────────────────────────────────

  function generateRoleIds(count) {
    const now = new Date();
    const ts = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('');
    return Array.from({ length: count }, (_, i) =>
      `ROLE_${ts}_${String(i + 1).padStart(3, '0')}`,
    );
  }

  // ─── Build Records ────────────────────────────────────────────────────────────

  function buildRecords() {
    const unitName = document.getElementById('unitName').value.trim()
                  || localStorage.getItem('ar_unitName') || '';
    const rows   = [...document.querySelectorAll('#roleTableBody tr')];
    const roleIds = generateRoleIds(rows.length);

    return rows.map((row, idx) => {
      const title      = row.dataset.title;
      const holderType = row.querySelector('.holder-type-select').value;

      const record = {
        role_id:     { value: roleIds[idx] },
        unit_name:   { value: unitName },
        title_level: { value: title },
        holder_type: { value: holderType },
        is_active:   { value: ['啟用中'] },
      };

      if (holderType === '指定個人') {
        const code = row.querySelector('.holder-user-select').value;
        record.holder_user = { value: [{ code }] };
      } else {
        const code = row.querySelector('.holder-group-input').value.trim();
        record.holder_group = { value: [{ code }] };
      }

      return record;
    });
  }

  // ─── Preview ──────────────────────────────────────────────────────────────────

  function previewJSON() {
    const records = buildRecords();
    document.getElementById('previewContent').textContent =
      JSON.stringify({ app: 685, records }, null, 2);
    document.getElementById('previewModal').style.display = '';
  }

  function closePreview() {
    document.getElementById('previewModal').style.display = 'none';
  }

  function closePreviewOnBackdrop(event) {
    if (event.target === document.getElementById('previewModal')) closePreview();
  }
  ```

- [ ] **Step 2：瀏覽器驗證**

  設定好所有列的 holder 後按「預覽 JSON」。
  預期：Modal 出現，JSON 中每筆記錄含 `role_id`（格式 `ROLE_YYYYMMDDHHMMSS_001`）、`unit_name`、`title_level`、`holder_type`、正確的 `holder_user` 或 `holder_group`、`is_active: ['啟用中']`。
  點 Modal 背景或「關閉」按鈕可關閉。

- [ ] **Step 3：commit**

  ```bash
  git add tools/04-batch-role-creator.html
  git commit -m "feat(tools): role_id 產生 + buildRecords + JSON 預覽 modal"
  ```

---

## Task 7：批量送出 + 進度顯示

**Files:**
- Modify: `tools/04-batch-role-creator.html`

- [ ] **Step 1：在 `// ─── Preview` 之後加入 submitBatch**

  ```javascript
  // ─── Submit ───────────────────────────────────────────────────────────────────

  async function submitBatch() {
    const records = buildRecords();
    if (!records.length) { alert('沒有要建立的記錄'); return; }

    // 驗證：指定群組的 holder 不可為空
    const emptyGroup = records.find(
      r => r.holder_type.value === '指定群組' && !r.holder_group?.value[0]?.code,
    );
    if (emptyGroup) {
      alert(`「${emptyGroup.title_level.value}」的群組代碼未填寫，請先填入再送出`);
      return;
    }

    if (!confirm(`確認建立 ${records.length} 筆角色記錄？`)) return;

    const CHUNK = 100;
    const chunks = [];
    for (let i = 0; i < records.length; i += CHUNK) {
      chunks.push(records.slice(i, i + CHUNK));
    }

    const statusEl = document.getElementById('status');
    statusEl.className = '';
    statusEl.style.display = '';

    let created = 0;
    for (let i = 0; i < chunks.length; i++) {
      statusEl.textContent = `⏳ 送出中… ${created} / ${records.length} 筆`;

      try {
        const resp = await fetch(`${getBase()}/k/v1/records.json`, {
          method:  'POST',
          headers: getHeaders(),
          body:    JSON.stringify({ app: 685, records: chunks[i] }),
        });

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.message || `HTTP ${resp.status}`);
        }

        created += chunks[i].length;
      } catch (err) {
        statusEl.className = 'status-error';
        statusEl.textContent =
          `❌ 第 ${i + 1} 批失敗（已建立 ${created} 筆）：${err.message}`;
        console.error('[batch-role-creator] submitBatch error', err);
        return;
      }
    }

    statusEl.className = 'status-success';
    statusEl.textContent = `✅ 成功建立 ${created} 筆角色記錄！前往 App 685 確認。`;
  }
  ```

- [ ] **Step 2：瀏覽器完整流程驗收**

  1. 填入 subdomain + API Token + 單位名稱 → 按「儲存設定並載入群組」→ 確認群組載入成功
  2. 貼入 CSV → 按「解析 CSV」→ 表格出現
  3. 設定幾列為「指定個人」（選 user code）、幾列為「指定群組」（輸入群組代碼）
  4. 按「預覽 JSON」→ 確認 JSON 格式正確
  5. 按「送出建立」→ confirm 後執行
  6. 預期：status 顯示「✅ 成功建立 X 筆角色記錄！」
  7. 前往 kintone App 685 確認記錄正確建立，`unit_name`、`title_level`、`holder_type`、holder 欄位均正確，`role_name` 計算欄位自動顯示 `單位_職稱`

- [ ] **Step 3：驗收「群組代碼為空」攔截**

  故意留一列群組 holder 為空，按「送出建立」。
  預期：alert 提示「XXX 的群組代碼未填寫」，不送出。

- [ ] **Step 4：commit & push**

  ```bash
  git add tools/04-batch-role-creator.html
  git commit -m "feat(tools): 批量送出 + 分批 100 筆 + 進度顯示 + 空群組攔截"
  git push origin main
  ```

---

## Self-Review

**Spec coverage check:**
- ✅ 獨立 HTML 單檔 → Task 1
- ✅ API Token + subdomain 輸入，localStorage 儲存 → Task 2
- ✅ 單位名稱手動輸入，全批套用 → Task 2 / 5
- ✅ CSV 貼入/上傳，標題列偵測，去重 → Task 4
- ✅ 群組 autocomplete（GET /k/v1/groups.json，分頁撈完） → Task 3
- ✅ 每唯一職稱一列，holder_type 切換 → Task 5
- ✅ 同職稱多人時個人 holder 顯示下拉 → Task 4 / 5
- ✅ role_id 格式 ROLE_[timestamp]_[index] → Task 6
- ✅ role_name 不手動設（kintone 計算欄位） → Task 6（buildRecords 不含 role_name）
- ✅ 批量 POST，最多 100 筆分批 → Task 7
- ✅ 任一批失敗顯示錯誤，停止後續 → Task 7
- ✅ 群組代碼空白攔截 → Task 7
- ✅ next_role_id / signing_mode / is_chain_end 留空 → Task 6（buildRecords 不含這些欄位）
- ✅ CORS 注意事項 → plan header 說明

**Placeholder scan:** 無 TBD/TODO ✓

**Type consistency:**
- `_uniqueTitles: [{ title: string, codes: string[] }]` — Task 4 定義，Task 5/6/7 使用 ✓
- `buildRecords()` — Task 6 定義，Task 7 呼叫 ✓
- `generateRoleIds(count)` — Task 6 定義，Task 6 `buildRecords` 內呼叫 ✓
- `holder-ind-${idx}` / `holder-grp-${idx}` — Task 5 渲染，Task 5 `onHolderTypeChange` 使用 ✓
