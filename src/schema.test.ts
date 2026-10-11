import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';

const db = new DatabaseSync(':memory:');
runMigrations(db);

assert.throws(
  () => db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run('missing-name', 'missing@b.com', 'hash'),
  /NOT NULL/,
  'name 必填',
);

const insert = db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)');
insert.run('u1', 'a@b.com', '小明', 'hash');

// UNIQUE email 約束必須擋掉重複註冊
assert.throws(() => insert.run('u2', 'a@b.com', '小華', 'hash2'), /UNIQUE/);

// created_at 自動填入
const row = db.prepare("SELECT created_at FROM users WHERE id = 'u1'").get() as { created_at: string };
assert.ok(row.created_at, 'created_at should be auto-filled');

// 主討論等待窗口已移除：migration 必須把既有資料庫殘留的舊表一併丟掉。
db.exec(`
  CREATE TABLE main_discussion_windows (
    task_id                  TEXT PRIMARY KEY,
    owner_thought_comment_id TEXT NOT NULL,
    request_comment_id       TEXT NOT NULL UNIQUE,
    opened_at                TEXT NOT NULL,
    wait_half_days           INTEGER NOT NULL,
    due_at                   TEXT NOT NULL
  )
`);
runMigrations(db);
assert.strictEqual(
  (db.prepare(
    "SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table' AND name = 'main_discussion_windows'",
  ).get() as { c: number }).c,
  0,
  'migration 必須丟棄既有資料庫殘留的 main_discussion_windows',
);

const legacy = new DatabaseSync(':memory:');
legacy.exec(`
  CREATE TABLE projects_read_model (
    project_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL
  );
  INSERT INTO projects_read_model (project_id, workspace_id, name) VALUES ('legacy-project', 'legacy-ws', 'Legacy');
`);
runMigrations(legacy);
const migratedProject = legacy.prepare('SELECT * FROM projects_read_model WHERE project_id = ?').get('legacy-project') as Record<string, unknown>;
assert.strictEqual(migratedProject.description, '', 'legacy Project description 應回填空字串');
assert.strictEqual(migratedProject.status, 'active', 'legacy Project 應保持 active');
assert.strictEqual(migratedProject.target_repo, null, 'legacy Project 不可猜測 target repo');
assert.ok(migratedProject.created_at, 'legacy Project 應回填 created_at');
assert.ok(migratedProject.updated_at, 'legacy Project 應回填 updated_at');

console.log('schema.test.ts OK');
