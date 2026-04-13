# core/ — 核心共用模組

所有 App 都會引用的模組,寫一次、共用多處。

## 規劃檔案

| 檔案 | 用途 | 建立時機 |
|------|------|---------|
| `01-config.js` | App ID、欄位代碼集中管理 | P1 |
| `02-api-client.js` | REST API 封裝 + 快取機制 | P4 |
| `03-chain-builder.js` | buildChain() 核心邏輯 | P4 |
| `04-utils.js` | safeHandler、SweetAlert 包裝 | P1 |
| `05-vendor.js` | 第三方套件載入 (SweetAlert2) | P1 |

## 命名規則

檔名前綴數字表示**載入順序**,kintone 自訂 JS/CSS 設定時按順序排列。
