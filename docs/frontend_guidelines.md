# 前端開發規範 (Frontend Development Guidelines)

為了保持本專案（Task Tracker）前端程式碼的維護性、可讀性、安全性與符合 SOLID 原則，特制定以下前端開發規範。本專案前端堅持**不引入打包工具（如 Vite, Webpack）與現代重型框架**，完全基於瀏覽器**原生 ES Modules (ESM)** 進行開發。

---

## 1. 模組職責劃分 (SRP & SOLID 原則)

前端的目錄結構如下，每一類型的檔案應有明確且單一的職責：

```
public/
├── index.html                  # 靜態骨架，僅透過 type="module" 載入 app.js
├── style.css                   # 全域樣式
├── app.js                      # 應用程式啟動進入點（Bootstrap）
└── js/
    ├── api.js                  # 網路請求層 (API Client)
    ├── state.js                # 全域狀態與常數儲存庫 (State Store)
    ├── utils.js                # 通用工具與 DOM 生成輔助器
    ├── router.js               # 路由引擎 (Router Engine)
    ├── routes.js               # 路由與 View 的註冊設定
    └── views/                  # 獨立視圖元件目錄
        ├── login.js
        ├── kanban.js
        └── ...
```

### 規範細則：
- **`state.js`**：禁止直接操作 DOM。全域狀態的變更（如登入資訊、當前工作區）應封裝在 `state` 物件中，並利用 Getter/Setter 來處理持久化（如 `sessionStorage`）。
- **`api.js`**：所有網路請求必須使用封裝後的 `api()` 函式，禁止直接調用原生 `fetch`。
- **`router.js` 與 `routes.js`**：路由核心邏輯（解析 Hash、觸發渲染）與路由映射配置（哪個路徑對應哪個 View）必須分離，實現**開放/封閉原則 (OCP)**。
- **`views/`**：每個 View 都是一個獨立的模組，應實現統一的生命週期介面，並以參數或依賴注入的形式接收外部資料。

---

## 2. 視圖元件契約 (View Module Interface)

所有的 View 元件都必須遵循相同的介面結構（**Liskov 代換原則 LSP**），確保能被路由器統一調度與渲染：

```javascript
export const ExampleView = {
  /**
   * 渲染視圖入口
   * @param {HTMLElement} container - 視圖掛載的 DOM 容器
   * @param {string[]} [restParams] - 路由的動態 Path 參數（如 ID）
   * @param {URLSearchParams} [queryParams] - URL 中的 Query 參數
   * @returns {Promise<void>|void}
   */
  async render(container, restParams, queryParams) {
    // 1. 初始化 DOM 靜態骨架
    container.innerHTML = `...`;
    
    // 2. 異步載入資料
    // 3. 安全渲染動態內容
    // 4. 綁定事件監聽器
  }
};
```

---

## 3. DOM 安全渲染與 XSS 防範 (OWASP 安全規範)

防範跨站腳本攻擊 (XSS) 是本專案的核心安全要求，所有視圖渲染必須遵守以下規範：

- **靜態骨架**：只有無變數插值的純靜態 HTML 結構才可以使用 `innerHTML`。
- **動態內容**：所有來自使用者輸入（例如任務名稱、描述、留言內容、使用者郵件）的動態內容，**絕對禁止**以字串拼接後寫入 `innerHTML`。
- **DOM 輔助器**：必須使用 `public/js/utils.js` 中的 `el()` 產生器，並利用內部的 `textContent` 安全地寫入值：
  ```javascript
  // 推薦做法
  const titleLink = el('a', { href: `#/task/${task.task_id}` }, task.title); // 安全
  ```
- **附件下載安全**：所有使用者上傳的附件，前端在開啟時一律引導「下載」而非 `<iframe>` 內嵌渲染，搭配後端發送的 `X-Content-Type-Options: nosniff` 響應頭。

---

## 4. JSDoc 規範

為彌補 Vanilla JS 沒有靜態型別檢查的缺點，所有導出的模組、方法與複雜物件，都必須補上清晰的 JSDoc：

- **函式與方法**：必須標明參數型別（如 `{HTMLElement}`）、傳回值（如 `{Promise<void>}`），若是異步函式必須使用 `async` 標記。
- **物件屬性**：使用 `@typedef` 與 `@property` 宣告複雜物件的屬性結構，便於 IDE 進行代碼補全與提示。

JSDoc 範例：
```javascript
/**
 * @typedef {Object} MemberInfo
 * @property {string} user_id - 使用者唯一識別碼
 * @property {string} email - 電子信箱
 * @property {string} role - 成員角色 (Viewer/Member/Admin/Owner)
 */

/**
 * 載入指定工作區的成員列表
 * @param {string} workspaceId - 工作區 UUID
 * @returns {Promise<MemberInfo[]>}
 */
export async function fetchMembers(workspaceId) {
  return await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/members`);
}
```

---

## 5. 前端相容性與開發邊界

- **零建置工具鏈**：禁止引入任何需要打包（Webpack, Rollup, Vite）的 Node 工具，專案必須拉起 Node 伺服器後即可用瀏覽器直接除錯。
- **原生 API 優先**：優先使用 modern 原生 Web API（如 `fetch`、`URLSearchParams`、`DOMParser`、`location.hash`）。
- **樣式與排版**：使用專案既有的 `style.css` (包含 sketch 風格定義)，在元件中若需做動態排版調整，優先使用 flexbox/grid 或動態 toggle class，避免將大量 CSS style 硬編碼在 JavaScript 程式碼中。

---

## 6. 記憶體洩漏與事件監聽清理 (Event Listener Cleanups)

由於本專案為單頁式應用程式 (SPA)，頁面視圖會被反覆切換並掛載到同一個容器 DOM 節點上：
- **全域監聽器清理**：凡是在 `window`、`document`、或掛載容器之外的 DOM 節點上註冊的事件（例如 `window.addEventListener('scroll', ...)`、對鍵盤事件 `keydown` 的 Escape 鍵監聽等），**必須**在該視圖被銷毀（或 Modal 被關閉）時執行 `removeEventListener` 清理，避免造成累積性的記憶體洩漏與背景指令衝突。
- **定時器與輪詢清理**：視圖內若調用了 `setTimeout` 或 `setInterval`，在視圖切換前必須將其 `clearTimeout` 或 `clearInterval`。

---

## 7. 異步競態條件防護 (Handling API Race Conditions)

在 SPA 系統中，使用者頻繁切換路由或快速觸發搜索，容易引發「異步競態問題」（先發送的請求較晚返回，覆蓋了新頁面的渲染結果）：
- **防護策略**：
  - 在發起新的搜索或請求前，若上一次請求尚未結束，應使用 `AbortController` 取消先前的請求。
  - 或者在渲染回調中，驗證當前的 route/state 狀態是否依然與請求發起時一致，不一致則丟棄回傳結果。

---

## 8. 狀態更新與視圖渲染同步模式

缺乏前端雙向綁定框架支援時，狀態變更容易與 UI 脫節：
- **資料流原則**：堅持「**單向資料流，狀態驅動視圖**」模式。
- **渲染規範**：變更資料狀態（例如在資料庫中更新任務狀態）後，優先調用集中式的資料加載與渲染方法（如 `loadAllData()`），由最新狀態重新生成 DOM，避免零散地以手動 ad-hoc 方式個別修改 DOM 節點（容易造成畫面與底層資料狀態不一致的 Bug）。

---

## 9. 統一的異常處理與加載狀態 (Loading & Error States)

為提供良好的使用者體驗與確保程式健壯性：
- **異步攔截**：視圖中所有 API 呼叫必須包裹於 `try...catch` 區塊中。
- **加載提示**：在進行網路請求期間，DOM 容器應先顯示「載入中... (Loading...)」的佔位狀態，防止使用者重複點擊或誤以為介面卡死。
- **錯誤呈現**：若請求失敗，須利用 `showError` 呈現錯誤訊息給使用者，切忌在 console 無聲報錯（Silent Failure）導致頁面殘缺。

---

## 10. 事件委派 (Event Delegation)

當渲染長列表（如任務卡片、歷史日誌）時：
- **避免個別綁定**：嚴禁對列表中的每一個子節點分別綁定 click 事件監聽器。這會消耗大量記憶體。
- **推薦做法**：應將事件監聽器綁定在列表的**父容器**上，透過檢查 `event.target`（可利用原生 `.closest(selector)`）來定位點擊的具體元素。
