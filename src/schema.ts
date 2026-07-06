import type { DatabaseSync } from 'node:sqlite';

// ponytail: idempotent CREATE TABLE IF NOT EXISTS, run at startup.
// 換成正式 migration 工具，等 schema 開始需要「改欄位/回滾」再說。
export function runMigrations(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON;'); // 每個連線都要開，否則 FK / CASCADE 無效
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL CHECK (trim(name) <> ''),
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    -- 登入嘗試紀錄（成功/失敗都記）。email 記「嘗試的」值，可能對不到任何 user。
    -- user_id 用 SET NULL：user 被刪也保留審計軌跡。
    CREATE TABLE IF NOT EXISTS login_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      email      TEXT NOT NULL,
      user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
      success    INTEGER NOT NULL,
      ip         TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 單一 event store（Workspace / Member / Task 全進這張）。
    -- UNIQUE(aggregate_id, aggregate_version)：樂觀鎖的 DB 層防線，同一版本只能寫一次。
    CREATE TABLE IF NOT EXISTS event_store (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      aggregate_type    TEXT NOT NULL,
      aggregate_id      TEXT NOT NULL,
      aggregate_version INTEGER NOT NULL,
      event_type        TEXT NOT NULL,
      payload_json      TEXT NOT NULL,
      metadata_json     TEXT NOT NULL,
      occurred_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (aggregate_id, aggregate_version)
    );

    -- Read model：由 workspace.* 事件投影而來，查詢只讀這張、不碰 event_store。
    CREATE TABLE IF NOT EXISTS workspaces_read_model (
      workspace_id TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      status       TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );

    -- 權限來源：所有角色檢查都查這張。只放「已 joined」的成員（invited 未接受不進來）。
    CREATE TABLE IF NOT EXISTS workspace_members_read_model (
      workspace_id TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      role         TEXT NOT NULL,
      joined_at    TEXT NOT NULL,
      PRIMARY KEY (workspace_id, user_id)
    );

    -- Task read model：由 task.* 事件投影。version 供樂觀鎖 / UI 顯示。deleted 事件直接移除該列。
    CREATE TABLE IF NOT EXISTS tasks_read_model (
      task_id     TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id  TEXT,
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL,
      priority    TEXT NOT NULL,
      assignee_id TEXT,
      due_at      TEXT,
      version     INTEGER NOT NULL,
      updated_at  TEXT
    );

    -- Project：DESIGN 指定不走 ES，這張就是主表（傳統 CRUD 直接讀寫，無 event_store / projection）。
    CREATE TABLE IF NOT EXISTS projects_read_model (
      project_id   TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name         TEXT NOT NULL
    );

    -- Comment：任務留言，同樣傳統 CRUD（不走 ES）。權限經 task → workspace 查；user_id 為留言作者。
    CREATE TABLE IF NOT EXISTS comments (
      comment_id TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ''
    );

    -- Attachment：metadata 進 DB，實體檔在 data/attachments/。original_name 只供顯示（不信任、不當路徑）；
    -- stored_name 是伺服器生成的 uuid，才是磁碟上的真檔名。
    CREATE TABLE IF NOT EXISTS attachments (
      attachment_id TEXT PRIMARY KEY,
      task_id       TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_name   TEXT NOT NULL,
      mime_type     TEXT NOT NULL,
      size          INTEGER NOT NULL
    );

    -- 忘記密碼：token 本身不落地存明碼，只存 SHA-256 hex digest（token 是高熵隨機值，
    -- 用快速雜湊即可做等值查找；跟 password_hash 用 scrypt 是不同考量，見 auth.ts 註解）。
    -- used_at 為 NULL 代表尚未使用；一次性使用，用過就標記，不可重放。
    CREATE TABLE IF NOT EXISTS password_resets (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at    TEXT
    );
  `);

  try {
    db.prepare('ALTER TABLE tasks_read_model ADD COLUMN updated_at TEXT').run();
  } catch {
    // 忽略如果欄位已存在
  }

  try {
    db.prepare("ALTER TABLE comments ADD COLUMN created_at TEXT NOT NULL DEFAULT ''").run();
  } catch {
    // 忽略如果欄位已存在
  }

  try {
    db.prepare("ALTER TABLE users ADD COLUMN name TEXT NOT NULL DEFAULT '未命名'").run();
  } catch {
    // 忽略如果欄位已存在
  }
}
