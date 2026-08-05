# WCAG 2.2 核心 journey 可及性受限試點（第一輪：登入 → 搜尋／開啟任務 → 留言）

> **狀態說明：** 第一輪只涵蓋單一核心 journey：登入 → 搜尋或從看板開啟任務 → 閱讀／新增留言。不宣稱全站 WCAG 2.2 conformance，也不包含手機側欄、Members、Audit Log、Workspaces 管理等其他頁面。
>
> **重要邊界（環境限制）：** 本輪**沒有**執行即時瀏覽器操作、螢幕閱讀器播報或 200% 縮放／reflow 的人工測試——這個 session 的操作規則明確要求不對 `localhost:3000` 做 live 驗收（分支上的程式碼變更不代表目前跑在該連接埠上的服務就是這份改動）。以下「自動掃描」是指對 `public/js`／`public/index.html` 做的**源碼靜態掃描**（grep `label`／`for`／`aria-*`／`role`／`tabindex`／`.focus()`／`inert`／`document.title`），不是 axe-core 之類的工具報告（`package.json` 目前沒有裝任何 a11y 掃描套件，也沒有為此新增依賴）；「人工」部分則是逐行讀事件監聽器與 DOM 結構去推論鍵盤可達性與焦點行為，不是實際按鍵記錄。這一層落差如實記在下方，之後要補足需要在能做 live 驗收的環境（例如合併部署後）另外安排一輪。

---

## 1. 登入（`public/js/views/login.js`）

**源碼掃描發現並已修正：**

- `<label>電子信箱 (Email)</label>` / `<label>密碼 (Password)</label>` 原本與對應 `<input>` 是同層兄弟節點，沒有 `for`/`id` 關聯——螢幕閱讀器聚焦到輸入框時不會唸出欄位名稱（WCAG 1.3.1 / 3.3.2 / 4.1.2）。已加上 `for="login-email"`、`for="login-password"`。
- `#login-error`（登入失敗訊息）原本是純 `<p>`，JS 只切換 `textContent` 與 `display`，沒有任何播報機制，螢幕閱讀器使用者送出錯誤密碼後不會被通知（WCAG 4.1.3 Status Messages）。已加上 `role="alert"`。

**回歸鎖定：** `src/frontendViews.test.ts` 的 Login 測試區塊新增斷言，鎖住 `for="login-email"`／`for="login-password"`／`role="alert"` 這三個屬性字串。

## 2. 搜尋（`public/js/views/search.js`）

**源碼掃描發現並已修正：**

- `#search-input` 只有 `placeholder`、沒有任何 `<label>`／`aria-label`——placeholder 不是可靠的欄位名稱來源（打字後消失、部分輔具不讀取），屬已知反樣式（WCAG 3.3.2）。已加上 `aria-label="搜尋關鍵字"`。
- `#search-error` 與登入頁同樣的問題（無播報機制）。已加上 `role="alert"`。

**未變更、已是合格樣式：** `#search-include-archived` checkbox 是 `<label><input ...> 顯示已歸檔</label>` 的隱式包裹寫法，本身就有效的 label 關聯，不需要改。

**回歸鎖定：** `src/frontendViews.test.ts` 的 Search 測試區塊新增斷言，鎖住 `aria-label="搜尋關鍵字"`／`role="alert"`。

## 3. 開啟任務 Modal（`public/js/views/task-detail.js`）

**源碼掃描發現並已修正：**

- Modal 的 `.modal-container` 原本沒有 `role="dialog"`／`aria-modal="true"`／任何 `aria-label`，螢幕閱讀器不會把它識別成對話框，也不知道背景看板已被視覺遮蔽。已加上 `role="dialog"`、`aria-modal="true"`、`aria-label` 帶目前任務標題。
- 關閉鈕文字內容是單一字元 `×`，沒有 `aria-label`，可及名稱不明確（多數輔具會唸成「乘號」或忽略）。已加上 `aria-label="關閉"`。
- Modal 開啟時（`document.body.appendChild(overlay)` 之後）**沒有**把焦點移入 modal——鍵盤使用者透過 Enter 開啟任務後，焦點仍停在背景已被視覺遮蔽的元素上（背景也沒有 `inert`／`aria-hidden`，Tab 順序因此會漏到看板其餘元素）。已在 append 後呼叫 `closeBtn.focus()`。
- 留言輸入框 `commInput`（`class="comment-textarea"`）只有 `placeholder`，同第 2 節的反樣式。已加上 `aria-label="留言內容"`。

**已確認沒問題：** Escape 關閉（`escHandler`，task-detail.js:209-214）、`hashchange` 時清理監聽器、任務標題輸入框／描述欄位都已有對應 `<label>`——這幾項讀 code 判斷邏輯正確，鍵盤可操作。

**回歸鎖定：** `src/frontend.test.ts` 既有的 modal 渲染測試區塊（Test 4）新增斷言，鎖住 `role="dialog"`／`aria-modal="true"`／`aria-label`（任務標題）／關閉鈕 `aria-label="關閉"`／留言框 `aria-label="留言內容"`。

## 4. 已知落差（非本輪修復範圍，記錄供後續判斷）

- **`public/js/views/kanban.js:557-636`：** 卡片左上角的「開啟／分享／複製 id」快捷選單，只能透過滑鼠座標命中 `::before` 偽元素觸發（`e.clientX`/`e.clientY` 範圍判斷），完全沒有鍵盤等價操作（WCAG 2.1.1 Keyboard）。核心 journey 本身不受影響——任務標題本身是可鍵盤操作的 `<a href="#/task/:id">` 連結——但「分享」「複製 id」這兩個附加功能鍵盤使用者完全用不到。修法需要新增一個真正可聚焦的觸發元素（UI 變更），範圍超出本輪單一 journey 的屬性層修補，留給下一輪。
- **`public/js/router.js`：** 全站每次路由切換都不會更新 `document.title`（整站掃描 `document.title` 零命中），也不會把焦點移入新渲染的內容或用 live region 宣告頁面變化（WCAG 2.4.2 / 2.4.3 在 SPA 情境下的對應要求）。這是所有路由共用的 `route()` 函式，修正會影響全站每個頁面，不符合「只修單一核心 journey」的範圍限制，記錄供下一輪評估。
- **即時人工驗證（鍵盤全流程實測、螢幕閱讀器播報、200% 縮放／reflow、自動掃描工具報告）：** 本輪環境限制不做 live 驗收，未執行，見文首邊界說明。

## 5. 驗證證據

```
npx tsc --noEmit                     # 乾淨
npx eslint public/js/views/login.js public/js/views/task-detail.js public/js/views/search.js   # 乾淨
npx tsx src/frontendViews.test.ts    # OK（含本輪新增的 login/search 屬性回歸斷言）
npx tsx src/frontend.test.ts         # OK（含本輪新增的 modal dialog/焦點屬性回歸斷言）
npx tsx src/comment.test.ts          # OK（既有留言相關測試，確認無迴歸）
```
