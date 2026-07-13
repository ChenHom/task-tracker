# 跨 Repo Workspace 路由：Canonical Workspace 機制與 451c2509 解套

**狀態：** 已實作並驗證（2026-07-10）
**觸發事件：** task `451c2509`（跨 workspace 搬移 task 功能請求）卡在錯誤 repoRoot 的 workspace 連續 9+ 輪巡檢、橫跨 32 小時。

**Goal：** 讓 AI Owner 在發現「這個 task 需要修改的原始碼不在目前 repoRoot」時，有一個查得到的固定去處、且被明確授權轉移，而不是原地卡住或丟進沒有下文的 `[ESCALATE]`。同時避免同一種死鎖在即將上線的主工作區（Commenter）設計裡重演。

**Architecture：** 沿用既有 `sim/run.ts` 單檔架構，只加純函式與 prompt 文字，不新增 schema、不新增 capability/handoff 資料表、不做成 JSON/DB registry——維護者永遠是人（比照 `SCENARIOS` 本身的維護方式），AI Owner session 本來就沒有檔案寫入權限。

---

## 背景與根因

`sim/run.ts` 把每個 workspace 的 scenario（進而決定 `repoRoot`：`self-directed`/`product-ideation` 綁 task-tracker 本體，`brain` 綁獨立沙盒 `/home/hom/code/brain`）**凍結在第一次 bootstrap 當下**（`writeReport`），之後 `sweep()` 只能爬 `sim-logs/*/report.json` 歷史猜最新，完全沒有「重新指定」的機制。

真人老闆（user09）在 workspace `11db3331`（scenario=brain）留言提出「跨 workspace 移動 task」的真實需求；AI Owner 查證後**明知這個功能要改的是 task-tracker 本體、不是 brain**（task description 裡自己寫了警語），卻還是把實作 task 建在同一個 brain-bound workspace 裡。

調查發現問題不在 AI 的判斷力（牠的判斷是對的），而在兩個結構性缺口：

1. 沒有一個牠查得到的「這個 repo 該送去哪個 workspace」的固定答案。
2. 既有的 `[ESCALATE]` 慣例終點是「留言上報後原地不動」，是死路，不是轉移路徑。

即將實作的主工作區設計（`docs/superpowers/plans/2026-07-10-commenter-main-workspace-implementation.md` Task 6）引入「主工作區＋user01 觸發建立目標 task」流程，但其 Step 4 對「決議後建立目標 task」完全沒有指定 target workspace 怎麼選——同一種死鎖會在那個新流程裡原封不動重演，只是觸發點換了地方。

## 決策

- Canonical workspace 沿用既有的 `d9da9945-ce5f-400f-806e-1d75e95e313a`（「健壯性強化：邊界檢查與資料一致性」，唯一有真實完成紀錄的 self-directed workspace：6 Done + 1 Archived）。另兩個候選 `465bfd2d`／`ca9c9bb7` 已查證為 0 task 的空殼，未採用。
- 一併補上主工作區實作計畫 Task 6 缺的 target-workspace 選擇邏輯，而非等它先上線再修。
- `451c2509` 的解套用人工轉移（複製內容＋留連結＋狀態轉 Done），不等 `moveTask`（Phase 13）真正做完——因為它卡住的位置本身就阻止它被實作，等於讓它在錯的地方繼續空轉。

---

## Task 1：`sim/run.ts` — Canonical Workspace 查表與 `[CROSS-REPO]` 路由

- [x] 新增 `CANONICAL_WORKSPACE_BY_REPOROOT`（純 TS const，只登記 task-tracker 本體一筆；brain 是沙盒不登記）
- [x] 新增 `canonicalWorkspaceForRepoRoot(repoRoot)` 查表函式
- [x] 新增 `ensureCanonicalWorkspaceCandidates(candidates)`，讓 canonical workspace 不因安靜太久從 `sweep()` 候選名單消失
- [x] 新增 `crossRepoRule(scenario)`，產生「先查有無登記收件 workspace → 有就轉移、沒有就留言待人工登記」的 prompt 文字
- [x] `API_RULES` 新增 `[CROSS-REPO]` 規則，與既有「留言上報後原地不動」的 `[ESCALATE]` 明確區分
- [x] 接進 `ownerOpenPrompt`（開新 sprint/開題）、`ownerMidPrompt`（中場審查，簽名補 `scenario` 參數）、`ownerSweepPrompt`（**真正的安全網**：451c2509 就是在這個 prompt 讀老闆留言、核准後開題那一步被建到錯的地方）
- [x] `memberPrompt` 補一句「第一次發現時用 `[CROSS-REPO]` 留言」的提示（member 不負責跨 workspace 建立 task，只需標記讓 owner 處理，故不接整段 `crossRepoRule`）
- [x] `sweep()` 在 report.json 掃描迴圈之後、`pendings` 建立之前呼叫 `ensureCanonicalWorkspaceCandidates(wsScenario)`
- [x] `sim/run.test.ts` 新增斷言（含一次對抗審查抓到並修正：原斷言拿 `canonicalWorkspaceForRepoRoot(ROOT)` 跟 `CANONICAL_WORKSPACE_BY_REPOROOT[ROOT]` 互比，是永遠成立的 tautology；改成對照字面 UUID）

**驗證輸出**（本次實跑）：
```
$ npx tsc --noEmit
(無輸出，exit 0)

$ node --import tsx sim/run.test.ts
[23:35:44] sim/run.test.ts OK
```

## Task 2：主工作區實作計畫同步補丁

- [x] `docs/superpowers/plans/2026-07-10-commenter-main-workspace-implementation.md` Task 6 Step 3：呼叫 `ensureMainWorkspaceCandidate(wsScenario)` 後補呼叫 `ensureCanonicalWorkspaceCandidates(wsScenario)`，讓兩個「不依賴 report.json 歷史」的候選收錄機制並存、不互相覆蓋
- [x] Task 6 Step 4：「建立目標 task」步驟前補上「先呼叫 `canonicalWorkspaceForRepoRoot(ROOT)` 取得登記的收件 workspace；有登記就用它，沒有登記才允許新建/另尋 workspace，並在討論留言註明『未登記，人工介入選定』」

## Task 3：`451c2509` 手動解套

- [x] 在 canonical workspace `d9da9945-ce5f-400f-806e-1d75e95e313a` 建立新 task `11983af5-07a9-490d-9086-47bf4e9df35a`，description 開頭附「來源：workspace 11db3331／task 451c2509」，完整規格照搬
- [x] 原 task `451c2509` 留言貼上新 task 連結，說明已轉移
- [x] 原 task 狀態 `Doing → Review → Done`（合法相鄰狀態機）
- [x] DB read-back 驗證：`451c2509` status=`Done`；`11983af5` 落在 `d9da9945`、status=`Todo`、priority=`High`

---

## 已知限制 / Deferred

- `moveTask`（Phase 13 正式功能，`POST /api/tasks/:id/move`）仍未實作——本次是複製＋留連結的權宜解法，不是用真正的搬移 API；`docs/tasks/current.md` 的 Phase 13 checklist 保留給後續真正開發，未打勾。
- `CANONICAL_WORKSPACE_BY_REPOROOT` 目前只登記 task-tracker 本體一筆，單向（沙盒 → 本體）；未來若真的出現第二種需要互轉的 repo，再加一行即可，成本比照新增一個 scenario。
- `sim-sweep-owner.timer`／`sim-sweep-team.timer` 目前仍是暫停狀態（使用者於本次會談稍早要求），待使用者確認後可 `systemctl --user enable --now` 恢復。
- 兩個空殼 self-directed workspace（`465bfd2d`、`ca9c9bb7`，皆 0 task）尚未清理，非必要但可選（減少未來人工判斷 canonical workspace 時的雜訊）。

## 相關檔案

- `sim/run.ts`
- `sim/run.test.ts`
- `docs/superpowers/plans/2026-07-10-commenter-main-workspace-implementation.md`
- `docs/tasks/current.md`（Phase 13 標頭已同步更新轉移紀錄）
