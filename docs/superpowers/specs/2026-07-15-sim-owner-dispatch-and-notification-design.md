# SIM Owner 派工與逐筆通知處理設計

## 目標

修正目前 SIM 自動化的三個連鎖問題：通知 prompt 過大會永久阻塞成員、runner roster 與實作 workspace 成員不一致，以及 team sweep 依固定 runner 順序啟動而無法落實專長派工。

完成後的責任邊界是：

- Owner 讀取任務、成員專長與負載後決定 assignee。
- Scheduler 只啟動 Owner 已指派且實際有權限的成員，不自行判斷專長或認領。
- 每一筆通知都由 AI 獨立閱讀與判斷；同一 task 的多筆通知不得合併成單一處理單位。
- Canonical task-tracker workspace 與未來新建的 SIM workspace 具備完整 runner roster；其他 workspace 不自動擴張權限。

## 範圍

本期包含：

- `sim/run.ts` 的通知前置、roster reconciliation、Owner prompt、member prompt、manual sprint 與 sweep scheduler。
- `src/task.ts` 的 assignee membership 與 Doing 狀態守門。
- 對應的 SIM、domain、API、文件與受控 live 驗收。

本期不包含：

- 新增 capability、persona、roster 或 scheduler 資料表。
- 以關鍵字、embedding 或模型評分在 scheduler 內推測專長。
- 將 user06 補進全部歷史或一般 active workspace。
- 無 assignee Todo 的超時認領、fallback 認領或自動搶單。
- user09 runner、前端通知中心或新的通知 API。
- 未經額外人工授權執行 live AI sweep。

## 核心資料流

```text
notification snapshot
  -> 每筆 notification 獨立 bounded preflight
  -> 成功者各自標已讀，失敗者各自保留未讀
  -> actor 的 snapshot 全部完成才可進一般工作

managed roster reconciliation
  -> 讀取 workspace 實際 active members
  -> Owner 依 eligible profile 與負載指派 task
  -> scheduler 選出最多 3 位已指派且 notification-ready 的成員
  -> member 只處理自己名下的 Todo/Doing
```

## 逐筆通知處理

### 處理單位與順序

通知處理單位固定為單一 notification，不是 task，也不是 actor 的整批 snapshot。同一 task 若有三筆未讀通知，必須啟動三次獨立 preflight、寫入三份 prompt artifact，並分別驗證與標記三筆通知。

快照依 `created_at` 由舊到新處理，`notification_id` 作為同時間的穩定 tie-breaker。每筆通知開始前重新取得 task、來源留言與目前留言，前一筆處理產生的留言因此會成為下一筆可見的上下文。

單筆失敗不得停止後續通知：A 成功、B 失敗、C 成功時，只留下 B 未讀。actor 只有在登入時快照內的每一筆通知最後都已讀，才可進入本輪一般工作。處理快照期間新到的通知不加入本輪，留待下一次 actor session。

### Bounded prompt

每筆通知建立自己的 bounded prompt，最終長度上限為 `16_000` 個 JavaScript 字元。Prompt 必須完整保留：

- actor、notification id、task id、workspace id 與 API 操作規則；
- task title；
- 該筆 `source_comment` 的完整內容；comment domain 已限制最多 5000 字；
- 主工作區每筆通知都需新增留言、禁止自我 mention、不得自行標已讀等規則。

其餘內容依以下優先順序填入剩餘空間：

1. task description，最多 2000 字；
2. 最新 6 則留言；
3. source comment 前後各最多 2 則留言；
4. 去除已包含的 source comment 與重複 comment id。

候選留言超出剩餘空間時，保留較高優先內容並附上 `已省略 N 則留言；需要時請用 API 重新讀取`。不得靜默截斷 source comment；若固定規則加完整 source comment 已超出上限，該通知 fail closed 並保留未讀。

### 每筆通知的成功條件

主工作區通知在啟動 AI 前先保存該 task 的 comment id 集合。AI session 正常結束後，driver 重新讀取 comments，必須找到至少一則：

- 不在處理前集合內；
- 作者是目前 actor；
- content 非空白；
- 不包含對 actor 自己姓名、email 或 handle 的 mention。

每筆通知都需要自己的新留言，前一筆的留言不能滿足下一筆。AI 有新意見時留下具體內容；資訊重複或沒有補充時可使用精確文字 `已閱讀，目前無補充。`，也可留下其他符合規則的訊息。

一般 workspace 的通知不強制留言；來源成功讀取且 AI session 正常結束即可標記該筆已讀。Task、comment 或 workspace 對 actor 回 `403`／`404` 時沿用既有 unavailable 規則：記錄 notification/task/status 後標記該筆已讀，不啟動 AI。網路錯誤、`5xx`、資料格式錯誤、runner error/timeout 或主工作區留言驗證失敗都保留該筆未讀。

## 受控 roster 同步

### 管理範圍

自動 roster reconciliation 只套用於：

- `CANONICAL_WORKSPACE_BY_REPOROOT` 登記的 task-tracker canonical workspace；
- 未來由 SIM bootstrap 新建立的 sprint workspace。

以下 workspace 不自動同步：

- 固定主協作工作區；其 user02-06 與 user09 仍維持 Commenter；
- 既有歷史 SIM workspace；
- 未登記為 canonical、也不是本次 bootstrap 新建的一般 workspace。

### 同步規則

Managed workspace 的期望 runner roster 是 user02-06，角色至少為 Member。同步由 driver 透過既有 member API deterministic 執行，不呼叫 AI：

- 缺少或 removed：Owner invite 為 Member，該使用者登入並 join；
- invited：該使用者登入並 join；
- Viewer／Commenter：Owner 調整為 Member；
- Member／Admin／Owner：保持原角色，不降級；
- 重跑不得追加重複 invite/join/role-change 事件。

Canonical reconciliation 在 sweep 掃描與 Owner 派工前執行；新 sprint workspace 在 bootstrap 完成。同步局部失敗時記錄 workspace、email、原角色與錯誤，繼續使用 live DB 中實際可用的 roster，不把缺席成員當成 eligible。

### Eligible runner

Owner 與 scheduler 使用同一個 eligible 定義：

- email 存在於 `MEMBER_RUNNERS`；
- runner/model 設定完整；
- workspace member read model 中有該 user；
- live role 至少為 Member。

只有 `users` 帳號存在、主工作區是 Commenter、仍為 pending invite、或 `userId` 未解析成功，都不構成 eligible。

## Owner 專長派工

### Owner 輸入

Owner prompt 只列 eligible runners，且每位包含：

- name、email、user id 與 profile；
- 目前指派給他的 Todo／Doing 數量；
- 是否有 Doing 退回工作或未合併 branch；
- 對應 branch 與現有 CI/review 資訊（適用時）。

Profile 保留在 `MEMBER_RUNNERS` 的現有靜態設定，不新增 capability schema。Scheduler 不解讀 profile；專長與負載判斷只由 Owner 負責。

### 派工規則

- Full/fast sprint 的 Owner 開場建立 task 時直接提交 `assignee`，不再留空等待認領。
- 一般 owner sweep 遇到無 assignee Todo 時，必須依專長與目前負載 PATCH assignee。
- 主工作區走 implement 結論時，Owner 在目標 workspace 建立已指派的實作 task；指派對象必須是目標 workspace 的 eligible runner。
- 每次新派工留下單一 `【OWNER派工】` 留言，至少包含負責人、專長理由與下一個可驗收成果。
- 原則上每位成員只有一個 active Todo／Doing；沒有更合適且可用的人選時才可指派第二題，並在派工留言說明原因。
- 沒有 eligible runner 時 task 保持無 assignee，Owner 留一次 `[ESCALATE]` 說明缺少的能力或 roster；環境未變時不重複留言。
- Owner 可在取得新資訊後重新指派，但必須留言說明原因；scheduler 與 notification failure 不會自動改派。

所有 Owner/member prompt 中的「認領制」、「assignee 留空」、「成員自行挑無主題」、「搶先確認後認領」與 owner 建議但不指派等舊規則都移除。

### Smoke 模式

`--smoke` 不再繞過 Owner。它先執行 Owner 開場並驗證至少建立兩筆具有合法 eligible assignee 的 task，再啟動最多兩位不同的已指派 member，以覆蓋 Owner 派工、member 執行與 driver commit 管線。Owner 未完成合法派工時 smoke fail closed，不由 driver 或 member 代為指派。

## 嚴格 scheduler

### Team/both sweep

`memberBudget` 由 2 調整為 3：

- `--sweep team` 每 tick 最多啟動 3 位 member；
- `--sweep both` 的 member 部分每 tick 最多啟動 3 位；
- `--sweep owner` 不啟動 member；
- notification preflight 不消耗這 3 個一般工作名額。

這個 budget 計算的是一般工作 member session，不是 task 數；同一位 member 即使名下有多題，在同一 tick 也只占一個名額並啟動一個 session。

Scheduler 只考慮 eligible runner 名下 status 為 Todo 或 Doing 的 task。無 assignee Todo 不啟動任何 member，也沒有超時、自行認領或 fallback。

選擇單位是 member，不是 task；同一 member 每 tick 最多一個一般工作 session。候選 member 排序如下：

1. 名下存在 Doing；
2. 只有 Todo；
3. 同組以該 member 最舊 active task 的 `updated_at` 由舊到新；
4. 再以 email 作穩定 tie-breaker。

完成全成員通知巡檢後，notification result 未完成者從本 tick 候選移除且不占 member budget。其他已指派成員可補足最多 3 個名額，但不得接手被阻塞成員的 task。Assignee 不在 eligible roster 時跳過並記錄 roster mismatch，等待 Owner 後續決定。

Owner runner 不可用只會阻止新派工與 Owner 審查；team tick 仍可推進已指派的 Todo/Doing。

### Member session

Member prompt 只允許處理 `assignee_id` 等於自己的 Todo/Doing：

- Doing 與 Owner 退回意見優先；
- 其次是自己最舊的 Todo；
- 一次只處理一題；
- 不得 PATCH assignee，不得認領無主 Todo，也不得以無工作為由評論其他 task；
- 名下沒有可處理 task 時直接記錄並結束。

Manual full/fast sprint、repair 與 sweep 使用相同的已指派規則；不再以 `RUN.members` 全員上線或有無主題就啟動 idle member。

## Task domain 守門

為避免 Owner 或人工 API 建立 scheduler 無法執行的 task 狀態：

- `createTask` 與 `changeTaskAssignee` 對非 null assignee 驗證其為該 workspace 的 active member；
- 一般 workspace 由 Todo 進入 Doing 前，task 必須有非 null assignee，且該 assignee 仍是 active member；
- task move 可維持既有「對 target 發 invite、等待 join」行為，但 assignee 尚未 active join 前不得進入 Doing；
- 主工作區討論固定無 assignee 且不使用 Doing，不受一般 Doing 守門影響；
- 本期不改一般人類 Member 的整體 task mutation RBAC；SIM prompt 政策另行禁止 member 自改 assignee。

這些守門只使用既有 workspace member read model，不新增 schema。

## 錯誤處理與可觀測性

每筆 notification log/artifact 必須帶 actor、notification id、task id、runner/model、prompt 長度、是否截減、session 結果、驗證結果與 read 結果。逐筆結果不得只收斂成 actor 層級的單一布林值；actor summary 要列成功、失敗與 unavailable 數量。

Roster log 必須列出 managed workspace 的 expected、active、eligible、missing 與 role mismatch。Scheduler log 必須列出 selected、notification-blocked、invalid-assignee、unassigned Todo 數量與剩餘 budget。

所有錯誤採 fail closed：不得因 runner exit 0 以外的推測、舊留言、其他 notification 的留言、profile 推測或 roster 預期值而標記成功。

## 驗證

### Notification 單元與整合測試

- 同 task 三筆通知必須產生三個 prompt、三次 runner call 與三次獨立驗證。
- 每份 prompt 只使用自己的 notification metadata 與 source comment，其他留言僅作 bounded context，且總長度不超過 16,000 字元。
- Source comment 完整保留；description/context 依優先序截減並包含省略提示。
- 第二筆不能用第一筆新留言通過；第三筆同理。
- A 成功、B 失敗、C 成功時，只有 B 保持未讀且仍會執行 C。
- 主工作區接受 `已閱讀，目前無補充。` 或其他合格訊息，拒絕空白、自我 mention 與既有留言。
- 一般通知成功可不留言；403/404 各自標已讀；5xx、runner error/timeout 與格式錯誤各自保留未讀。
- Actor 仍有 snapshot 未讀時不進一般工作；全部成功後才可進入。

### Roster 測試

- Canonical 缺少 user06 時會 invite/join 為 Member，重跑完全 idempotent。
- Viewer/Commenter 升為 Member；Member/Admin/Owner 不降級。
- 主工作區 user06 仍為 Commenter，歷史／一般 workspace 完全不變。
- 新 bootstrap workspace 一開始就具備 user02-06。
- Reconciliation 局部失敗時，missing member 不出現在 eligible roster，其他成員仍可使用。

### Owner 與 scheduler 測試

- Owner prompt 包含 eligible member profile、active workload 與 user id，不含非成員。
- Full/fast/smoke 與 sweep 的 task 都由 Owner 指派；prompt 不再出現認領制指示。
- 無 assignee Todo 啟動 0 位 member。
- 三位有 assigned work 時同 tick 全部啟動；四至五位時只啟動排序前 3 位。
- Doing 優先於 Todo；同狀態以最舊 active task 排序，避免固定 roster 順序飢餓。
- 同一 member 多題仍只啟動一個 session。
- Notification-blocked member 不占 budget，其他已指派 member 可遞補但不接手其 task。
- Invalid assignee 不啟動並產生 roster mismatch。
- Owner runner 不可用時，已指派 team work 仍可執行。
- Smoke 若 Owner 未建立至少兩筆合法已指派 task，必須 fail closed。

### Domain/API 測試

- Create/PATCH assignee 拒絕非 workspace active member。
- Todo 無 assignee，或 assignee 已離開 workspace 時，拒絕進 Doing。
- 合法 active member 可被指派並推進 Todo -> Doing。
- Move 後 pending invite 保留 Todo；join 後才可進 Doing。
- 主工作區既有 Todo -> Done 討論例外維持不變。

### Fresh verification

實作完成後先執行：

```bash
npx tsc --noEmit
npx tsc -p sim/tsconfig.json
npx tsx src/task.test.ts
npx tsx sim/run.test.ts
npm test
npm run build
git diff --check
```

Live 驗收需要另行取得人工授權。受控資料應包含：同 task 對 user06 建立三筆通知、其中一筆可驗證失敗、canonical user06 roster、Owner 指派給 user06 的前端 Todo，以及一筆無 assignee Todo。驗收必須確認三份 bounded prompt、逐筆 read 狀態、user06 Member 身分、只有已指派成員啟動、無 assignee 不啟動、service `/api/health` 正常與 DB readback 一致。

## 文件同步

實作時同步更新：

- `docs/operations.md`：逐筆通知、managed roster、Owner 派工、嚴格 scheduler 與 budget 3。
- `docs/owner-sweep-guide.md`：Owner 依 eligible profile/負載指派與派工留言。
- `docs/tasks/current.md`：最新 runner model、已交付功能與 live readback 狀態。
- 舊 notification gate spec 保留歷史設計；本規格對「整批 notification session」與「每個不同 task 一則主工作區留言」的部分取代舊規則。
