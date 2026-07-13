# Agent Reference

This is the long-form companion to [AGENTS.md](../../AGENTS.md). `AGENTS.md` stays short and should be enough to start work; use this file to decide which deeper document to open next.

## What To Read For Which Job

| Need | Read |
| --- | --- |
| Current shipped state, verified rollout notes, and remaining backlog | [docs/tasks/current.md](../tasks/current.md) |
| HTTP API endpoint contracts | [docs/api.md](../api.md) |
| Single design baseline and current architecture | [design.md](../../design.md) |
| Deployment, systemd, `/api/health`, logs, main-workspace policy, sim operations | [docs/operations.md](../operations.md) |
| Quick deploy/unit-file reminder | [deploy/README.md](../../deploy/README.md) |
| Historical phase buildout | [docs/tasks/history.md](../tasks/history.md) |

## Root Guide Versus Long Form

| Keep in `AGENTS.md` | Follow from docs |
| --- | --- |
| Safe defaults, state machine, auth/permission rules, route map | Deployment steps, log paths, timer operations, sweep recovery, rollout evidence |
| "Do not run live sim without approval" | Full sim harness command set and timer control |
| Which file to open next | Historical rationale and phase-by-phase project history |

## Document Map

### `docs/operations.md`

Open this when the task touches any of these:

- `task-tracker.service`, systemd reload/restart, nginx/upstream checks
- `/api/health` verification or rollout smoke
- Main-workspace governance and Commenter rules
- Sim harness manual runs, timers, review statuses, or lock recovery

### `docs/tasks/current.md`

Open this when you need:

- The current definition of done for shipped phases
- The latest known open items and rollout handoff notes
- Verified smoke evidence that should not be rediscovered from scratch

### `docs/api.md`

Open this when you need the request, authentication, response schema, permission boundary, or error mapping for any HTTP endpoint. It is the complete API reference for the routes implemented in `src/server.ts`.

### `design.md`

Open this when you need:

- The single current architecture baseline
- Why certain smaller-scope decisions were taken
- A quick rationale before changing auth, member, frontend, or password-reset behavior

### `docs/tasks/history.md`

Use this for legacy Phase 0-7 context and original build order. Prefer `docs/tasks/current.md` and `design.md` first.
