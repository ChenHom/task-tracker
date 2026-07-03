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
  `);
}
