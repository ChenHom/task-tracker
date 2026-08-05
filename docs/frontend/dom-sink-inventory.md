# DOM sink 清冊與 CSP report-only 驗證基線（第一輪：task-detail 富文字、附件下載）

> **狀態說明：** 第一輪只盤點 task-detail 富文字渲染（描述／留言）與附件下載兩條具使用者輸入／跨成員邊界的流程，並在既有 HTTP 回應上加了一支 `Content-Security-Policy-Report-Only`（不 enforce）。純 React demo 與 tw-day-trading 不在本輪範圍。
>
> **重要邊界：** CSP report-only 不擋任何請求，只用來觀察相容性；零違規不代表沒有 XSS，也不能取代下方列出的既有 MIME／filename／權限驗證。這份清冊是「目前已有什麼防線」的盤點，不是新增防線的宣告。

---

## 1. task-detail 富文字渲染（描述／留言）

**來源：** `GET /api/tasks/:id`（description）與 `GET /api/tasks/:id/comments`（content）。兩者都是任意成員可寫入的自由文字，伺服器端（`src/task.ts`、`src/comment.ts`）**不做任何 HTML escape 或淨化**，原樣存取、原樣回傳——`src/comment.test.ts` 已補一條合成 fixture（`<script>...</script><img ... onerror=...>`）鎖定這個邊界，避免日後誤以為伺服器已處理過而在前端改用 `innerHTML`。

**Sink：** `public/js/views/task-detail.js` 的 `renderRichText()`，經 `public/js/utils.js` 的 `el()`：

- `el()` 對文字一律用 `node.textContent = text`（`public/js/utils.js:86`），不曾使用 `innerHTML`／`insertAdjacentHTML`。整支 `task-detail.js` 檔案內沒有任何 `innerHTML` 出現。
- `renderRichText()` 用正則切出四種可解析片段：`https?://` URL、`@mention`、`#N` 留言連結、`::hex` task 連結；其餘一律 `document.createTextNode(part)` 當純文字。
- URL 片段的正則是 `[^\s<>"']+`——刻意排除 `<`、`>`、`"`、`'`，即使攻擊者把 payload 接在合法 URL 後面（如 `https://evil.com/"><script>...`），比對也會在 `"` 處提前截斷，剩餘字串仍落回純文字節點，不會被解析成標籤或跳脫屬性 context。
- `safeHttpUrl()`（`task-detail.js:1193`）只放行 `http:`／`https:` protocol，`javascript:` 等偽協議一律回 `null` 並整段以文字顯示，不會生出可點擊連結。
- `@mention` 的顯示名稱（`member.name`）是**其他成員可自訂、可被冒充/惡意設定的欄位**：即使某成員把顯示名稱設成 `<img src=x onerror=...>`，仍會經 `el('span', {...}, '@'+name)` 用 `textContent` 顯示，不會產生子元素——`src/frontend.test.ts` 已補這條跨帳號合成 fixture。

**既有防線小結：** 全鏈路都是 `textContent`／`setAttribute`，沒有任何 innerHTML sink；URL 走 protocol allowlist；不受信任內容（描述／留言／顯示名稱）都只會落成文字節點或走 allowlist 過的屬性。目前找不到需要修的洞，這輪的產出是把這個結論用可重跑的合成字元測試釘住。

**已知落差（非本輪修復範圍，記錄供後續判斷）：**

- 站上其餘 view（`kanban.js`、`members.js`、`workspaces.js`、`login.js`、`search.js`、`audit.js`、`notifications.js` 等）仍有多處 `container.innerHTML = \`...\`` 用法，但目前掃過的用法都是**固定模板字串**，沒有直接內插使用者輸入；未逐檔逐行覆核，下一輪若要擴大範圍應從這些檔案開始。

---

## 2. 附件下載

**來源：** `POST /api/tasks/:id/attachments`，`declaredMime` 來自 client 的 `Content-Type` header（不可信），`originalName` 來自 `X-Filename` header（不可信），檔案內容為任意 bytes。

**既有防線（`src/attachment.ts`）：**

- **MIME 白名單 + magic bytes**（`attachment.ts:23`）：宣告的 `Content-Type` 必須落在白名單（png/jpeg/gif/pdf/text-plain），且檔案開頭 bytes 需與宣告型別的 magic number 相符，兩者缺一都拒絕（`validateMime`）。
- **檔名淨化**（`sanitizeFilename`，`attachment.ts:41`）：只取 basename、剝除 CR/LF/引號/控制字元（`\x00-\x1f`），長度上限 255。**絕不當磁碟路徑**——磁碟檔名另外用 `randomUUID()`（`stored_name`），`original_name` 只存 DB 供顯示。
- **symlink 守門**（`resolveInside`，`attachment.ts:50`）：`stored_name` 必須是合法 UUID，`realpathSync` 解出真實路徑後仍須落在附件目錄內，防止字串比對擋不住的 symlink 逃逸。

**Sink：** `GET /api/attachments/:id`（`src/server.ts` 附件下載 handler）的回應 headers：

- `X-Content-Type-Options: nosniff`：防止瀏覽器忽略宣告的 MIME、用內容嗅探把附件當 HTML/腳本執行。
- `Content-Disposition: attachment; filename*=UTF-8''<percent-encoded>`：強制瀏覽器走下載而非行內渲染；檔名透過新抽出的 `contentDispositionHeader()`（`attachment.ts`）用 `encodeURIComponent` 編碼，即使 `sanitizeFilename` 這層意外漏放什麼字元，`encodeURIComponent` 是第二層防線，兩層都不信任單獨足夠。
- 前端 `public/js/views/task-detail.js` 的下載連結一律走 `<a href="api/attachments/:id" target="_blank" rel="noopener noreferrer" download="...">`（`task-detail.js:898`），不會把附件內容內嵌進頁面 DOM。

**合成字元 fixture（`src/attachment.test.ts`，可重跑）：**

- 檔名含 CRLF + 假 header 注入字串（`evil\r\nSet-Cookie: x=1\r\n"quote".png`）：驗證存檔後 `original_name` 不含 `\r`/`\n`/`"`，且 `contentDispositionHeader()` 產出的值同樣不含原始 CRLF。
- 超長 unicode 檔名（emoji + 中文重複超過 255 字元）：驗證長度上限仍生效、header 建構不出錯。

---

## 3. CSP report-only 基線

**現況（第一輪前）：** repo 完全沒有 `Content-Security-Policy` 相關 header。

**這輪做了什麼：** 在 `src/server.ts` 對所有 `.html` 靜態回應（目前唯一入口是 `public/index.html`）加上 `Content-Security-Policy-Report-Only`，並新增 `POST /api/csp-report` 收集端點；JSON API 回應不帶這個 header（沒有意義）。

Policy（`CSP_REPORT_ONLY_POLICY`，`src/server.ts`）：

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self';
object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none';
report-uri /api/csp-report
```

**相容性判斷依據（源碼盤點，非正式環境即時觀測）：**

- **`script-src 'self'` 應與現有同源 ESM 相容：** `public/index.html` 只有一個 `<script type="module" src="app.js">`（`index.html:60`），沒有 inline `<script>`、沒有 `eval()`／`new Function()`（已用 `Grep` 掃過整個 `public/`）。
- **`style-src` 需要 `'unsafe-inline'`，這是已知、刻意放寬的落差：** `public/js/utils.js` 的 `el()` 對非 `onclick/onchange/onsubmit` 的 attrs 一律 `setAttribute`，多處呼叫（例如 `task-detail.js` 的 reply 選單定位）會傳入 `style: "left: ...; top: ..."`；`public/index.html` 本身也有多處 `style="display:none"` 靜態屬性。嚴格 `style-src 'self'`（不含 unsafe-inline）會讓這些既有寫法在 enforce 模式下失效——這不是本輪要改的前端行為，先如實放寬並記錄，之後若要收緊，要先把這些內聯 style 改成 class。
- **`style-src`／`font-src` 需要放行 Google Fonts：** `public/css/global.css:1` 有 `@import url('https://fonts.googleapis.com/...')`，字型檔實際由 `fonts.gstatic.com` 提供。這是嚴格 `'self'` 政策會直接擋下的外部資源，已在 policy 中明確 allowlist，而非放寬成 `unsafe-inline` 或萬用字元。
- **`connect-src 'self'`：** 所有前端 API 呼叫（`public/js/api.js`）都打相對路徑（同源），沒有找到跨源 `fetch`／`XMLHttpRequest`。

**report 收集端點（`recordCspReport` / `getCspReportSummary`，`src/server.ts`）：**

- 只保留 `violated-directive`（或新版 Reporting API 的 `effective-directive`）並依此彙總計數；**不記錄** `blocked-uri`、`document-uri`、`source-file`、`script-sample` 等可能洩漏使用者瀏覽頁面／內容的欄位。
- 無法解析的 report body（非 JSON、缺欄位）一律回 `204`，不記錄原始內容、不丟未捕捉例外。
- 測試證據見 `src/server.test.ts`：驗證 HTML 回應帶 report-only header（且**不是** enforce 的 `Content-Security-Policy`）、JSON API 不帶該 header、report 端點正確彙總 directive 且不記錄敏感欄位、損毀 body 不會讓伺服器噴例外。

**尚未做、下一輪才需要處理：**

- 尚未在正式部署環境實際載入頁面、蒐集真實瀏覽器回報的 report-only 違規（本輪只做源碼層面的相容性推導；`localhost:3000` 的 live 行為以合併部署後 owner 巡檢為準）。
- 尚未評估把 `style-src` 收斂到不含 `unsafe-inline`（需要先把動態內聯 style 改寫成 class，屬於前端行為變更，不在本輪範圍）。
- 尚未切到 enforce 模式或加 Trusted Types——這兩者都明確排除在本輪外。
