import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';
import { CommandError } from './eventStore';
import { createComment, listComments, updateComment, deleteComment, getCommentContext } from './comment';

const db = new DatabaseSync(':memory:');
runMigrations(db);

// task fixture（comment 依附 task；createComment / getCommentContext 都要它存在）。
db.prepare('INSERT INTO tasks_read_model (task_id, workspace_id, title, status, priority, version) VALUES (?, ?, ?, ?, ?, ?)')
  .run('t1', 'ws-1', 'T', 'Todo', 'Medium', 1);

// ── create → 進表，記錄作者 ──
const id = createComment('t1', 'alice', '  first comment  ', db);
let rows = listComments('t1', db);
assert.strictEqual(rows.length, 1);
assert.strictEqual(rows[0].content, 'first comment', 'content 應 trim');
assert.strictEqual(rows[0].user_id, 'alice', '記錄作者');

// ── context：拿到 workspace（權限）+ author（ownership）──
const ctx = getCommentContext(id, db)!;
assert.strictEqual(ctx.workspace_id, 'ws-1', 'context 經 task JOIN 取得 workspace');
assert.strictEqual(ctx.user_id, 'alice');
assert.strictEqual(ctx.task_id, 't1');

// ── update ──
updateComment(id, 'edited', db);
assert.strictEqual(listComments('t1', db)[0].content, 'edited');

// ── 輸入驗證 ──
assert.throws(() => createComment('t1', 'alice', '', db), CommandError, '空 content 應拒');
assert.throws(() => createComment('t1', 'alice', '   ', db), CommandError, '純空白 content 應拒');
assert.throws(() => createComment('t1', 'alice', 42 as unknown, db), CommandError, '非字串 content 應拒');
assert.throws(() => createComment('no-task', 'alice', 'x', db), CommandError, '不存在的 task 不可留言');
assert.throws(() => updateComment('no-such', 'x', db), CommandError, 'update 不存在的 comment 應拒');
assert.throws(() => deleteComment('no-such', db), CommandError, 'delete 不存在的 comment 應拒');

// ── listComments 只回該 task ──
db.prepare('INSERT INTO tasks_read_model (task_id, workspace_id, title, status, priority, version) VALUES (?, ?, ?, ?, ?, ?)')
  .run('t2', 'ws-1', 'T2', 'Todo', 'Medium', 1);
createComment('t2', 'bob', 'other task', db);
assert.ok(listComments('t1', db).every((c) => c.task_id === 't1'), 'listComments 只回指定 task');

const fixedCommentId = createComment(
  't2',
  'bob',
  'fixed time',
  db,
  new Date('2026-07-14T09:00:00.000Z'),
);
assert.strictEqual(
  getCommentContext(fixedCommentId, db)?.task_id,
  't2',
  '既有一般留言流程仍可使用同一 API',
);
assert.strictEqual(
  listComments('t2', db).find((row) => row.comment_id === fixedCommentId)?.created_at,
  '2026-07-14T09:00:00.000Z',
);

// ── delete → 移除、context 變 null ──
deleteComment(id, db);
assert.strictEqual(listComments('t1', db).length, 0);
assert.strictEqual(getCommentContext(id, db), null, 'deleted comment 查不到 context（→ 404）');

console.log('comment.test.ts OK');
