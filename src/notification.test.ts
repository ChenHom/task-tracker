import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';
import { resetProjections, CommandError } from './eventStore';
import { createComment } from './comment';
import { listNotifications, markNotificationRead, registerNotificationProjections } from './notification';

const db = new DatabaseSync(':memory:');
runMigrations(db);
resetProjections();
registerNotificationProjections();

db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run('alice', 'alice@test.local', 'Alice', 'x');
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run('bob', 'bob@test.local', 'Bob', 'x');
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run('carol', 'carol@test.local', 'Carol', 'x');
db.prepare('INSERT INTO workspaces_read_model (workspace_id, name, status, created_at) VALUES (?, ?, ?, ?)')
  .run('ws-1', 'ws-1', 'active', '2026-07-12T00:00:00.000Z');
db.prepare('INSERT INTO tasks_read_model (task_id, workspace_id, title, status, priority, version) VALUES (?, ?, ?, ?, ?, ?)')
  .run('task-1', 'ws-1', 'Task 1', 'Todo', 'Medium', 1);

const comment1 = createComment('task-1', 'alice', 'Hi @Bob, @missing, @Bob, @Alice', db);
let bobRows = listNotifications('bob', db);
assert.strictEqual(bobRows.length, 1, '同留言重複 mention 同一人只應發一筆');
assert.strictEqual(bobRows[0].recipient_id, 'bob');
assert.strictEqual(bobRows[0].source_task_id, 'task-1');
assert.strictEqual(bobRows[0].source_comment_id, comment1);
assert.strictEqual(bobRows[0].read_at, null, '新通知預設未讀');
assert.strictEqual(listNotifications('alice', db).length, 0, '@ 自己不應收到通知');

const comment2 = createComment('task-1', 'carol', 'Reply to @Bob and again @Bob', db);
assert.strictEqual(comment2.length > 0, true);
bobRows = listNotifications('bob', db);
assert.strictEqual(bobRows.length, 2, '第二次 mention 應再新增一筆通知');

markNotificationRead('bob', bobRows[1].notification_id, db);
bobRows = listNotifications('bob', db);
assert.strictEqual(bobRows[0].read_at, null, '未讀應排序在前');
assert.ok(bobRows[1].read_at, '已讀通知應有 read_at');

assert.throws(() => markNotificationRead('alice', bobRows[1].notification_id, db), CommandError, '不能讀別人的通知');

console.log('notification.test.ts OK');
