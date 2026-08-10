# @mention 與通知 API 前端整合指南

> **狀態說明：** 這份文件以目前可驗證的前端 UI 與 `docs/api.md` 的 Notifications 章節，以及現行 `/api/notifications` HTTP 回應為準。`@` 的輸入補全與渲染仍由前端處理；通知收件夾則是拉取式 API。

**適用範圍：** task 詳情頁的留言編輯器、留言渲染器，以及通知收件夾 UI。

**核心原則：**

- `@` 的輸入補全與 `@` 的顯示渲染是兩件事，前端已經有補全與 rich text 呈現。
- 通知收件夾只做拉取式 API，不假設 WebSocket / push。
- `read_at = null` 一律視為未讀，前端只依這個欄位決定 badge 與未讀樣式。
- 目前可觀察到的行為是：同一則留言內重複提及同一人只會產生一筆通知；不同留言各自都會建立通知，不會因為該收件者還有未讀通知就自動合併。

---

## 1. 目前 repo 內已存在的 mention 行為

`public/js/views/task-detail.js` 已經做了兩層處理：

- 輸入時在留言與描述編輯器中提供 `@` 建議清單。
- 顯示時把合法的 `@Name` 或 `@email` 渲染成 `.rich-mention`。

目前的實際規則是：

- 建議清單會比對成員名稱與 Email。
- 渲染器會把合法的 `@Name` 或 `@email` 轉成 `.rich-mention`。
- 找不到對應成員時，`@` 保持原字串顯示。
- task description 內的 `@` 只做 UI 顯示，不會自動產生通知。

這表示前端可以放心把 `@` 當作 UI 互動能力，但不要把它誤解成任何地方都會觸發通知。

---

## 2. 通知 API 契約

### 2.1 GET `/api/notifications`

用途：取得目前登入者的通知列表。

請求條件：

- 需要登入。
- 只回傳目前登入使用者自己的通知。
- 未登入時回 `401 {"error":"未登入"}`。
- 可帶 `filter=all|unread|read`，預設為 `all`。`all` 包含未讀與已讀未滿 10 天的通知；`unread` 只回未讀；`read` 只回已讀未滿 10 天的通知。
- 已讀通知從 `read_at` 起連續滿 10 個 24 小時（含剛好 10 天）後由 server 隱藏，不刪除資料；未讀通知不因時間隱藏。

回傳資料：

```json
[
  {
    "notification_id": "92083ff0-22d8-41be-964a-9d3745a87239",
    "recipient_id": "3d279551-487b-4488-9893-75fb36e34e69",
    "source_task_id": "8be538bc-ffc6-4122-9757-026a54ba813f",
    "source_comment_id": "d79b5f57-2753-49b7-98d8-e8148d8865e8",
    "snippet": "讀完後再提醒一次 @婷婷",
    "created_at": "2026-07-13T10:19:02.488Z",
    "read_at": null
  }
]
```

欄位定義：

- `notification_id`：通知唯一 ID。
- `recipient_id`：收件者 user ID。
- `source_task_id`：來源 task ID。
- `source_comment_id`：來源 comment ID。現行回應是字串，不是 `null`。
- `snippet`：前端顯示用摘要。
- `created_at`：建立時間，UTC ISO 字串。
- `read_at`：已讀時間；`null` 表示未讀。

排序規則：

- 未讀項目在前。
- 同狀態內再依 `created_at` 由新到舊。

前端使用方式：

- badge 數量 = `read_at === null` 的筆數。
- 清單卡片可直接用 `snippet` 做預覽。
- 若 `read_at === null`，顯示未讀樣式。
- 點擊通知後，先導向 `source_task_id` 對應的 task，再呼叫標記已讀。
- 若要做 comment 深連結，可再用 `source_comment_id` 定位留言錨點。

### 2.1a GET `/api/notifications?page=N&pageSize=M&filter=all|unread|read`（opt-in 分頁）

用途：通知頁（收件夾 UI）用傳統頁碼瀏覽通知，避免一次拉全部。

請求條件：

- 需要登入，其餘同 2.1。
- 分頁是 opt-in：只要帶 `page` 參數就會回傳分頁格式；不帶 `page` 時走 2.1 既有的 array 回應與排序，不受影響。
- `page` 必填（在有帶分頁參數的前提下）；`pageSize` 選填，預設 15，上限 100。
- `page`／`pageSize` 必須是正整數；不合法格式（非數字、0、負數、小數）回 `400 {"error":"page 參數不合法"}` 或 `400 {"error":"pageSize 參數不合法"}`。
- `filter` 只能是 `all`、`unread` 或 `read`，不合法回 `400 {"error":"filter 參數不合法"}`。
- `page` 超過目前總頁數回 `400 {"error":"page 超出範圍"}`；前端應以 UI（disable 超界的頁碼按鈕）避免發出這種請求，遇到仍可退回第 1 頁重試。

回傳資料：

```json
{
  "items": [ /* 同 2.1 的 NotificationRow 陣列 */ ],
  "page": 1,
  "pageSize": 15,
  "totalCount": 37,
  "totalPages": 3,
  "unreadTotal": 5
}
```

- `items` 排序固定為 `created_at DESC`、`notification_id DESC` 作穩定次排序（分頁情境下不採 2.1 的「未讀優先」排序，避免標記已讀把項目移到清單後段、造成分頁跳動）。
- `totalCount`／`totalPages` 是套用 filter 與已讀 10 天隱藏規則後的結果；`unreadTotal` 是這個使用者「全體」未讀數（不受目前 filter／頁面限制），前端 badge 應以此欄位為準，不要用 `items` 內未讀筆數估算。
- 通知頁提供「全部／未讀／已讀」篩選與 10／15 筆原生選單；切換 filter 會從第 1 頁重新查詢，空結果顯示空狀態。
- 目前的通知頁（`public/js/views/notifications.js`）提供 10／15 筆原生選單切換：無已保存偏好時手機預設 10、桌面預設 15，切換後存入 `localStorage`（key `notif-page-size`）並優先套用。

### 2.2 POST `/api/notifications/:id/read`

用途：把單一通知標記為已讀。

請求條件：

- 需要登入。
- 只能標記自己的通知。
- 未登入時回 `401 {"error":"未登入"}`。

回傳資料：

```json
{ "ok": true }
```

行為約定：

- 重複呼叫必須是 idempotent。
- 如果通知已經有 `read_at`，再次呼叫仍回成功。
- 若通知不存在，或不屬於目前登入者，會回 `400 {"error":"notification 不存在"}`。
- 前端不要根據錯誤訊息推測其他使用者資料。

---

## 3. 端到端流程

這是前端最常見的接線流程：

1. A 在 task `123` 留言 `@小美 請幫我看一下`。
2. 後端解析到 `@小美`，建立一筆通知給對應收件者。
3. B 進入任一頁面時呼叫 `GET /api/notifications`。
4. UI 把 `read_at = null` 的項目顯示成未讀 badge，列表中可見 `snippet`。
5. B 點開通知，前端先導到 `source_task_id` 對應 task。
6. 前端再呼叫 `POST /api/notifications/:id/read`。
7. 後端回成功後，下一次拉取時該筆通知的 `read_at` 變成非空值。

---

## 4. 成功與限制情境

### 成功

- 留言中的有效 `@Name` 或 `@email` 會成為通知目標。
- `@自己` 不通知。
- 前端可用 `read_at` 決定未讀/已讀樣式。
- 目前實測可看到，同一留言內重複 `@` 同一人只會有一筆通知；但只要是不同留言，只要再次提及就會再新增一筆通知，和既有未讀數量無關。

### 限制

- 找不到的 handle 忽略，不報錯。
- task description 內的 `@` 目前不觸發通知。
- 通知是拉取式，不提供 push / WebSocket。
- `POST /api/notifications/:id/read` 是 idempotent；重複標已讀仍回成功。

---

## 5. 文件對照說明

這份文件是根據目前 repo 內可驗證的 `@mention` UI 行為整理出來的，並把 task 描述中要求的通知契約補成前端可讀格式。

如果後續後端實作出現以下情況，請同步更新這份文件：

- 路由名稱改變。
- 通知資料欄位增刪。
- 排序規則改變。
- task description 的 `@` 也開始觸發通知。
