# Fixed Sweep Workspace Design

## Goal

讓既有的「跨 repo 工程基線」workspace
`b2637f07-44b3-49b0-b2c4-4da4e19cd1ac` 進入 legacy Owner/Team sweep，並清楚區分它與 repo canonical workspace 的用途。

## Terminology and policy

`CANONICAL_WORKSPACE_BY_REPOROOT` 是 repo 對固定收件 workspace 的 mapping。它只回答「某個 repo 的跨 repo task 應送去哪個正式 workspace」，目前 task-tracker repo 對應 `d9da9945-ce5f-400f-806e-1d75e95e313a`。

固定 sweep workspace 是另一個 allowlist。它只回答「哪些既有 workspace 即使沒有 `sim-logs/*/report.json`，仍要被 legacy sweep 發現」。`b2637f07...` 是跨 repo 基線 workspace，沒有單一 repo，因此加入固定 sweep allowlist，不加入 canonical mapping。

## Runtime behavior

- 固定 sweep workspace 以 `workspaceId -> scenarioKey` 登記，`b2637f07...` 使用 `self-directed` scenario，沿用 task-tracker root 的既有 Owner/Team prompt 與 worktree 流程。
- 候選建立流程仍先檢查 workspace 是否 active；停用或不存在的 workspace 不會啟動 AI。
- 固定 sweep workspace 同時納入 managed roster，讓 sweep 可補齊 user02–user06 的 Member membership；Owner 先派工，Team 只處理已指派給 eligible runner 的 Todo/Doing。
- 不掃描所有 active workspace，也不補造 `report.json`，避免重新啟動歷史或已停止的 sprint。
- 不改 canonical routing：其他 repo 只有在需要固定收件 workspace 時才加入 canonical mapping；其他既有工作區要被 sweep 掃描時，加入固定 sweep allowlist。

## Verification

- Unit assertions prove `b2637f07...` is added by the fixed-candidate helper with `self-directed`, while the canonical mapping remains only the task-tracker repo mapping.
- Unit assertions prove the fixed workspace is treated as managed for roster reconciliation.
- Typecheck and `npm test` pass.
- The next scheduled Owner tick must log `b2637f07` as a pending workspace; after Owner writes `【OWNER派工】`, the next Team tick may run the assigned members.
