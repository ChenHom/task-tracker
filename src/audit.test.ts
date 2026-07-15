import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';
import { resetProjections } from './eventStore';
import { registerWorkspaceProjections, createWorkspace, archiveWorkspace } from './workspace';
import { registerMemberProjections } from './member';
import { registerTaskProjections, createTask, changeTaskAssignee, changeTaskStatus } from './task';
import { runWithRequestContext } from './requestContext';
import { getAggregateWorkspace, getAuditTrail } from './audit';

const db = new DatabaseSync(':memory:');
runMigrations(db);
resetProjections();
registerWorkspaceProjections();
registerMemberProjections();
registerTaskProjections();

// ── metadata：HTTP context 下 append，audit 欄位應完整填入 ──
let wsId = '';
runWithRequestContext({ ip: '1.2.3.4', userAgent: 'curl/8', requestId: 'req-abc' }, () => {
  wsId = createWorkspace('alice', 'W', db);
});
const wsTrail = getAuditTrail(wsId, db);
assert.strictEqual(wsTrail[0].event_type, 'workspace.created');
assert.deepStrictEqual(
  wsTrail[0].metadata,
  { actor_id: 'alice', ip: '1.2.3.4', user_agent: 'curl/8', request_id: 'req-abc' },
  'context 下的 append 應記完整 audit metadata',
);

// ── audit trail：依序記錄「誰、改了什麼」──
let taskId = '';
runWithRequestContext({ ip: '5.6.7.8', userAgent: 'app', requestId: 'req-2' }, () => {
  taskId = createTask('bob', wsId, { title: 'T' }, db);
  changeTaskAssignee('bob', taskId, 'alice', db);
  changeTaskStatus('bob', taskId, 'Doing', db);
});
const taskTrail = getAuditTrail(taskId, db);
assert.deepStrictEqual(
  taskTrail.map((e) => e.event_type),
  ['task.created', 'task.assignee_changed', 'task.status_changed'],
  'audit trail 依版本序完整',
);
assert.strictEqual((taskTrail[2].metadata as { actor_id: string }).actor_id, 'bob', '記錄操作者');

// ── getAggregateWorkspace：三種 aggregate 都能推回 workspace（授權用）──
assert.strictEqual(getAggregateWorkspace(wsId, db), wsId, 'Workspace aggregate → 自身 id');
assert.strictEqual(getAggregateWorkspace(taskId, db), wsId, 'Task aggregate → payload.workspaceId');
assert.strictEqual(getAggregateWorkspace(`${wsId}:alice`, db), wsId, 'Member aggregate → 拆 workspace:user'); // seedOwner 產生
assert.strictEqual(getAggregateWorkspace('no-such', db), null, '不存在的 aggregate → null');

// ── event_store 即 audit log：archive 也留痕，不需另建 activity_logs ──
archiveWorkspace('alice', wsId, db);
assert.ok(
  getAuditTrail(wsId, db).some((e) => e.event_type === 'workspace.archived'),
  'archive 操作在 event_store 留下審計軌跡',
);

console.log('audit.test.ts OK');
