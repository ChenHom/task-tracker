# task-tracker Unicode identifier baseline

更新日期：2026-08-05

這是 `/home/hom/code/task-tracker` 第一輪、範圍受限的 Unicode identifier/display 欄位盤點。它描述目前行為，不宣稱導入新的 normalization、IDNA、confusable blocking 或 Unicode 安全政策。

## 可重跑證據

使用不接觸歷史資料的 in-memory SQLite fixture：

```bash
npx tsx src/unicodeIdentifier.test.ts
npx tsc --noEmit
```

目前環境的 fixture readback：

```json
{
  "node": "24.3.0",
  "icu": "77.1",
  "unicode": "16.0",
  "cldr": "47.0",
  "sqlite": "3.50.1",
  "sqlite_collations": ["RTRIM", "NOCASE", "BINARY"],
  "users_email_column": {"type": "TEXT", "notnull": 1},
  "default_ascii_case_equality": 0,
  "explicit_nocase_ascii_case_equality": 1,
  "nfc_equals_nfd_after_nfc": true,
  "unicode_domain_raw": "user@例子.測試",
  "unicode_domain_ascii": "xn--fsqu00a.xn--g6w251d",
  "confusable_raw_values_remain_distinct": true,
  "rbac_key": "workspace_members_read_model.(workspace_id,user_id)",
  "attachment_key": "attachments.(attachment_id,stored_name)"
}
```

Fixture 會建立兩個只在 UUID 不同、display name 相同的成員，並讀回 workspace、membership、task/workspace context 與 attachment metadata。每次都使用 `:memory:`；attachment fixture 使用既有刪除路徑清理暫存實體檔，不回填 `data/dev.db`。

## 欄位分類與現行 canonical 行為

| 欄位／流程 | 顯示值 | canonical／比對鍵 | UUID／RBAC 權限鍵 | 現行轉換與限制 |
| --- | --- | --- | --- | --- |
| `users.email` | 可作登入／邀請顯示的 email | `createUser`、login、lookup 目前使用 `trim().toLowerCase()` 後的 raw 字串 | 否；使用者本身由 `users.id` 識別 | DB 是 `TEXT NOT NULL UNIQUE`，未宣告 `COLLATE`，預設為 BINARY；沒有 NFC/NFD、完整 Unicode casefold 或 IDNA/Punycode 轉換 |
| `users.name` | 是，使用者 display name | 無獨立 canonical key | 否 | 僅 trim；必填、不得為空、非 unique；NFC/NFD、confusable、bidi、joiner 都保留 |
| `attachments.original_name` | 是，下載／列表顯示檔名 | 否；不可當檔案路徑或安全識別碼 | 否 | 只取 basename、移除 CR/LF、引號、NUL 與 U+0000–U+001F、trim、最多 255 個 JS 字元；不做 NFC/NFD、casefold、confusable、bidi 或 joiner 政策 |
| `attachments.stored_name` | 否 | 磁碟實體檔的內部名稱 | 由 server 產生 UUID，並經 UUID regex + `realpath` 路徑守門 | 不採用 `original_name`；列表與下載 readback 不外洩此欄位 |
| `workspaces_read_model.name` | 是 | 無獨立 canonical key | 否 | 建立／改名只 trim、最多 200 個 JS 字元；不 unique；主協作工作區另有固定名稱規則 |
| `workspace_id` | 可在 URL／複製功能顯示 | 精確 UUID 字串 | 是，workspace read model PK、task context 與 API scope | `createWorkspace` 由 `randomUUID()` 產生；不由名稱推導 |
| `workspace_members_read_model.(workspace_id,user_id)` | `name`／`email` 是顯示資料 | 精確的 composite row key | 是，role 查詢用 `(workspace_id,user_id)` | 成員 role 由 read model 查詢；同名或 confusable display name 不會合併，也不能取代 user UUID |
| `tasks_read_model.workspace_id` | 通常不直接顯示 | 精確 workspace UUID | 是，task 的 workspace context 與權限邊界 | kanban 以 `task.workspace_id` 找 workspace；task id 與 workspace id 均不依賴名稱 |

## Unicode 與 SQLite 實測分類

- NFC/NFD：`café@example.com` 與 `cafe\u0301@example.com` 在目前資料庫可同時存在；Node 的 `normalize('NFC')` 觀察值相同，但 app 不會替它們合併。`users.name`、workspace name 與 attachment display name 也保留原始 code point。
- Latin/Cyrillic confusable：`paypal` 與含 Cyrillic `р`／`а` 的 `\u0440\u0430ypal` 在 default BINARY 比對下不同；現行程式不自動封鎖或標記 confusable。
- Bidi/joiner：U+202E 與 U+200D 在 workspace／attachment display readback 中保留。它們不會成為 `workspace_id`、`user_id` 或 `stored_name`。
- Unicode domain/IDNA：Node `domainToASCII('例子.測試')` 得到 `xn--fsqu00a.xn--g6w251d`，但 task-tracker 目前保存 `user@例子.測試` 的 lowercased raw email，不在應用層轉成 Punycode。
- SQLite collation：runtime 提供 `BINARY`、`NOCASE`、`RTRIM`；users email 欄位沒有宣告自訂 collation。預設 `A = a` 為 false，明確使用 `COLLATE NOCASE` 才對 ASCII `A/a` 為 true；這不等於完整 Unicode casefold。
- Collision：email 的 ASCII 大小寫與前後空白會先在 app canonicalization 後碰到 UNIQUE；NFC/NFD、IDNA raw/Punycode 形式、display name 或 confusable 形式目前不會因 Unicode 等價而自動碰撞。

## 前端／後端／DB 對照

目前三層使用同一組穩定欄位，但職責分開：

- 後端與 DB 以 `workspace_id`、`user_id`、`task_id`、`attachment_id` 做查詢、URL scope、membership role 與 task context；display `name`、`email`、`original_name` 只作輸出內容。
- `public/js/views/workspaces.js` 用 `row.workspace_id` 設定目前 workspace、建立 route 與複製 ID，用 `row.name` 顯示名稱。
- `public/js/views/members.js` 用 `m.user_id` 組 PATCH/DELETE 路徑，以 `m.name`／`m.email` 顯示；不以 display name 送權限操作。
- `public/js/views/kanban.js` 用 `task.workspace_id` 對 workspace、用 `member.user_id` 建 display map；`public/js/views/task-detail.js` 用 `c.user_id` 找作者、用 `a.original_name` 顯示附件，不需要 `stored_name`。
- fixture 驗證的 member 欄位 allowlist 是 `user_id、role、joined_at、email、name`；attachment list allowlist 是 `attachment_id、task_id、original_name、mime_type、size`，download readback 是 `data、mime、originalName`。因此 DB 內部 `password_hash`、磁碟 `stored_name` 不應進入這些 UI/API readback。

這份 baseline 不回填歷史資料、不改寫既有多語 display value、不自動封鎖 confusable，也不抽出跨 repo 共用 library。若未來要改 canonical policy，應另開明確決策與 migration／collision 盤點，不把本 fixture 的觀察值當成新政策。
