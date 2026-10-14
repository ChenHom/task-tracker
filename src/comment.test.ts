import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';
import { CommandError } from './eventStore';
import { createComment, listComments, updateComment, getCommentContext } from './comment';

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

// 只有 human 對 Goal Task 的明確 @Owner 會建立一次 heartbeat；編輯不重送。
db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES ('human-user09', 'user09@test.local', '老闆', 'hash')").run();
const humanUser09 = (db.prepare("SELECT id FROM users WHERE email = 'user09@test.local'").get() as { id: string }).id;
db.prepare(`INSERT INTO goals_read_model
  (goal_id, workspace_id, project_id, source, objective, success_criteria, status, revision,
   created_by, owner_agent_id, evidence_refs_json, version, created_at, updated_at)
  VALUES ('g1', 'ws-1', 'p1', 'human', 'x', 'y', 'Executing', 1, ?, 'owner-a', '[]', 1, 't', 't')`).run(humanUser09);
db.prepare(`INSERT INTO agents
  (agent_id, user_id, email, name, role, skill_profile_json, primary_adapter, primary_model, status, created_at, updated_at)
  VALUES ('owner-a', 'agent-user', 'owner@test', 'Owner', 'owner', '{}', 'claude', 'm', 'active', 't', 't')`).run();
db.prepare("UPDATE tasks_read_model SET goal_id = 'g1' WHERE task_id = 't1'").run();
const ownerMention = createComment('t1', humanUser09, '請 @Owner 判斷', db);
const ownerHeartbeatCount = () => (db.prepare("SELECT COUNT(*) AS n FROM goal_heartbeats WHERE phase = 'owner_comment'").get() as { n: number }).n;
assert.strictEqual(ownerHeartbeatCount(), 1);
updateComment(ownerMention, '請 @Owner 再判斷', db);
assert.strictEqual(ownerHeartbeatCount(), 1, '編輯不可再次喚醒');
createComment('t1', humanUser09, '沒有 mention，只供已啟動 Agent 讀取', db);
createComment('t1', 'agent-user', '@Owner Agent 自己的留言', db);
assert.strictEqual(ownerHeartbeatCount(), 1);
db.prepare("UPDATE goals_read_model SET status = 'Cancelled' WHERE goal_id = 'g1'").run();
createComment('t1', humanUser09, 'Cancelled 後 @Owner 不應再喚醒', db);
assert.strictEqual(ownerHeartbeatCount(), 1, '終態 Goal 留言不得建立 owner_comment heartbeat');
assert.strictEqual(
  listComments('t2', db).find((row) => row.comment_id === fixedCommentId)?.created_at,
  '2026-07-14T09:00:00.000Z',
);

// ── 合成字元 fixture：HTML/script 樣式內容應原樣存回，伺服器不做任何 escape/淨化 ──
// escaping 責任在前端 renderRichText（public/js/views/task-detail.js）的 textContent 路徑，
// 見 docs/frontend/dom-sink-inventory.md；這裡鎖定「伺服器只是原樣存取」的邊界，避免日後有人
// 誤以為伺服器已處理過而在前端改用 innerHTML。
const xssContent = '<script>alert(document.cookie)</script><img src=x onerror=alert(1)>';
const xssId = createComment('t1', 'alice', xssContent, db);
assert.strictEqual(
  listComments('t1', db).find((c) => c.comment_id === xssId)?.content,
  xssContent,
  '伺服器不應修改／跳脫留言內容',
);

console.log('comment.test.ts OK');
