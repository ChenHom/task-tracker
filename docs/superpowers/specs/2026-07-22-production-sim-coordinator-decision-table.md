# Production Sim Coordinator V1 Coverage Decision Table

> 狀態：draft-for-review
> 日期：2026-07-22
> 範圍：以一個 coordinator tick 的完整過程整理 decision space。`Covered` 表示計畫已明確指定該行為與 fixture；`Deferred` 表示第一版刻意不納入；`Open` 表示需要後續確認。
> 來源：`docs/superpowers/plans/2026-07-22-production-sim-coordinator.md`、`docs/superpowers/specs/2026-07-22-production-sim-coordinator-design.md`

## Tick Scope

一個 tick 指：

```text
Gate / discovery
  -> cutover prerequisite check
  -> action selection (WIP1, queued, exclusion)
  -> member / owner session
  -> acceptance -> merge -> deployment readback
  -> completion comment -> user09 notification -> Done
  -> Discord batch
```

符號：

- `P`：`00123ef0-81cb-410e-aed1-d6d1fb925ed6` 的完整完成證據鏈成立。
- `DEP`：`938aa035-5f96-4908-b28b-876fa4735061` 為 Done 且 master 已含其 accepted merge。
- `Q`：coordinator checkpoint phase 為 `queued`。
- `HB`：coordinator checkpoint phase 為 `human_blocked`。
- `W(m)`：member `m` 目前非 blocked 的自動化 WIP task 數。
- `EV`：task evidence fingerprint。`EV changed` 表示本次 session 後 fingerprint 有變。
- `NP`：`noProgressCount`。`OI`：`ownerIntervened`。
- `TGT`：本次 merge 或 revert 的 target SHA。
- `AH`：accepted head SHA。
- `INV`：`sim-autodeploy.path` 觸發的 service invocation，以 `ExecMainStartTimestampMonotonic` 增加辨識。
- `DR`：`/home/hom/.local/state/sim-autodeploy/deployed_rev`。
- `HR`：`GET /api/health` 回傳的 `rev`。
- `TO`：等待逾時，固定 35 分鐘（`DEPLOY_WAIT_TIMEOUT_MS`）。
- `board status`：看板真實狀態，永遠不等同 checkpoint phase。

## Additional Result Conditions

使用者列出的條件之外，還有這些會影響結果：

| Condition | Why it matters |
|---|---|
| workspace allowlist | 兩個固定 UUID 以外的 workspace 連 discovery 都不進行，不存在「發現但跳過」這種中間態 |
| canonical exclusion | `mainPolicy` 與 `legacyCanonicalDiscussion` 即使是 Todo 也永不排程，必須以 ID + canonical title 雙重規則判定 |
| cutover prerequisite `P` | `P` 不成立時，整批 cutover 的 task／Git／AI mutation 必須為零，而不是只跳過該筆 |
| checkpoint vs board status | `Q` 與 `HB` 是 coordinator metadata；看板可能仍是 Review／Todo，排程必須以 checkpoint 為準 |
| action key idempotency | response 不確定時先 readback 再決定重送；`action_log` 到任務 2 才存在，任務 1 因此另立 bootstrap transcript |
| lease | 同一 task 同時只能有一個 coordinator 執行者；過期才可重新 claim |
| `EV` 變化 | 決定 session 記為 `progressed` 還是 `no_change`；process exit code 只供診斷 |
| provider / network failure | 永遠不計入 `NP`，否則暫時性錯誤會提前觸發 escalation |
| deploy generation 歸因 | 必須能把 `INV` 綁回自己那次 ref change，否則前一輪或重試會被誤認成功 |
| `.path` 觸發可靠度 | inotify 對 ref rename 與密集 merge／revert 不保證每次送達，逾時決議接手 |
| 人工介入 | operator 手動 start service、人工 task mutation 都必須能被下一個 tick 以權威 readback 認回 |
| Discord delivery | 通知管道而非 correctness gate；失敗不得回退已 Done 的 task |

## Gate Decision Table

這張表先排除不進入 task 判定的 case。適用 `--once` 與 `--once --live`。

| Case | task-tracker.service active | health HTTP 200 | owner login | 兩個 workspace GET | `P` | Expected result | Exit | Covered by |
|---|---|---|---|---|---|---|---|---|
| G1 ready | yes | yes | yes | yes | yes | 進入下方各表 | `0` | 任務 8 步驟 3、任務 11 步驟 1 |
| G2 service inactive | no | any | any | any | any | `DiscoveryUnavailable`；零 mutation、零 AI | `3` | 任務 8 步驟 3 |
| G3 health 非 200 | yes | no | any | any | any | `DiscoveryUnavailable` | `3` | 任務 8 步驟 3 |
| G4 login 失敗 | yes | yes | no | any | any | `DiscoveryUnavailable`；不得將 password 寫入 log／manifest／error | `3` | 任務 8 步驟 3 |
| G5 required workspace GET 失敗 | yes | yes | yes | no | any | `DiscoveryUnavailable` | `3` | 任務 8 步驟 3 |
| G6 prerequisite 缺漏 | yes | yes | yes | yes | no | `CutoverPrerequisiteMissing`；零 planned mutation | `2` | 任務 9 步驟 1、任務 11 步驟 1 |
| G7 未分類錯誤 | any | any | any | any | any | 程式錯誤 | `1` | Open |
| G8 單一 workspace 失敗 | yes | yes | yes | 部分 | any | 該 workspace 的 action 中止，另一 workspace 不受影響 | 依 partial failure 收斂 | 任務 3 步驟 1 |

## Cutover Prerequisite Table

`P` 由以下八個環節全部成立才為 true。任一缺漏即 `CutoverPrerequisiteMissing`、`readyForApply=false`，且 task／Git／AI mutation adapter 呼叫數皆為零。

| Link | 檢查內容 | 缺漏時 result | Covered by |
|---|---|---|---|
| P1 board status | `00123ef0...` 為 Done | prerequisite missing | 任務 9 步驟 1 |
| P2 assignment event | 唯一、晚於 `task1AuthorizedAt`、actor 為 canonical Owner、payload 為 user03 canonical ID、aggregate version 可連回 baseline | prerequisite missing | 任務 1 唯一執行綁定、任務 9 步驟 1 |
| P3 accepted head | 位於 `sim/task/00123ef0-...` 且 commit 含 `Task-Id` trailer | prerequisite missing | 任務 1 步驟 6 |
| P4 owner acceptance | 具可 read back 的 ID，且引用 exact `AH` | prerequisite missing | 任務 1 步驟 6 |
| P5 merge ancestry | accepted merge 保留 `AH` 為 ancestor | prerequisite missing | 任務 9 步驟 4 |
| P6 live rev | live `HR` 等於該 merge 或其後代 | prerequisite missing | 任務 9 步驟 4 |
| P7 completion comment | `【SYSTEM完成】` 引用同一組授權／event／acceptance／head／merge／live rev | prerequisite missing | 任務 1 步驟 6 |
| P8 notification | user09 notification 的 source comment ID 指向該留言且 recipient 為 user09 | prerequisite missing | 任務 1 步驟 6 |
| P9 generation drift | `--preflight --live --expect-generation` 時 fingerprint 或 generation 已變 | exit 非零；systemd／task／Git／AI mutation 全部為零 | 任務 9 步驟 3、任務 11 步驟 3 |

## Cutover Disposition Decision Table

| Case | Task | `P` | `DEP` | board status | Expected action this tick | Next step | Covered by |
|---|---|---|---|---|---|---|---|
| C1 prerequisite task | `00123ef0` | any | any | any | 零 assignment／status／comment／branch／AI action | 只作為 `P` 的驗證來源 | 任務 9 步驟 4 |
| C2 main discussion, blocked | `10e65231` | no | any | Todo | 零 action | 等 `P` | 任務 9 步驟 4 |
| C3 main discussion, ready | `10e65231` | yes | any | Todo | 以既有 window／conclusion／handoff 機械式結案一次 | Done，不再產生第二次 closure | 任務 9 步驟 4、任務 11 步驟 5 |
| C4 active review, blocked | `938aa035` | no | — | Review | 零 action | 等 `P` | 任務 9 步驟 4 |
| C5 active review, ready | `938aa035` | yes | — | Review | 保留／恢復 user06、留固定 action key 的 reset 說明、PATCH Review→Doing、從當時 master 開乾淨 branch | checkpoint=doing, `NP=0` | 任務 9 步驟 4 |
| C6 queued review, blocked | `6384b6f4` | yes | no | Review | 只 PATCH 清除 assignee；board 留 Review | checkpoint=`Q`, `workerId=null`, `branch=null` | 任務 9 步驟 4 |
| C7 queued review, released | `6384b6f4` | yes | yes | Review | 依序指派 user06、PATCH Review→Doing、從含 `938aa035` merge 的新 master 開 branch | 各恰好一次 | 任務 9 步驟 1 情境 3 |
| C8 deferred, blocked | `027c0052` | yes | no | Todo | 維持 Todo／unassigned／`Q`，不開 branch、不呼叫 AI | 等 `DEP` | 任務 9 步驟 4 |
| C9 deferred, released | `027c0052` | yes | yes | Todo | 依序指派 user05、PATCH Todo→Doing、從新 master 開乾淨 branch | 各恰好一次 | 任務 9 步驟 1 情境 3 |
| C10 dependency 未收斂 | `6384b6f4`／`027c0052` | yes | `938aa035` 為 `HB`／失敗／Doing／Review | any | 兩筆都維持 `Q` | 等 `DEP` | 任務 9 步驟 1 情境 4 |
| C11 main policy | `27ec8d7e` | any | any | Todo | 永遠 excluded；只出現在 manifest 的 excluded readback | 無 | 任務 3 步驟 4、任務 9 步驟 1 |
| C12 legacy canonical | `8be538bc` | any | any | Todo | 永遠 excluded | 無 | 任務 3 步驟 4、任務 9 步驟 1 |

## Scheduling Decision Table

`P` 成立後的一般排程。`m` 指該 task 的 assignee。

| Case | in allowlist | excluded | checkpoint | board status | assignee | `W(m)` | `EV changed` | Expected action | Covered by |
|---|---|---|---|---|---|---|---|---|---|
| S1 out of scope | no | any | any | any | any | any | any | 完全不 discovery | 任務 3 步驟 1 |
| S2 excluded task | yes | yes | any | any | any | any | any | 零 action | 任務 3 步驟 4 |
| S3 queued | yes | no | `Q` | any | any | any | any | 不取 lease、不開 branch、不呼叫 AI；不占 WIP | 任務 2 步驟 1 |
| S4 human blocked, 無新事件 | yes | no | `HB` | any | any | any | no | 零 action，保持安靜 | 任務 5 步驟 5 |
| S5 human blocked, 有新事件 | yes | no | `HB` | any | any | any | yes | 解除 `HB`，`NP=0`，恢復排程 | `shouldResumeHumanBlocked` |
| S6 assigned Doing | yes | no | doing | Doing | 有 | 1（本筆） | any | 啟動 member session | 任務 3 步驟 4 |
| S7 Review 待驗收 | yes | no | review | Review | 有 | any | any | Owner acceptance 優先於新派工 | 任務 3 步驟 1 |
| S8 unassigned Todo, 有可用 member | yes | no | — | Todo | 無 | 0 | any | Owner classify + dispatch | 任務 3 步驟 1 |
| S9 unassigned Todo, 全員滿載 | yes | no | — | Todo | 無 | 全部為 1 | any | 不指派，等待名額釋出 | WIP1 |
| S10 member 已有 WIP | yes | no | — | Todo | 有 | 1（他筆） | any | 不啟動第二筆 | WIP1 |
| S11 分類無法證明 | yes | no | — | Todo | any | any | any | classification fallback = `new-feature`，強制走 24 小時討論 | `validateOwnerClassification` |
| S12 主討論未到期且無變化 | yes | no | — | Todo | 無 | — | no | 零 Owner action | 任務 3 步驟 4 |
| S13 主討論已到期且證據齊備 | yes | no | — | Todo | 無 | — | any | 機械式結案，不呼叫 Owner AI | 任務 9 步驟 4 |
| S14 主討論已到期但缺 Owner 結論 | yes | no | — | Todo | 無 | — | any | Owner `conclude-discussion` action | 任務 5 步驟 3 |

## Member Session Outcome Decision Table

`progressed` 由 driver 事後檢查決定，process exit code 只供診斷。

| Case | 通過驗證的 task commit | focused verification PASS | driver 摘要留言 | Doing→Review readback | process exit | Outcome | `NP` | Covered by |
|---|---|---|---|---|---|---|---|---|
| M1 完整成功 | yes | yes | yes | yes | any | `progressed` | 歸零 | 任務 5 步驟 4 |
| M2 空轉 | no | no | no | no | `0` | `no_change` | `+1` | 任務 5 步驟 1 |
| M3 有 diff 但 exit 非零 | yes | yes | yes | yes | `1` | `progressed` | 歸零 | 任務 5 步驟 1 |
| M4 有 commit 無 Review readback | yes | yes | any | no | `0` | `no_change` | `+1` | 任務 5 步驟 1 |
| M5 verification 失敗 | yes | no | any | no | any | `no_change` | `+1` | 任務 5 步驟 4 |
| M6 重複 blocker 文字 | no | no | no | no | any | `no_change` | `+1` | 任務 5 步驟 1 |
| M7 Owner 嘗試編輯程式 | any | any | any | any | any | 拒絕該 Owner output，不算 `progressed` | 不變 | 任務 5 步驟 1 |
| M8 provider／network failure | any | any | any | any | any | `retryable_failure` | **不變** | 任務 3 步驟 4 |
| M9 `NP` 達 2 且 `OI=false` | — | — | — | — | — | enqueue 一次 Owner intervention | 保持 2 | 任務 5 步驟 5 |
| M10 `OI=true` 後再一次無進展 | — | — | — | — | — | `human_blocked` + 唯一去重 `@user09` 留言；board status／assignee 不變 | 凍結 | 任務 5 步驟 5 |

## Deployment Readback Decision Table

只在 acceptance sequence 通過、準備改動 master 時適用。`TGT` 為 merge SHA 或 revert SHA。

| Case | `.path` active | 改動前 service inactive | 觀察到新 `INV` | `INV` Result | 逾 `TO` | `DR == TGT` | `HR == TGT` | Expected result | Next step | Covered by |
|---|---|---|---|---|---|---|---|---|---|---|
| DP1 正常成功 | yes | yes | yes | success | no | yes | yes | 部署成功 | 進 completion | 任務 6 步驟 3 |
| DP2 path 未 active | no | any | — | — | — | — | — | 不動 master，本輪中止 | 記錄 operational error | 任務 6 步驟 1 |
| DP3 改動前 service 仍 active | yes | no | — | — | — | — | — | 不動 master，本輪中止 | 等既有 invocation 結束 | 任務 6 步驟 1 |
| DP4 invocation 明確失敗 | yes | yes | yes | failed | no | any | any | 該 generation 部署失敗 | 進 revert（DP8） | 任務 6 步驟 4 |
| DP5 rev 相符但 health 不符 | yes | yes | yes | success | no | yes | no | 部署失敗 | 進 revert | 任務 6 步驟 3 |
| DP6 逾時但已到位 | yes | yes | no | — | yes | yes | yes | 成功，標 `deployObservedOutOfBand=true` | 進 completion | 任務 6 步驟 1／5 |
| DP7 逾時、未到位、service 仍 active | yes | yes | no | — | yes | no | any | `DeploymentIndeterminate`；零 revert／零 status change／零 completion | 下一個 tick 以同一 `TGT` 重新 readback | 任務 6 步驟 5 |
| DP8 逾時、未到位、service 已 inactive | yes | yes | no | — | yes | no | any | 判定 `.path` 觸發遺漏 → 部署失敗 | 進 revert | 任務 6 步驟 5 |
| DP9 緩慢但成功 | yes | yes | yes | success | no（34 分鐘） | yes | yes | 成功，不得因 `pgrep` 等待被誤判 | 進 completion | 任務 6 步驟 1 |
| DP10 revert 成功 | yes | yes | yes | success | no | yes（revert SHA） | yes | rollback 成功；task 維持 Review + 去重 rollback comment | 該 task 不進 Done | 任務 6 步驟 4 |
| DP11 revert 明確失敗 | yes | yes | yes | failed | no | any | any | fatal coordinator error | 拒絕後續所有 AI／mutation | 任務 6 步驟 4 |
| DP12 revert indeterminate 一次 | yes | yes | no | — | yes | no | any | `DeploymentIndeterminate`，不升級 fatal | 下一個 tick 重試 | 任務 6 步驟 4 |
| DP13 revert indeterminate 連兩 tick | — | — | — | — | — | no | any | fatal coordinator error | 拒絕後續所有 AI／mutation | 任務 6 步驟 4 |
| DP14 operator 手動 start | yes | any | 非自己觀察 | success | any | yes | yes | 等同 DP6；coordinator 不主動 start | 下一 tick 以 `DR`／`HR` 認回 | 任務 6 步驟 5 |
| DP15 實作期 commit | yes | any | yes | success | — | yes | yes | 觸發一次 build+restart，**不走** acceptance sequence | 無 completion、無 task 變更 | 已確認的產品決策 |

## Completion Decision Table

| Case | 部署 readback | completion row 已持久化 | comment marker 已存在 | user09 notification readback | Expected result | Covered by |
|---|---|---|---|---|---|---|
| CP1 正常完成 | 成功 | yes | no | 相符 | POST 留言 → readback → PATCH Review→Done | 任務 7 步驟 3 |
| CP2 部署未過 | 失敗／indeterminate | — | — | — | 不改 task status、不留 completion comment | 任務 6 步驟 3 |
| CP3 marker 已存在 | 成功 | yes | yes | 相符 | 不重複發文，沿用既有 comment ID | 任務 7 步驟 1 |
| CP4 response 不確定 | 成功 | yes | unknown | — | 先列 comments 查 marker 再決定是否重送 | 任務 7 步驟 1 |
| CP5 notification 不相符 | 成功 | yes | yes | 不符／缺漏 | **不得** PATCH Done | 任務 7 步驟 3 |
| CP6 Done PATCH 失敗 | 成功 | yes | yes | 相符 | 不重複留言，下一 tick 以 completion row 續跑 | 任務 7 步驟 1 |
| CP7 Discord 第 1～3 次失敗 | 成功 | yes | yes | 相符 | 後兩個 tick 各重試一次；第 3 次後 `notify_failed` | 任務 7 步驟 4 |
| CP8 Discord 最終失敗 | 成功 | yes | yes | 相符 | task 保持 Done，不重跑 deploy、不重貼留言 | 任務 7 步驟 4 |

## End-To-End Task Outcome Table

把上表合併成 reviewer 可掃描的單筆 task 結果。

| Run | `P` | `Q` | `W(m)` | member outcome | deploy | notification | Final observable result | Covered by |
|---|---|---|---|---|---|---|---|---|
| E1 | yes | no | 0→1 | M1 | DP1 | CP1 | Done；一則 completion comment、一筆 user09 notification、一則 Discord batch | 任務 8 步驟 1 |
| E2 | yes | no | 0→1 | M1 | DP6 | CP1 | Done；標 `deployObservedOutOfBand=true` | 任務 6 步驟 1 |
| E3 | yes | no | 0→1 | M1 | DP7 | — | 留在 Review；零 revert；下一 tick 同 `TGT` 重試 | 任務 6 步驟 1 |
| E4 | yes | no | 0→1 | M1 | DP4→DP10 | — | 留在 Review；master 出現 revert commit；服務恢復健康 | 任務 6 步驟 4 |
| E5 | yes | no | 0→1 | M1 | DP4→DP11 | — | fatal；後續所有 AI／mutation 停止 | 任務 6 步驟 4 |
| E6 | yes | no | 0→1 | M2×2 → M9 | — | — | Owner intervention enqueued；task 狀態不變 | 任務 5 步驟 5 |
| E7 | yes | no | 0→1 | M9 → M2 → M10 | — | — | `human_blocked`；一則 `@user09` 留言；不占 WIP | 任務 5 步驟 5 |
| E8 | yes | no | 0→1 | M8×n | — | — | `retryable_failure`；`NP` 不變；下一 tick 重試 | 任務 3 步驟 4 |
| E9 | yes | yes | — | — | — | — | 零 action、零 lease、零 branch、零 AI call | 任務 2 步驟 1 |
| E10 | yes | no | 全員為 1 | — | — | — | 不指派；task 留在 Todo | WIP1 |
| E11 | no | any | any | — | — | — | `CutoverPrerequisiteMissing`；exit `2`；零 mutation | 任務 9 步驟 1 |
| E12 | any | any | any | — | — | — | `DiscoveryUnavailable`；exit `3`；零 mutation | 任務 8 步驟 3 |

## Idempotency And Safety Table

| Case | Expected externally observable result | Covered by |
|---|---|---|
| Coordinator 在 tick 中途重啟 | 從 SQLite checkpoint 接續，不重放已完成副作用 | 任務 2 步驟 5 |
| 相同 action key 重送 | 被 `action_log` 拒絕，副作用恰好一次 | 任務 2 步驟 1 |
| `--apply --live` 在狀態未變時重跑 | 零重複 comment／PATCH／branch／assignment／closure | 任務 9 步驟 1 情境 2 |
| Mutation response 不確定 | 先 readback 權威資源再決定重送，不盲目重試 | 任務 3 步驟 3 |
| 人工修改看板 task | 下一 tick 以 API readback 認回，`HB` 可被解除 | 任務 5 步驟 5 |
| Operator 手動 start autodeploy | `deployed_rev` 短路使其冪等；coordinator 以 `DR`／`HR` 認回 | 任務 6 步驟 5 |
| 舊 `sim/user02`～`sim/user06` 成果 | 只寫入 manifest；不得 merge／cherry-pick／apply／複製或放進 prompt | 任務 4 步驟 1、任務 9 步驟 4 |
| 新 worktree 初始狀態 | 初始 diff 必須為空 | 任務 4 步驟 1 |
| CI 結果快取 | 以 `base+head+commands` 為 key，只快取成功結果 | 任務 4 步驟 4 |
| user09 通知 | sim 永不代替 user09 標示已讀 | 任務 7 步驟 3 |
| 新舊 coordinator | 任何時點都不得同時執行；cutover 失敗即依既定順序復原 | 任務 11 步驟 3／6 |

## Intentionally Deferred

| Topic | Reason |
|---|---|
| `sim/run.ts` 的 deep／fast／scenario 模式 | 保留為實驗 harness，永遠不進入正式環境工作佇列 |
| 兩個固定 UUID 以外的 workspace | 第一版只凍結這兩個範圍，避免權限與資料面擴張 |
| Member 自行認領 task | 分類與指派永遠由 Owner 決定，移除認領制 |
| 新增 capability／persona／roster schema | 沿用 `MEMBER_RUNNERS` 既有靜態設定 |
| `pgrep sim/production.ts` 守衛 | 會與 coordinator 自己等待的 deploy 形成循環等待 |
| `.path` 觸發遺漏的自動偵測 | 第一版以 35 分鐘逾時決議 + operator 手動 start 逃生口涵蓋 |
| 舊 sweep 程式碼退役 | 移到任務 12，前置為兩個成功 live tick，確保任務 11 的復原路徑仍在 |
| 實作期 commit 的 acceptance sequence | 任務 2～12 的 commit 直接進 master 各觸發一次 build+restart，屬預期行為 |
| 未經明確人工授權的 live AI 與 timer 啟用 | 安全邊界，不因 build／安裝而放寬 |

## 本次模擬對照（未實際執行 sim）

`sim/production.*` 尚未實作，以下為依上表推導的紙上結果，輸入取自 2026-07-22 的實測狀態（`data/dev.db`、Git、systemd）。

實測環境：master／`deployed_rev`／`HR` 三者一致為 `9fb52e1`；`status=ok`、`db=true`；`sim-autodeploy.path` enabled + active；`sim-sweep-owner/team.timer` 仍 enabled；`sim/user02`～`sim/user06` 五條 branch 與 worktree 仍存在；`sim/task/*` 不存在。

| Task | 實測狀態 | 命中 case | 本輪結果 |
|---|---|---|---|
| `00123ef0` | Todo／unassigned／v1／4 comments | **P1 fail** → G6 → C1 | `CutoverPrerequisiteMissing`；零 mutation |
| `10e65231` | Todo／window due `2026-07-18`（已過期）／有 `【結論】`+`【實作任務】` | C2 | 零 action；資料上已具備結案條件，只被 `P` 擋住 |
| `938aa035` | Review／user06／v9 | C4 | 零 action |
| `6384b6f4` | Review／**user06**／v8 | C4（`P` 未過，尚未進入 C6） | 零 action；目前與 `938aa035` 同屬 user06，即文件所述 WIP1 衝突來源 |
| `027c0052` | Todo／unassigned／v1 | C8 | 零 action；即使 `P` 通過仍因 `DEP=false` 維持 `Q` |
| `27ec8d7e` | Todo／`[規則] 主工作區協作與交接` | C11 | excluded |
| `8be538bc` | Todo／canonical `[討論] 方向與下一步`／29 comments | C12 | excluded |

**Tick 結果：** 命中 **G6 / E11** — discovery 完整（G1 的前四項實測皆滿足），但 `P` 不成立。planned mutation = 0、AI call = 0、branch = 0、deploy = 0，**exit `2`**。任務 11 步驟 1 的 no-live gate 不通過，不得安裝 unit、不得進 live。

**關鍵路徑：** 任務 1 → `00123ef0` 走完 P1～P8 → cutover 解鎖 → C3 結案 `10e65231` → C5 啟動 `938aa035` → 其 Done 後 `DEP=true` → C7／C9 依序釋出 `6384b6f4` 與 `027c0052`。無可平行捷徑。

**已由實測支持的假設：** `10e65231` 的歷史 request 為 `【全員回覆：2天】`／`wait_half_days=4`，legacy 唯讀 parser 對它成立；且該 task 已具備 Owner `【結論】`（rowid 811）與 `【實作任務】`（rowid 812），C3 的機械式結案前提為真。

**尚未被覆蓋的假設（Open）：** DP6／DP7／DP8 三條逾時決議與 DP14 人工逃生口目前只有計畫層規範，尚無任何 fixture；`.path` 在「merge 後緊接 revert」密集情境下的觸發可靠度未經壓力測試。
