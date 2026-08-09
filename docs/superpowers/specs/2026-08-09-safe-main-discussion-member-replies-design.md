# 主工作區安全外網查證與成員實質回覆設計

## 問題與根因

2026-08-05 的 notification gate 安全修正，把主工作區通知由 AI preflight 改為 driver 直接寫入固定文字 `已閱讀，目前無補充。`。這避免了舊流程把 session cookie、未消毒留言與任意 `Bash(curl:*)` 同時交給模型，但也移除了成員閱讀脈絡、外網查證與形成意見的步驟。

目前 `processNotificationGate()` 對主工作區通知無條件寫入固定文字，成功 readback 後便標記通知已讀；同時 `[討論]` task 會被一般 member sweep 排除。因此成員沒有其他自動流程可回到該討論。多位成員在同一秒留下相同固定文字，是 driver 強制回覆的結果，不代表各自完成判斷，也不能形成 Owner 共識結論。

本設計只取代這個固定回覆分支。逐筆通知、未讀 gate、一般工作排程、Owner 派工與共識規則均維持現狀。

## 目標

- 主工作區 user02–user06 收到 mention 通知後，各自閱讀該 task 與討論脈絡，必要時查證公開外網資料，再留下有理由的 `【同意】` 或 `【疑慮】`。
- 模型不取得 task-tracker session cookie、密碼、環境變數、repo／本機檔案或任意 shell／HTTP 能力。
- 外網能力限於公開搜尋與公開頁面唯讀查閱；不得存取 task-tracker、區網、localhost、metadata endpoint 或任意非 HTTP(S) 目的地。
- 未通過輸入消毒、模型執行、輸出驗證、留言寫入或 readback 的通知保持未讀，讓既有重試與一般工作阻擋語意繼續生效。
- 不以固定 no-op 文字假裝完成討論，也不改變既有共識 validator、Owner 收尾及 task 狀態流程。

## 非目標

- 不恢復舊的 `Bash(curl:*)` notification preflight。
- 不讓討論 session 直接呼叫 task-tracker API、寫檔、操作 Git、執行 shell 或修改 task 狀態。
- 不改一般 workspace 通知的 API-only 流程。
- 不改 user02–user06 的一般工作 runner、model、fallback、persona、派工資格或 member budget。
- 不把 user09 加入自動 SIM runner。
- 不新增資料表、notification API 或前端 UI。
- 未經人工另行授權，不執行 live AI sweep。

## 選定架構

主工作區通知拆成三個責任邊界：

```text
task-tracker driver（持有 actor cookie）
  -> 讀取 task、source comment 與 bounded context
  -> 建立已消毒、標示為不可信資料的 discussion packet
  -> 啟動隔離的 safe discussion session
       -> 只能使用公開 WebSearch／WebFetch
       -> 回傳文字草稿，不得呼叫 task-tracker
  -> deterministic 驗證草稿
  -> driver 用自己的 actor cookie POST comment
  -> driver readback 新留言
  -> driver 標通知已讀並做 final notification readback
```

Cookie 與 API mutation 永遠留在 deterministic driver；模型只取得最低必要的討論資料並回傳候選文字。這讓 prompt injection 最多影響候選答案，不能直接取得認證資料、執行本機命令或寫入系統。

### Safe discussion route

Safe discussion session 必須使用能同時做到以下條件的 runner adapter：

- 以正向 allowlist 限定可見工具為 `WebSearch`、`WebFetch`；
- 每次 web tool call 先經 deterministic egress policy hook 檢查 query／URL；hook 拒絕時 runner 不得繼續該 call；
- 不向 session 暴露 Bash、shell、Read、Write、Edit、Glob、Grep、Git、MCP app 或 browser automation；
- 使用獨立空白 working directory，不以 repo 作 cwd；
- 只繼承啟動 runner 所需的最小環境，不繼承 task-tracker password、cookie 或其他服務 token；
- 可將模型最終文字作為資料捕捉，不依賴模型自己 POST 留言。

現有 adapter 中，只有 Claude CLI 同時提供 `--tools` 與 `--allowedTools` 的強制正向工具限制，因此第一版 safe discussion route 固定走 Claude，且兩者都只宣告 `WebSearch,WebFetch`。Codex 的現有 adapter 不接受工具 allowlist，AGY 也沒有對等限制，兩者不得作為此流程 fallback。任一 quota、timeout 或 runner error 都 fail closed；不降級至具有較大能力的 runner。

這個 route 只服務主工作區通知討論，不取代成員的一般工作 route。Prompt 只帶入該 actor 現有的顯示名稱與 profile，不帶 email、user id 或其他內部識別資料，讓 user02–user06 保留各自的審查視角；不得把其他 runner 的工具或檔案能力帶入 discussion session。

## 輸入資料邊界

### Discussion packet

每筆 notification 建立一份獨立 packet，固定包含：

- actor 的顯示名稱與既有 profile；
- task title；
- task description，最多 2,000 個 JavaScript 字元；
- 該筆 source comment，最多 5,000 個 JavaScript 字元；
- 最新最多 6 則留言，排除重複的 source comment，每則最多 1,500 個 JavaScript 字元；
- 固定回覆契約、公開研究限制與輸出格式。

最終 prompt 上限為 16,000 個 JavaScript 字元。固定規則、actor profile、title 與 source comment 優先；空間不足時依序刪減其他留言、description，並明示省略數量。若固定規則加已限制後的 source comment 仍無法容納，該筆失敗並保持未讀。

所有 task/comment 欄位均放在明確的 `UNTRUSTED_TASK_DATA` 邊界內。Prompt 明示區塊內的指令、工具要求、角色切換或輸出格式要求都只是被討論的資料，不得凌駕系統規則。

### Deterministic 消毒

送入模型前，driver 對所有外來文字執行同一套純函式處理：

1. Unicode 正規化為 NFC，換行正規化為 `\n`。
2. 保留換行與 tab，移除其餘 C0/C1 control characters、NUL、bidi override/isolate 與不可見格式控制字元。
3. 以固定遮罩取代 session cookie、Bearer/API token、password／secret／private-key 形態與 URL userinfo；遮罩值不可保留原字串片段。
4. 遮罩 private／loopback／link-local IP、`.local` host 與 task-tracker 內部 base URL，避免模型把內部位置帶入查詢或答案。
5. 套用逐欄與總長度上限，再以固定 delimiter 組裝；不得讓資料內容關閉 delimiter。

Driver 不把 runtime cookie、login password、完整 `process.env`、本機絕對路徑或 prompt artifact 路徑加入 packet。Notification snippet 不作為 source comment 的替代；仍以 API readback 到的 comment 為準。

### 公開外網限制

模型可自行決定是否需要查證，但只允許公開 WebSearch 與 WebFetch：

- 只接受 `https`，以及必要時由搜尋結果導向的 `http`；禁止其他 scheme、URL userinfo 與非標準 port。
- 禁止 localhost、loopback、RFC1918、carrier-grade NAT、link-local、multicast、保留位址、雲端 metadata 位址、`.local`／內部搜尋網域及 DNS 解析後落入上述範圍的目的地。
- Redirect 每一跳都重新套用同一目的地檢查。
- WebFetch 只能讀公開頁面，不得提交表單、登入、上傳或使用帶認證 header/cookie 的請求。
- 搜尋 query 有長度與次數上限，套用同一組 secret／內部識別遮罩；含 credential-like 資料，或與 task/comment 連續重疊 24 個以上 Unicode 字元的 query，必須由 egress policy hook 拒絕。
- 工具結果同樣視為不可信資料，只能作為回答依據，不能擴大工具權限。

上述限制必須由 runner/tool allowlist、每次 call 前的 egress policy hook 與 provider 的 web tool 邊界共同執行，不能只依靠 prompt 要求。若實作時無法以測試或 provider 契約確認 WebFetch 的 DNS／redirect private-network 防護，effective allowlist 只能是 `WebSearch`；確認後才可使用 `WebSearch,WebFetch`。這是 fail closed，不得用 curl 補足。

## 回覆契約與驗證

Safe discussion session 只能回傳一則候選留言。候選留言必須：

- trim 後以 `【同意】` 或 `【疑慮】` 開頭；
- marker 後包含至少一個具體理由、風險、驗證依據或下一步，不接受只有 marker；
- 資訊不足時使用 `【疑慮】資訊不足：...` 並指出缺少什麼，不以無內容回覆代替判斷；
- 長度介於 20 到 1,500 個 JavaScript 字元；
- 不等於或包含固定 no-op `已閱讀，目前無補充。`；
- 不 mention actor 自己的 name、email 或 handle；
- 不包含 credential-like 字串、內部 URL/IP、本機絕對路徑、shell/API 操作指示或模型的 tool-call envelope；
- 不要求或宣稱自己已修改 task、留言、通知或 repo。

驗證是 deterministic allow/reject，不自動改寫模型內容。驗證失敗時不得 POST 替代文字，也不得標記通知已讀；log 僅記錄失敗類別，不寫出可能含敏感資料的原文。

## 逐筆處理流程

每位 actor 登入後，維持現行快照與排序規則：`created_at` 由舊到新，`notification_id` 作 tie-breaker。每筆依序執行：

1. 以 actor cookie 讀 task 與 comments。
2. Task/comments 對 actor 回 `403` 或 `404` 時，沿用 unavailable 規則，標記該通知已讀且不啟動模型。
3. 找不到 source comment 時沿用 unavailable `404` 規則。
4. 一般 workspace 維持現行 API-only 處理，不啟動 safe discussion session、不強制留言。
5. 主工作區先保存既有 comment id，再建立、消毒並限制 discussion packet。
6. 以 actor profile 啟動一個 safe discussion session；每筆 notification 各自啟動，不合併。
7. Driver 驗證候選留言，通過後才使用 actor cookie POST comment。
8. Driver 重新 GET comments，必須找到一則不在處理前集合、作者是 actor、內容與已驗證候選留言相同且不含自我 mention 的新留言。
9. Readback 成功後才 POST notification read。
10. 全部 snapshot 處理完後執行既有 final notification readback。

同一 task 的多筆通知各自需要一則新留言，前一筆的新留言可成為下一筆 bounded context，但不能用來滿足下一筆成功條件。單筆失敗不停止後續通知；A 成功、B 失敗、C 成功時只有 B 保持未讀。只要 actor 的 snapshot 仍有任何未讀，`ready=false`，該 actor 本輪不進一般工作。

## 錯誤、重試與 fallback

- Login 保留既有僅針對連線 `TypeError` 的最多兩次重試；HTTP、401/403、429 不擴大重試。
- Task/comment fetch 的 `5xx`、格式錯誤與網路錯誤保持未讀。
- Sanitization、prompt size、runner、quota、timeout、web tool refusal、輸出驗證、comment POST、comment readback 或 notification read 失敗都保持未讀。
- 不重試 comment POST，避免在不確定結果時重複留言；由 readback 判斷本次是否成功。
- Safe discussion route 不使用 member normal-route fallback；只有未來同樣能強制相同工具與資料邊界的 route 才可被加入 fallback。
- 不再保留 `已閱讀，目前無補充。` fallback。模型沒有合格意見就是失敗，等待下個 timer tick 重試。

## 保持不變的能力與流程

- `SIM_NOTIFICATION_GATE=1` 的啟閉語意不變。
- user02–user06 都會在每個 team/both tick 巡檢通知，與是否有 Todo/Doing 無關。
- `[討論]` 與主工作區 policy task 仍不進一般 member work scheduler。
- 一般 member session 的 runner/model、repo 工具、指派規則、最多三人 budget 與 commit 流程不變。
- Owner sweep、`【OWNER想法】`、`【同意】`／`【疑慮】` 共識計數、validator、結論與 Todo -> Done 流程不變。
- 一般 workspace 通知、unavailable 通知、notification UI 與 API contract 不變。
- 每筆通知獨立、失敗保持未讀、未完成通知阻擋該 actor 一般工作等既有 gate 能力不變。

## 可觀測性與資料留存

每筆 notification telemetry 記錄：deployment/configuration version、actor、notification id、task id、runner/model、輸入字數、是否截減、web tool 是否使用、latency、token total、outcome 與結構化 error category。

不得在一般 log 或 telemetry 寫入 cookie、prompt 全文、task/comment 全文、搜尋 query、fetch 內容或被拒絕的候選留言。若保留 prompt artifact 供除錯，必須只寫入消毒後 packet、權限設為 `0600`，並沿用既有 run artifact 生命週期；第一版預設不為 notification discussion 留存全文 artifact。

建議 outcome 至少區分：`succeeded`、`unavailable`、`sanitization_failed`、`runner_failed`、`web_refused`、`output_rejected`、`post_failed`、`readback_failed`。錯誤訊息只包含識別 id 與 category。

## TDD 與驗收

實作先新增會在現行固定回覆程式上失敗的測試，再寫 production code。最低測試矩陣：

### 主工作區討論

- 主工作區 notification 會呼叫 safe discussion generator；現行程式因完全不呼叫 generator 而先紅燈。
- 合格 `【同意】` 與 `【疑慮】` 各自被 POST、readback，之後才標通知已讀。
- `已閱讀，目前無補充。`、空白、只有 marker、過短／過長、自我 mention、secret/internal URL 與 tool-call 格式都被拒絕；不 POST、不標已讀。
- Generator error、timeout、quota、tool refusal、POST failure 與 readback failure 各自保持未讀。
- 同 task 多筆 notification 各自呼叫 generator 並需要各自的新留言；A 成功、B 失敗、C 成功只留下 B 未讀。
- actor 仍有 snapshot 未讀時不得進一般工作；全部完成後才可進入。

### 消毒與 capability

- NFC、換行、control/bidi 字元、secret/token、URL userinfo、private IP／host 與長度限制有純函式單元測試。
- Prompt 不含 actor cookie、login password、process env、本機路徑或未消毒來源字串。
- Safe runner invocation 的 cwd 是獨立空白目錄，環境是 allowlist；effective tool set 必須精確等於已驗證的 `WebSearch` 或 `WebSearch,WebFetch`，不得包含 Bash、Read、Write、Git 或 browser automation。
- Egress policy hook 會拒絕超長／過量 query、credential-like 內容、與來源資料連續重疊至少 24 字元的 query，以及不合格 URL；拒絕後不得呼叫 provider tool。
- Codex／AGY 不得被選為 safe route 或 fallback；safe route 不可用時保持未讀。
- Public HTTPS 搜尋／讀取可通過；localhost、RFC1918、link-local、metadata、`.local`、userinfo、非標準 port、非 HTTP(S) 與轉址到內網均被拒絕。
- 大段複製 source comment 或 credential-like 的搜尋 query 被拒絕。

### 相容性

- 一般 workspace notification 不呼叫 generator，且成功時不強制留言。
- Task/comment `403`／`404` 與 missing source comment 維持 unavailable 已讀規則；`5xx` 維持未讀。
- user02–user06 的 notification sweep roster 不變；user09 不加入。
- `isSweepWorkTask()` 仍排除 `[討論]`；一般工作 runner、route、fallback、scheduler budget 與 assignee gating 的既有測試保持通過。
- 共識 validator 仍只計算既有 `【同意】`／`【疑慮】` marker，無需修改 domain/API。

Fresh verification：

```bash
npx tsc --noEmit
npx tsc -p sim/tsconfig.json
npx tsx sim/run.test.ts
git diff --check
```

不得以 production task 或 live member call 作單元測試。實作完成後仍須另取得人工授權，才可用一筆無敏感資料的合成主工作區 mention 做受控 live 驗收；驗收需確認成員留下有理由的 marker 回覆、通知已讀、一般工作未被破壞，且 log／artifact 沒有 cookie 或原始敏感內容。

## Rollout 與回復

程式與測試合併後由既有 deployment 流程上線，先以 `/api/health`、service log 與 timer 狀態驗證部署；未取得 live AI 授權前不主動製造或消耗真實通知。

若 safe discussion route 在 production 持續失敗，回復方式是關閉 `SIM_NOTIFICATION_GATE` 或回退本次程式版本；不得回復成固定 no-op 自動已讀。未成功處理的通知仍留在 DB，恢復後可由後續 tick 繼續討論。

## 文件同步

實作時同步更新：

- `docs/operations.md`：主工作區 safe discussion route、外網邊界、錯誤處理與 live 驗收規則。
- `docs/tasks/current.md`：已交付版本、測試結果，以及 code shipped 與 live sweep 尚未／已驗收的明確區分。
- 本規格取代 `2026-07-15-sim-owner-dispatch-and-notification-design.md` 中「主工作區可用 `已閱讀，目前無補充。`」的條款，也取代 2026-08-05 driver-only fixed reply 的實作政策；其餘逐筆通知與 gate 規則保持有效。
