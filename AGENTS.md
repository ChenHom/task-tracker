# AGENTS

## Start Here

This repo has no framework-specific agent bootstrap. Read in this order:

1. This file for the always-on rules and route map.
2. [docs/agents/reference.md](docs/agents/reference.md) for where longer docs live.
3. [docs/tasks/current.md](docs/tasks/current.md) for current shipped state and open follow-up work.
4. [docs/operations.md](docs/operations.md) for deployment, health checks, main-workspace policy, and sim operations.
5. [design.md](design.md) when you need the single design baseline.

## Core Rules

- Stay in the target task scope. Do not slip in unrelated refactors.
- Default verification is `npx tsc --noEmit` plus the directly related `npx tsx src/<file>.test.ts`.
- Do not run `npm run sim` or any `sim --sweep` command unless a human explicitly authorizes a live AI run.
- For deployed-service work, treat `task-tracker.service` as the source of truth and verify with `/api/health`.
- Main-workspace discussion stays in `11a82028-fc50-466a-a723-e002032cd9a6`; implementation work belongs in the target workspace/repo.

## Task State Machine

- Normal flow: `Todo -> Doing -> Review -> Done`
- One-step rollback is allowed between adjacent states.
- `Archived` is a separate archive flow, not a normal forward status.
- When driving the HTTP API, patch one field at a time.

## API Rules

- Auth is cookie-based. `POST /api/auth/login` sets the session cookie; protected routes return `401` when `requireAuth` fails.
- Workspace-scoped routes use `requirePermission`; frontend visibility is not the authority.
- Mutating routes follow the existing command-error mapping: domain validation errors surface as `400`, permission failures as `401/403`, missing entities as `404` where implemented.

## Route Map

| Area | Routes |
| --- | --- |
| Health/Auth | `GET /api/health`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/forgot-password`, `POST /api/auth/reset-password` |
| Workspaces | `GET/POST /api/workspaces`, `PATCH /api/workspaces/:id`, `POST /api/workspaces/:id/archive`, `POST /api/workspaces/:id/delete` |
| Members | `GET/POST /api/workspaces/:id/members`, `POST /api/workspaces/:id/members/join`, `PATCH/DELETE /api/workspaces/:id/members/:userId` |
| Tasks | `GET/POST /api/workspaces/:id/tasks`, `GET/PATCH/DELETE /api/tasks/:id`, `POST /api/tasks/:id/archive`, `POST /api/tasks/:id/move` |
| Notifications | `GET /api/notifications`, `POST /api/notifications/:id/read` |
| Projects | `GET/POST /api/workspaces/:id/projects`, `PATCH/DELETE /api/projects/:id` |
| Collaboration | `GET/POST /api/tasks/:id/comments`, `PATCH/DELETE /api/comments/:id`, `GET/POST /api/tasks/:id/attachments`, `GET/DELETE /api/attachments/:id` |
| Read APIs | `GET /api/search`, `GET /api/audit`, `GET /api/quota`, `GET /api/users/search` |

## Where Details Live

- Long-form doc map: [docs/agents/reference.md](docs/agents/reference.md)
- Deployment and systemd procedures: [docs/operations.md](docs/operations.md), [deploy/README.md](deploy/README.md)
- Current implementation status and follow-up backlog: [docs/tasks/current.md](docs/tasks/current.md)
- Single design baseline: [design.md](design.md)
- Historical phase buildout: [docs/tasks/history.md](docs/tasks/history.md)
