# Task Tracker

A full-featured task management system built from scratch with **Event Sourcing**, **CQRS**, and **RBAC** — designed as a hands-on engineering exercise covering real-world backend patterns and OWASP security practices.

> **This is not a Jira/Trello clone.** It's a deliberately architected system for practicing event-driven design, state machines, audit trails, and role-based access control.

## ✨ Features

### Core Architecture
- **Event Sourcing** — Workspace, Member, and Task aggregates store all state changes as immutable events
- **CQRS** — Commands write to the event store; queries read from projected read models
- **Optimistic Locking** — DB-level unique constraint on `(aggregate_id, aggregate_version)` prevents write conflicts

### Task Management
- **Kanban Board** — Visual board with Todo → Doing → Review → Done state machine (one-step rollback allowed)
- **Rich Collaboration** — `@mention` members, `#N` comment references with smooth scroll, `::shortId` cross-task links
- **Projects** — Group tasks within workspaces
- **Attachments** — File upload/download with path traversal protection
- **Search** — Workspace-scoped full-text search

### Access Control (RBAC)
- **5-tier Role Hierarchy**: `Owner > Admin > Member > Commenter > Viewer`
- **Workspace-scoped Permissions** — `requirePermission` is the single source of truth; frontend only adapts UI
- **Commenter Role** — Can create discussion tasks and comments, edit own task descriptions; cannot modify others' tasks or project settings

### Security (OWASP Top 10)
- `scrypt` password hashing with prepared statements (no SQL injection)
- Cookie-based sessions with `SameSite=Strict` + Origin-check CSRF protection
- Rate limiting on login and forgot-password endpoints
- `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff` on downloads
- All user input rendered via `textContent` (no `innerHTML` with user data)
- Static file and attachment path traversal / symlink boundary guards
- Audit trail with `actor_id`, `ip`, `user_agent`, `request_id` metadata

### AI Simulation Harness
- Multi-model AI fleet (Claude, Codex, Antigravity) simulating real users
- Dogfooding the system with automated task creation, discussion, and review workflows

## 🏗️ Architecture

```
User → Command → Permission Check → Aggregate → Event Store → Projection → Read Model
```

| Layer | Description |
|---|---|
| **Command** | Validates and applies business rules |
| **Event Store** | Single append-only table for all aggregates |
| **Projection** | Synchronously updates read models on each event |
| **Read Model** | Flat tables optimized for queries |

### Event-Sourced Aggregates

| Aggregate | Events |
|---|---|
| **Workspace** | `created`, `renamed`, `archived`, `deleted` |
| **Member** | `invited`, `joined`, `role_changed`, `removed` |
| **Task** | `created`, `title_changed`, `description_changed`, `status_changed`, `priority_changed`, `assignee_changed`, `due_date_changed`, `archived`, `deleted`, `moved`, `main_discussion_concluded` |

## 🛠️ Tech Stack

| Component | Technology |
|---|---|
| Runtime | Node.js (native `node:http`, `node:sqlite`) |
| Language | TypeScript (strict mode) |
| Database | SQLite (embedded, zero-config) |
| Frontend | Vanilla JS SPA with hash routing (no framework) |
| Build | `tsc` for type checking, `tsx` for dev server |

**Zero external runtime dependencies** — only `devDependencies` for TypeScript tooling.

## 🚀 Getting Started

### Prerequisites

- **Node.js** ≥ 22.x (uses native `node:sqlite`)

### Setup

```bash
# Clone the repository
git clone https://github.com/ChenHom/task-tracker.git
cd task-tracker

# Install dev dependencies
npm install

# Seed test users (user01~user30@test.local, password: test1234)
npm run seed

# Start development server
npm run dev
```

The app will be available at `http://localhost:3000`.

### Login

Use any seeded test account:
- **Email**: `user01@test.local` ~ `user30@test.local`
- **Password**: `test1234`

### Available Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled production server |
| `npm run seed` | Create/reset test users (idempotent) |
| `npm run typecheck` | Run `tsc --noEmit` on all source |
| `npm test` | Lint + typecheck + unit tests + sim tests |

## 📡 API Reference

### Auth
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/auth/login` | Login (sets session cookie) |
| `POST` | `/api/auth/logout` | Logout |
| `GET` | `/api/auth/me` | Current user info |
| `POST` | `/api/auth/forgot-password` | Request password reset |
| `POST` | `/api/auth/reset-password` | Reset password with token |

### Workspaces
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/workspaces` | List user's workspaces |
| `POST` | `/api/workspaces` | Create workspace |
| `PATCH` | `/api/workspaces/:id` | Rename workspace (Admin+) |
| `POST` | `/api/workspaces/:id/archive` | Archive workspace |
| `POST` | `/api/workspaces/:id/delete` | Delete workspace |

### Members
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/workspaces/:id/members` | List members |
| `POST` | `/api/workspaces/:id/members` | Invite member (Admin+) |
| `POST` | `/api/workspaces/:id/members/join` | Accept invitation |
| `PATCH` | `/api/workspaces/:id/members/:userId` | Change role (Admin+) |
| `DELETE` | `/api/workspaces/:id/members/:userId` | Remove member (Admin+) |

### Tasks
| Method | Endpoint | Description |
|---|---|---|
| `GET/POST` | `/api/workspaces/:id/tasks` | List / Create tasks |
| `GET/PATCH/DELETE` | `/api/tasks/:id` | Read / Update / Delete task |
| `POST` | `/api/tasks/:id/archive` | Archive task |
| `POST` | `/api/tasks/:id/move` | Move task across workspaces |

### Collaboration
| Method | Endpoint | Description |
|---|---|---|
| `GET/POST` | `/api/tasks/:id/comments` | List / Create comments |
| `PATCH` | `/api/comments/:id` | Edit own comment |
| `DELETE` | `/api/comments/:id` | ~~Delete~~ → 405 (comments are immutable) |
| `GET/POST` | `/api/tasks/:id/attachments` | List / Upload attachments |
| `GET/DELETE` | `/api/attachments/:id` | Download / Delete attachment |

### Utilities
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/search?workspace=:id&q=...` | Workspace-scoped search |
| `GET` | `/api/audit?aggregate_id=...` | Audit trail (Admin+) |
| `GET` | `/api/quota` | AI quota dashboard |
| `GET` | `/api/notifications` | List notifications |
| `POST` | `/api/notifications/:id/read` | Mark notification as read |
| `GET` | `/api/users/search?q=...` | Search users by email |

## 📁 Project Structure

```
task-tracker/
├── src/                    # Backend source (TypeScript)
│   ├── server.ts           # HTTP server & route handler
│   ├── eventStore.ts       # Event sourcing core
│   ├── schema.ts           # SQLite schema & migrations
│   ├── auth.ts             # Authentication & sessions
│   ├── workspace.ts        # Workspace aggregate
│   ├── member.ts           # Member aggregate & RBAC
│   ├── task.ts             # Task aggregate & state machine
│   ├── comment.ts          # Comment CRUD
│   ├── attachment.ts       # File attachment handling
│   ├── notification.ts     # Notification system
│   ├── search.ts           # Full-text search
│   ├── audit.ts            # Audit trail queries
│   ├── mainDiscussion.ts   # Main workspace governance
│   └── *.test.ts           # Co-located unit tests
├── public/                 # Frontend (vanilla JS SPA)
│   ├── index.html          # Single page entry
│   ├── app.js              # Application bootstrap
│   ├── js/                 # Modules (router, state, views)
│   └── css/                # Stylesheets
├── sim/                    # AI simulation harness
├── deploy/                 # Deployment configs (systemd)
├── docs/                   # Design docs & task history
├── design.md               # Single design baseline
└── data/                   # SQLite database (gitignored)
```

## 📝 License

This project is for educational and portfolio purposes.
