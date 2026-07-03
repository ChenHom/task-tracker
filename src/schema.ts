import type { DatabaseSync } from 'node:sqlite';

// ponytail: idempotent CREATE TABLE IF NOT EXISTS, run at startup.
// 換成正式 migration 工具，等 schema 開始需要「改欄位/回滾」再說。
export function runMigrations(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON;'); // 每個連線都要開，否則 FK / CASCADE 無效
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
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
  `);
}
