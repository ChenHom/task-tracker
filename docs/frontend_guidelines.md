# 前端開發規範 (Frontend Development Guidelines)

為了保持本專案（Task Tracker）前端程式碼的維護性、可讀性、安全性與符合 SOLID 原則，特制定以下前端開發規範。本專案前端堅持**不引入打包工具（如 Vite, Webpack）與現代重型框架**，完全基於瀏覽器**原生 ES Modules (ESM)** 進行開發。

---

## 1. 模組職責劃分 (SRP & SOLID 原則)

前端的目錄結構如下，每一類型的檔案應有明確且單一的職責：

```
public/
├── index.html                  # 靜態骨架，載入 css/global.css 與 app.js
├── style.css                   # 全域樣式 (回溯相容，僅以 @import 載入 css/global.css)
├── css/                        # 分拆的視圖樣式目錄
│   ├── global.css              # 基礎設計系統、全域重置、版面與全域 UI 元件
│   ├── login.css               # 登入與權限頁面樣式
│   ├── workspaces.css          # 工作區頁面樣式
│   ├── kanban.css              # 看板與卡片樣式
│   ├── task-detail.css         # 工作細節彈窗樣式
│   ├── members.css             # 成員管理頁面樣式
│   └── audit.css               # 審計日誌頁面樣式
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
- **`api.js`**：所有網路請求必須使用封裝後的 `api()` 函式，並支援 `AbortSignal` 來實現連線中斷。
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
- **新粗獷主義 (Neo-brutalism) 設計規範**：為配合本專案新版潮流美學：
  - 邊框與文字均採用純黑色 (`#000000`) 實線，容器、卡片與按鈕邊框寬度固定為 **`2px`**。
  - 捨棄模糊投影，改用扁平無模糊的黑體偏移投影 (`box-shadow: 4px 4px 0px 0px #000`)。
  - 按鈕在 Hover/Active 時，透過 `transform: translate` 位移並抵消陰影，呈現極富機械感的實體按壓回饋。
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
- **樣式與排版**：專案採「**樣式檔案切分** + **靜態全部載入** + **Nginx 傳輸壓縮 (Gzip/Brotli)**」架構。分拆後的樣式檔直接在 `index.html` 中靜態加載（無任何 JS 控制，避免閃爍或轉場 Bug），並在反向代理伺服器（Nginx）層啟用 Gzip 或 Brotli 壓縮，確保檔案大小能在一次 TCP 封包（< 14.6 KB）內極速送達。遵守以下 **CSS/Style 建立原則**：
  - **拒絕 JS 行內靜態樣式**：所有靜態的外觀（如外距、內距、邊框、陰影、背景色、字型等）**嚴禁**使用 JavaScript 行內 `style` 屬性設定。必須在對應的 CSS 檔中定義對應的 Class，並在 JavaScript 中透過 `class` 屬性或 `classList` 套用。
  - **動態樣式例外原則**：僅在需要根據運行時變數（Runtime variables）動態計算數值時，才允許使用 JS 行內 `style`，例如：滑鼠點擊座標（`e.pageX`, `e.pageY`）的絕對定位、拖拽位移值，或輸入框高度自適應（`scrollHeight` 計算）等。
  - **排版排佈優先級**：在元件中若需做動態排版調整，優先使用 flexbox/grid 或動態 toggle class。

---

## 6. 記憶體洩漏與事件監聽清理 (Event Listener Cleanups)

由於本專案為單頁式應用程式 (SPA)，頁面視圖會被反覆切換並掛載到同一個容器 DOM 節點上：
- **自我清理生命週期 (Self-Cleaning Lifecycle)**：凡是在全域（`window` 或 `document`）註冊監聽器，或是建立手動掛載於 `body` 下的浮動元件（如 Modal）時，**必須**註冊一個 `hashchange` 監聽器。當偵測到路由改變且不再匹配該視圖時，主動調用清理函數，卸載所有相關的事件監聽器（如 `removeEventListener`），以絕後患。
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
- **錯誤呈現與提示標籤**：
  - 網路請求失敗時，利用 `showError` 呈現錯誤訊息給使用者。
  - 當視窗或表單存在「未存檔變更」而觸發關閉或取消動作時，**不使用**瀏覽器阻斷式 Prompt（如 `confirm`），而是利用 UI 左側滑出的**新粗獷主義風格「還未」提示標籤**，並搭配關閉按鈕震動（`shake-anim`），在使用者聚焦回輸入框時再自動向右滑入下層收合，以求最流暢的非阻斷式使用者體驗。
  - **儲存狀態轉場規範**：在任務描述輸入框按下 `Enter` 鍵觸發儲存時，需進行多狀態非同步動畫編排：
    1. **按鈕禁用與失焦**：開始儲存時，描述輸入框必須失去焦點 (`blur`)，且儲存按鈕設為 `disabled` 狀態以防二次重入。
    2. **「等待」狀態**：提示標籤文字更換為「等待」並滑出，並使用計時器確保該滑出動畫至少執行完成（400ms）。
    3. **「完成」狀態**：儲存成功後，先收回「等待」提示框，再將文字更新為「完成」並再次滑出顯示。
    4. **「還未」重置**：完成的提示框在名稱或描述框重新取得焦點（`focus`）時，立刻滑入收回，並在動畫收回後（延遲 300ms）才將文字重置為「還未」，以確保不會有文字在可見狀態下發生突兀閃爍。

---

## 10. 事件委派 (Event Delegation)

當渲染長列表（如任務卡片、歷史日誌）時：
- **避免個別綁定**：嚴禁對列表中的每一個子節點分別綁定 click 事件監聽器。這會消耗大量記憶體。
- **推薦做法**：應將事件監聽器綁定在列表的**父容器**上，透過檢查 `event.target`（可利用原生 `.closest(selector)`）來定位點擊的具體元素。

---

## 11. 前端代碼風格與自動化校驗規範 (Code Style & Linting Verification)

為保證所有開發人員提交的前端程式碼品質與樣式規範一致性：
- **靜態樣式強制要求**：嚴禁在 JavaScript 程式碼中以 `style: '...'` 物件字面值或 `element.style = '...'` 等形式寫入硬編碼（寫死）的靜態樣式字串。所有靜態樣式必須集中定義在 CSS 樣式表中。
- **動態樣式例外原則**：只有與執行期狀態強烈相關的動態樣式（如隨滑鼠指針變化的浮動座標 `left: ${x}px` 或拖曳高度等），才允許在 JavaScript 中使用模板字面值或變數進行動態賦值。
- **測試前置校驗 (Pre-Test Linting)**：
  - 專案已配置 ESLint 工具，並加入自訂 AST 選擇器規則，自動檢測上述靜態樣式違規。
  - 在執行單元測試 `npm test` 時，會**優先且自動強制執行** ESLint 代碼風格檢測。如果 ESLint 驗證失敗，測試流程將會立即被阻斷中斷（Exit Code: 1），不允許執行後續的測試。
