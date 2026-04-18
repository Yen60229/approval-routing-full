# apps/ — 各 App 專屬 JS

每個 App 有獨立資料夾,檔名前綴數字表示載入順序。

## role-definition/ — 角色定義表

| 檔案 | 用途 |
|------|------|
| `01-role-form-init.js` | 自動產生 role_id |
| `02-field-display.js` | holder_type 條件顯示 |
| `03-next-role-dropdown.js` | next_role_id 下拉 UI |
| `04-chain-preview.js` | 鏈視覺化卡片 |

## employee-entry/ — 員工起點對照表

| 檔案 | 用途 |
|------|------|
| `01-entry-form-init.js` | 表單初始化 |
| `02-batch-import.js` | CSV 批量匯入 |

## 載入順序(kintone 後台設定時)

每個 App 的 JavaScript/CSS 自訂設定頁,按以下順序加入檔案:

1. `core/05-vendor.js` (SweetAlert2)
2. `core/04-utils.js`
3. `core/01-config.js`
4. `core/02-api-client.js` (P4 之後)
5. `core/03-chain-builder.js` (P4 之後)
6. 該 App 的 `apps/xxx/01-*.js`, `02-*.js` ...依序
