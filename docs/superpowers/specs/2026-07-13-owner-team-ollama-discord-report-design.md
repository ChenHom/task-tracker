# Owner/Team Ollama Discord Report Design

## Goal

提供一個手動執行的 TypeScript 報告工具：讀取最近的 owner/team sweep log，按成員拆分資料，每次只把一名成員的精簡事件送給區網 Ollama 判斷，最後將合併摘要輸出，並可明確選擇發送到 Discord 頻道 `1515967128317071520`。

## Scope

### Included

- 從 `sim-logs/sweep-owner-cron-*.log` 與 `sim-logs/sweep-team-cron-*.log` 讀取 sweep 事件。
- 預設整理最近完整 60 分鐘；支援 `--since` 與 `--until` 指定時間範圍。
- 只保留五類欄位：時間、角色/成員、工作結果、錯誤、commit。
- 以 owner、team 成員分組，每組獨立呼叫一次 Ollama。
- 單一成員輸入設上限，避免超過 Ollama 4K context；截斷時要明確標記。
- Ollama 單組失敗時繼續處理其他成員，最後摘要保留失敗狀態。
- 預設只輸出摘要；傳入 `--send` 才透過 OpenClaw CLI 發送。
- Discord 目標固定為 `channel:1515967128317071520`，超過單則長度時拆成多則。

### Excluded

- 不修改 `sim/run.ts` 的 sweep 行為。
- 不讀取或輸出完整 agent prompt、cookie、token、原始長 log。
- 不新增資料庫 schema 或常駐服務。
- 不自動建立 systemd timer。

## Architecture

新增獨立報告模組與 CLI entrypoint，將「解析資料」「Ollama 呼叫」「摘要格式化」「Discord 發送」分開。解析器只產生安全的精簡事件；Ollama client 只接收單一成員的事件；發送器只接收最終文字，並透過既有 OpenClaw 設定取得 Discord credentials。

建議檔案邊界：

- `scripts/owner-team-report.ts`：CLI、時間範圍、檔案掃描、流程編排。
- `scripts/owner-team-report-lib.ts`：純函式的 log parser、分組、輸入限制、Discord 分段。
- `scripts/owner-team-report.test.ts`：不連外的純函式測試。
- `package.json`：加入手動執行 script。
- `docs/operations.md`：補充手動報告與 `--send` 使用方式。

## Data Flow

```text
sweep cron logs
  -> timestamp filter
  -> extract time/member/result/error/commit only
  -> group by one member
  -> Ollama request per member (bounded input)
  -> local merge with member labels and failures
  -> stdout
  -> optional openclaw message send --channel discord --target channel:1515967128317071520
```

### Event extraction

只解析含有時間前綴的 sweep/session/commit 行。保留：

- `time`：log 行的 `HH:MM:SS` 與日期來源。
- `member`：`owner` 或成員名稱，例如 `小美`、`阿凱`、`大熊`。
- `result`：工作完成、略過、保留 diff、timeout、service 收尾等短描述。
- `error`：quota、session limit、timeout 或其他明確錯誤。
- `commit`：commit hash 與簡短標題；沒有則為 null。

完整 prompt、工作目錄、cookie 路徑、命令列與 raw stderr 不進入 Ollama payload。

### Ollama boundary

每次 request 固定使用 `gemma4:e4b` 與 `http://192.168.50.105:11434/api/generate`。每個成員獨立 request，request 失敗不阻斷其他成員。輸入使用短欄位格式並設定字數/bytes 上限，保留事件尾端並加入 `[TRUNCATED]` 標記，避免不透明地超出 context。

Ollama prompt 要求：繁體中文、只根據輸入、輸出短 bullet、不要重複原始資料。最終合併不再把所有原始事件送回 Ollama，避免第二次超過 4K。

### Discord boundary

只有 CLI 傳入 `--send` 才執行：

```bash
openclaw message send \
  --channel discord \
  --target channel:1515967128317071520 \
  --message "..."
```

測試與預覽模式不呼叫此命令。摘要超過 Discord 單則限制時，在 bullet 邊界拆成多則；任何一則不得超過保守上限。

## Error Handling

- 找不到 log：輸出明確錯誤並以非零狀態結束。
- 沒有時間範圍內事件：輸出「無事件」，不發送 Discord，除非明確要求。
- Ollama 連線/解析失敗：該成員標記為 `OllAMA_ERROR`，其他成員繼續。
- OpenClaw 發送失敗：保留完整 stdout 摘要並以非零狀態結束。
- 不把 secret、token、cookie 或完整 prompt 放進錯誤訊息。

## CLI

```bash
# 預覽最近完整一小時
npm run report:owner-team

# 指定時間範圍並發到 Discord
npm run report:owner-team -- --since "2026-07-13T00:31:00+08:00" --until "2026-07-13T01:31:00+08:00" --send
```

預設是 preview；`--send` 是唯一啟用外部 Discord 寫入的旗標。

## Testing

純函式測試涵蓋：

- 只抽取允許欄位，不保留 prompt、cookie、token 或 raw command。
- 時間範圍正確過濾跨午夜事件。
- owner 與每位成員正確分組。
- 每組 Ollama payload 都低於上限，超長資料有 `[TRUNCATED]`。
- 成員順序穩定，單一成員失敗不影響其他結果。
- Discord 長訊息會在安全長度內拆分。
- preview 不會呼叫發送器。

實際 Ollama 與 Discord 發送屬手動 smoke，不放進預設 `npm test`，避免測試依賴區網模型與外部訊息服務。

## Security and Operations

- Ollama URL 可由環境變數覆寫，但預設固定使用已確認的區網端點。
- Discord credentials 由 OpenClaw CLI 管理，腳本不讀取 token。
- `--send` 發送前先在 stdout 印出時間範圍、成員數與訊息數，不印 credential。
- 本功能是手動工具，不會自動啟用 timer 或修改現有 owner/team sweep 排程。
