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

const insertWindow = db.prepare(`
  INSERT INTO main_discussion_windows
    (task_id, owner_thought_comment_id, request_comment_id, opened_at, wait_half_days, due_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

insertWindow.run(
  'task-1',
  'thought-1',
  'request-1',
  '2026-07-14T00:00:00.000Z',
  4,
  '2026-07-16T00:00:00.000Z',
);

assert.throws(
  () => insertWindow.run('task-1', 'thought-2', 'request-2', '2026-07-14T00:00:00.000Z', 4, '2026-07-16T00:00:00.000Z'),
  /UNIQUE/,
  '同一 task 不可重開窗口',
);
assert.throws(
  () => insertWindow.run('task-2', 'thought-2', 'request-1', '2026-07-14T00:00:00.000Z', 4, '2026-07-16T00:00:00.000Z'),
  /UNIQUE/,
  '同一通知留言不可對應多個窗口',
);
assert.throws(
  () => insertWindow.run('task-3', 'thought-3', 'request-3', '2026-07-14T00:00:00.000Z', 3, '2026-07-16T00:00:00.000Z'),
  /CHECK/,
  '最短只能是 4 個 half-days',
);
assert.throws(
  () => insertWindow.run('task-4', 'thought-4', 'request-4', '2026-07-14T00:00:00.000Z', 15, '2026-07-16T00:00:00.000Z'),
  /CHECK/,
  '最長只能是 14 個 half-days',
);

console.log('schema.test.ts OK');
