# API 說明

本文件記錄目前已實作、需要對外使用的 HTTP API 契約。所有受保護 API 都使用 cookie-based session；先呼叫 `POST /api/auth/login` 取得 `session` cookie，再帶著 cookie 呼叫 API。

## Quota

### `GET /api/quota`

取得 Codex、Claude 與 AGY 的 quota 狀態。此 endpoint 只需要登入，不綁定特定 workspace 或角色。

#### Request

- Method：`GET`
- Path：`/api/quota`
- Query：無
- Body：無
- Authentication：需要 `session` cookie

#### Success response

HTTP `200`，回傳 provider 陣列，固定包含 `codex`、`claude`、`agy` 三筆：

```json
[
  {
    "provider": "codex",
    "remaining": "80%",
    "resetAt": "2026-07-13T05:00:00.000Z",
    "source": "chatgpt.com/backend-api/wham/usage.primary_window",
    "unavailable": false
  },
  {
    "provider": "claude",
    "remaining": null,
    "resetAt": null,
    "source": "~/.claude/stats-cache.json",
    "unavailable": true
  },
  {
    "provider": "agy",
    "remaining": null,
    "resetAt": null,
    "source": "agy-cli-no-local-quota-source",
    "unavailable": true
  }
]
```

欄位定義：

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `provider` | `"codex" \| "claude" \| "agy"` | quota provider 名稱 |
| `remaining` | `string \| null` | 剩餘比例，例如 `"80%"`；無法取得時為 `null` |
| `resetAt` | `string \| null` | 預計重置時間，使用 UTC ISO 8601；無法取得時為 `null` |
| `source` | `string` | 實際使用或嘗試使用的 quota 資料來源，供診斷顯示 |
| `unavailable` | `boolean` | `true` 表示該 provider 無法取得 quota；不代表整個 API 失敗 |

單一 provider 讀取失敗時，API 仍會回 HTTP `200`，該筆資料會標記 `unavailable: true`。因此 client 應逐筆檢查 `unavailable`，不要只依賴 HTTP status。

#### Authentication failure

未登入時回 HTTP `401`，不會查詢 quota：

```json
{
  "error": "未登入"
}
```

#### Example

```bash
BASE=http://127.0.0.1:3000

curl -sS -c /tmp/task-tracker-session.jar -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"user01@test.local","password":"test1234"}'

curl -sS -b /tmp/task-tracker-session.jar "$BASE/api/quota"
```

#### Cache and provider behavior

- server 端 cache 有效期為 3 分鐘，檔案預設寫在 `.cache/quota.json`。
- cache 未過期時直接回傳 cache，不重新查詢 provider。
- cache 過期或不存在時，三個 provider 會並行刷新；刷新完成後寫回 cache。
- Codex 會讀取 `~/.codex/auth.json` 的 access token，查詢 ChatGPT usage endpoint。
- Claude 與 AGY 目前沒有可用的本機 quota source，因此正常狀態會以 `unavailable: true` 回傳。
- API response 只回傳 `providers` 陣列，不回傳 server 內部 snapshot 的 `cachedAt`。

#### Unexpected server error

若發生 cache 讀寫等未被 provider fallback 處理的內部錯誤，回 HTTP `500`：

```json
{
  "error": "內部錯誤"
}
```

實作與測試：[`src/server.ts`](../src/server.ts)、[`src/quota.ts`](../src/quota.ts)、[`src/quota.test.ts`](../src/quota.test.ts)。
