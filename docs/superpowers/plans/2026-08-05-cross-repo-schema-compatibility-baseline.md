# Cross-Repo Schema Compatibility Baseline

> **For agentic workers:** docs-only inventory baseline. This file records evidence gathered on 2026-08-05. Do not run git.

**Goal:** 盤點至少三個有持久化資料的 repo，分清楚哪些屬於低風險排除案例，哪些適合作為 schema 相容/部署邊界的隔離量測候選。

**Architecture:** 只把有正式 migration runner、持久化 schema、以及可說明 deployment overlap 的 repo 納入比較。單實例 SQLite、可重建資料、或只剩本機/臨時資料的服務，優先標成排除，而不是硬套 expand-and-contract。

**Tech Stack:** task-tracker 的 SQLite event/read model、file-exchange-station 的 SQLite migration runner、tw-stock-research-platform 的 PostgreSQL migration manager + docker-compose stateful services。

## Evidence Matrix

| Repo | DB / runner | Recoverability | Deployment overlap | Decision |
| --- | --- | --- | --- | --- |
| `task-tracker` | `src/schema.ts` 以 `runMigrations()` 在 startup 做 idempotent `CREATE TABLE IF NOT EXISTS` + 少量 `ALTER TABLE ADD COLUMN`；檔頭已明講「換成正式 migration 工具，等 schema 開始需要改欄位/回滾再說」。 | 單一 event store + read model；有 user-level systemd 與 `sim-autodeploy` readback，但 schema 本身仍是 startup-driven，沒有獨立 migration 平台。 | `docs/operations.md` 顯示是單一 user-level systemd unit，`Restart=always`，`reload` 只送 HUP，不是 rolling/blue-green。 | 低風險排除案例。 |
| `file-exchange-station` | `src/db/migrate.ts` 以 `schema_migrations` table + transaction 跑 `src/db/schema.ts` 裡的 migration array；`src/db/schema.ts` 已把舊 MySQL ALTER 鏈合併成 SQLite DDL。 | `docs/db-migration-mysql-to-sqlite.md` 明寫「沒有舊資料保留」，TiDB stack 已移除，新 SQLite 從空開始。 | 同文件也記了 systemd user unit `file-exchange.service`，但這是單實例 local-first 服務，資料本身又是臨時交換站。 | 低風險排除案例。 |
| `tw-stock-research-platform` | `src/app/migrate.ts` 透過 `MigrationManager` 套用 `database/migrations/*.sql`；`package.json` 有 `db:up` / `db:clear` / `db:reset`。 | `MigrationManager.clear()` 會 drop public tables，`reset()` 會 clear + up；`src/app/utils/clear-research-data.ts` 只 TRUNCATE 研究派生表，表示資料可在 pipeline 內重建。 | `docker-compose.yml` 明確管理 Postgres 16 與 Redis 7，Postgres 用 volume 持久化；此 repo 的 schema 風險是真實存在的，且 migration path 是明確的。 | **選為隔離量測候選。** |

## Why the first two are exclusions

- `task-tracker` 的 schema 生命週期是 startup idempotent 建表 + 小量欄位補丁，不是正式 migration runner。
- `file-exchange-station` 雖然有 migration runner，但資料模型已經在一次性 MySQL/TiDB → SQLite 轉換中改成本機臨時資料；不存在需要跨版本共存的正式資料面。

## Why `tw-stock-research-platform` is the candidate

- 有完整的 SQL migration 管線，而不是只靠 startup 補表。
- 有持久化 PostgreSQL volume 與多個 migration 檔，schema 變更不是純理論。
- `db:clear` / `db:reset` 讓它適合在 staging 或隔離資料副本做量測，不必碰正式環境。
- `clearResearchData()` 顯示不少資料屬於研究派生結果，可在可控條件下重建。

## Notes

- `tw-stock-research-platform/docker-compose.yml` 目前還保留 `database/schema.sql` 的 init mount，但真正的 authoritative 路徑是 `src/app/migrate.ts` + `database/migrations/*.sql`。
- 這份 baseline 沒有新增任何 runtime code，也沒有修改正式資料或服務設定。

## Next Isolated Measurement

1. 以 `tw-stock-research-platform` 的 staging 或隔離 Postgres 複本做一次真實 migration run。
2. 量測單一 migration 的套用時間、是否需要先 clear、以及 rollback / roll-forward 邊界。
3. 驗證 `db:reset` 與 `db:up` 的順序是否足以重建 schema，並把可回查證據寫回 task comment。
