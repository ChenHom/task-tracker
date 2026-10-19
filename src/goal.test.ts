import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { appendEvent, resetProjections } from './eventStore';
import {
  acquireRepoLease,
  blockGoal,
  cancelGoal,
  completeGoal,
  createGoal,
  getGoal,
  applyPendingGoalPause,
  isGoalSafeCheckpoint,
  listGoals,
  pauseGoal,
  registerGoalProjections,
  resumeGoal,
  reviseGoal,
  reviseGoalDataScope,
  setDiscussionPhase,
  startDiscussion,
  startExecution,
  startVerification,
} from './goal';
import { archiveProject, getProject, updateProject } from './project';
import type { RepoRegistry } from './repoRegistry';
import { runMigrations } from './schema';
import { getTask, registerTaskProjections } from './task';
import { enqueueHeartbeat, finishRun, markRunRunning, prepareRun } from './goalRun';
import { registerNotificationProjections } from './notification';

const db = new DatabaseSync(':memory:');
runMigrations(db);
resetProjections();
registerGoalProjections();
registerTaskProjections();
registerNotificationProjections();

db.prepare('INSERT INTO workspaces_read_model (workspace_id, name, status, created_at) VALUES (?, ?, ?, ?)')
  .run('ws-1', 'Workspace', 'active', 't');
db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES ('owner-user', 'user01@test.local', 'Owner Agent', 'hash')").run();
db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES ('human-admin', 'admin@test.local', 'Human Admin', 'hash')").run();
db.prepare("INSERT INTO workspace_members_read_model VALUES ('ws-1', 'human-admin', 'Admin', 't')").run();
db.prepare("INSERT INTO workspace_members_read_model VALUES ('ws-1', 'owner-user', 'Owner', 't')").run();
db.prepare(`INSERT INTO agents
  (agent_id, user_id, email, name, role, skill_profile_json, primary_adapter, primary_model, status, created_at, updated_at)
  VALUES ('owner-agent', 'owner-user', 'owner@test.local', 'Owner', 'owner', '{}', 'claude', 'm', 'active', 't', 't')`).run();
db.prepare(`INSERT INTO agents
  (agent_id, user_id, email, name, role, skill_profile_json, primary_adapter, primary_model, status, created_at, updated_at)
  VALUES ('member-agent', 'member-user', 'member@test.local', 'Member', 'member', '{}', 'codex', 'm', 'active', 't', 't')`).run();
db.prepare(
  `INSERT INTO projects_read_model
     (project_id, workspace_id, name, description, status, target_repo, created_at, updated_at)
   VALUES (?, ?, ?, '', 'active', ?, ?, ?)`,
).run('project-1', 'ws-1', 'Project', '/srv/app', 't', 't');

const repos: RepoRegistry = new Map([
  ['/srv/app', { targetRepo: '/srv/app', checks: ['npm test'], deployment: 'not_required' }],
  ['/srv/other', { targetRepo: '/srv/other', checks: ['npm test'], deployment: 'not_required' }],
]);
const create = (objective: string, source: 'human' | 'owner_discovery' = 'human') => createGoal('human-1', {
  workspaceId: 'ws-1',
  projectId: 'project-1',
  source,
  objective,
  successCriteria: `${objective} accepted`,
  dataScope: `${objective} files`,
  ownerAgentId: 'owner-agent',
}, db, repos);

db.prepare("INSERT INTO workspaces_read_model (workspace_id, name, status, created_at) VALUES ('ws-owner-permission', 'Owner permission', 'active', 't')").run();
db.prepare("INSERT INTO projects_read_model (project_id, workspace_id, name, description, status, target_repo, created_at, updated_at) VALUES ('project-owner-permission', 'ws-owner-permission', 'Owner permission', '', 'active', '/srv/app', 't', 't')").run();
const createOwnerPermissionGoal = () => createGoal('human-1', {
  workspaceId: 'ws-owner-permission', projectId: 'project-owner-permission', source: 'human',
  objective: 'Owner permission', successCriteria: 'Owner Agent can coordinate', ownerAgentId: 'owner-agent',
}, db, repos);
assert.throws(createOwnerPermissionGoal, /Owner Agent 不是此 Workspace 的 Admin，coordinator 無法處理/,
  'Owner Agent user 不在 Workspace 時應拒絕建立 Goal');
db.prepare("INSERT INTO workspace_members_read_model VALUES ('ws-owner-permission', 'owner-user', 'Member', 't')").run();
assert.throws(createOwnerPermissionGoal, /Owner Agent 不是此 Workspace 的 Admin，coordinator 無法處理/,
  'Owner Agent user 只是 Member 時應拒絕建立 Goal');
db.prepare("UPDATE workspace_members_read_model SET role = 'Admin' WHERE workspace_id = 'ws-owner-permission' AND user_id = 'owner-user'").run();
const ownerPermissionGoal = createOwnerPermissionGoal();
assert.strictEqual(getGoal(ownerPermissionGoal, db)?.status, 'Queued', 'Owner Agent user 是 Admin 時應成功建立 Goal');
db.prepare("DELETE FROM workspace_members_read_model WHERE workspace_id = 'ws-owner-permission' AND user_id = 'owner-user'").run();
assert.throws(() => startDiscussion('human-1', ownerPermissionGoal, db),
  /Owner Agent 不是此 Workspace 的 Admin，coordinator 無法處理/,
  '建立後 Owner Agent user 被移出 Workspace 時應拒絕開始 Goal');
assert.strictEqual(getGoal(ownerPermissionGoal, db)?.status, 'Queued', '開始被拒後 Goal 狀態應維持 Queued');

const first = create('A');
const second = create('B');
assert.throws(
  () => updateProject('project-1', { targetRepo: '/srv/other' }, db, repos),
  /active Goal/,
  'active Goal 期間不可改 target repo',
);
assert.notStrictEqual(first, second, '一個 Project 可保存多個 Goal');
assert.deepStrictEqual(listGoals('ws-1', db).map((goal) => goal.goal_id), [first, second]);
assert.strictEqual(getGoal(first, db)?.status, 'Queued');
assert.strictEqual(getGoal(first, db)?.revision, 1);
assert.strictEqual(getGoal(first, db)?.data_scope, 'A files');
assert.throws(() => archiveProject('project-1', db), /active Goal/, 'Project 有 active Goal 時不可封存');

startDiscussion('owner-agent', first, db);
assert.strictEqual(getGoal(first, db)?.discussion_phase, 'owner_scoping');
setDiscussionPhase('owner-agent', first, 'round_1', db);
setDiscussionPhase('owner-agent', first, 'round_2', db);
setDiscussionPhase('owner-agent', first, 'awaiting_lease', db);
acquireRepoLease('owner-agent', first, db);
assert.strictEqual(getGoal(first, db)?.discussion_phase, 'owner_synthesis');

startDiscussion('owner-agent', second, db);
setDiscussionPhase('owner-agent', second, 'round_1', db);
setDiscussionPhase('owner-agent', second, 'awaiting_lease', db);
assert.throws(() => acquireRepoLease('owner-agent', second, db), /repo execution lease/);
blockGoal('owner-agent', first, 'needs human', db);
assert.strictEqual(getGoal(first, db)?.status, 'Blocked');
const firstBlockedNotifications = (db.prepare(
  'SELECT recipient_id, source_task_id, source_goal_id, snippet FROM notifications_read_model WHERE source_goal_id = ?',
).all(first) as unknown as Array<{ recipient_id: string; source_task_id: string; source_goal_id: string; snippet: string }>).map((row) => ({ ...row }));
assert.deepStrictEqual(firstBlockedNotifications, [{
  recipient_id: 'human-admin', source_task_id: '', source_goal_id: first, snippet: 'Goal Blocked：needs human',
}], '無 Task 的 Goal Blocked 應只通知人類 Admin 一次');
assert.throws(() => acquireRepoLease('owner-agent', second, db), /repo execution lease/, 'Blocked Goal 保留 lease');
cancelGoal('human-1', first, db);
assert.strictEqual(getGoal(first, db)?.status, 'Cancelled');

acquireRepoLease('owner-agent', second, db);
startExecution('owner-agent', second, db);
db.prepare(`INSERT INTO goal_worktrees (worktree_path, goal_id, target_repo, dirty, unmerged, created_at, updated_at)
  VALUES ('/srv/app/.worktrees/second', ?, '/srv/app', 0, 1, 't', 't')`).run(second);
assert.strictEqual(isGoalSafeCheckpoint(second, db), false);
assert.strictEqual(pauseGoal('human-1', second, false, db), 'scheduled');
assert.strictEqual(getGoal(second, db)?.status, 'Executing');
assert.strictEqual(getGoal(second, db)?.pause_requested, 1);
db.prepare("UPDATE goal_worktrees SET unmerged = 0 WHERE goal_id = ?").run(second);
// 已封存 task 的 worktree 旗標清不掉，不擋暫停；同樣的 worktree 換成未封存 task 就要擋
db.prepare(`INSERT INTO tasks_read_model
  (task_id, workspace_id, project_id, goal_id, title, description, status, priority, version)
  VALUES ('archived-task', 'ws-1', 'project-1', ?, 'archived', '', 'Doing', 'Medium', 1)`).run(second);
db.prepare(`INSERT INTO goal_worktrees (worktree_path, goal_id, target_repo, dirty, unmerged, created_at, updated_at)
  VALUES ('/srv/app/sim-work/tasks/archived-task', ?, '/srv/app', 1, 1, 't', 't')`).run(second);
assert.strictEqual(isGoalSafeCheckpoint(second, db), false, '未封存 task 的 dirty/unmerged worktree 要擋暫停');
db.prepare("UPDATE tasks_read_model SET status = 'Archived' WHERE task_id = 'archived-task'").run();
assert.strictEqual(isGoalSafeCheckpoint(second, db), true, '已封存 task 的 worktree 不擋暫停');
db.prepare("DELETE FROM goal_worktrees WHERE worktree_path = '/srv/app/sim-work/tasks/archived-task'").run();
const coordinatorDb = new DatabaseSync(':memory:');
coordinatorDb.exec('CREATE TABLE action_log (task_id TEXT, kind TEXT, status TEXT)');
db.prepare(`INSERT INTO tasks_read_model
  (task_id, workspace_id, project_id, goal_id, title, description, status, priority, version)
  VALUES ('pause-task', 'ws-1', 'project-1', ?, 'pause', '', 'Doing', 'Medium', 1)`).run(second);
coordinatorDb.prepare("INSERT INTO action_log VALUES ('pause-task', 'merge_deploy', 'pending')").run();
assert.strictEqual(isGoalSafeCheckpoint(second, db, coordinatorDb), false, '進行中的 merge/deploy action 不是安全 checkpoint');
coordinatorDb.prepare("UPDATE action_log SET status = 'completed'").run();
assert.strictEqual(isGoalSafeCheckpoint(second, db, coordinatorDb), true);
assert.strictEqual(applyPendingGoalPause('owner-agent', second, true, db), true);
coordinatorDb.close();
db.prepare("UPDATE tasks_read_model SET status = 'Archived' WHERE task_id = 'pause-task'").run();
assert.strictEqual(getGoal(second, db)?.status, 'Paused');
assert.strictEqual(db.prepare('SELECT 1 FROM repo_leases WHERE goal_id = ?').get(second), undefined, '暫停後 lease 釋放');
const leaseAfterPause = create('Lease after pause');
startDiscussion('owner-agent', leaseAfterPause, db);
setDiscussionPhase('owner-agent', leaseAfterPause, 'round_1', db);
setDiscussionPhase('owner-agent', leaseAfterPause, 'awaiting_lease', db);
acquireRepoLease('owner-agent', leaseAfterPause, db);
assert.ok(db.prepare('SELECT 1 FROM repo_leases WHERE goal_id = ?').get(leaseAfterPause), 'Executing Goal 暫停後其他 Goal 可取得 lease');
cancelGoal('human-1', leaseAfterPause, db);
resumeGoal('human-1', second, undefined, db);
assert.strictEqual(getGoal(second, db)?.status, 'Discussing');
assert.strictEqual(getGoal(second, db)?.discussion_phase, 'awaiting_lease');
assert.strictEqual(getGoal(second, db)?.revision, 2);
acquireRepoLease('owner-agent', second, db);
startExecution('owner-agent', second, db);
startVerification('owner-agent', second, db);
completeGoal('owner-agent', second, ['health:200'], db);
assert.strictEqual(getGoal(second, db)?.status, 'Done');
assert.deepStrictEqual(JSON.parse(getGoal(second, db)?.evidence_refs_json ?? '[]'), ['health:200']);

const immediatePause = create('Immediate pause');
startDiscussion('owner-agent', immediatePause, db);
setDiscussionPhase('owner-agent', immediatePause, 'round_1', db);
setDiscussionPhase('owner-agent', immediatePause, 'awaiting_lease', db);
acquireRepoLease('owner-agent', immediatePause, db);
startExecution('owner-agent', immediatePause, db);
assert.strictEqual(pauseGoal('human-1', immediatePause, isGoalSafeCheckpoint(immediatePause, db), db), 'paused');
assert.strictEqual(getGoal(immediatePause, db)?.status, 'Paused');
assert.strictEqual(db.prepare('SELECT 1 FROM repo_leases WHERE goal_id = ?').get(immediatePause), undefined);
const pausedEventCount = (db.prepare('SELECT COUNT(*) AS n FROM event_store WHERE aggregate_id = ?').get(immediatePause) as { n: number }).n;
assert.throws(() => reviseGoal('human-1', immediatePause, 'must resume first', db), /先恢復/);
assert.strictEqual((db.prepare('SELECT COUNT(*) AS n FROM event_store WHERE aggregate_id = ?').get(immediatePause) as { n: number }).n, pausedEventCount,
  'Paused Goal 修訂失敗不得新增事件');
cancelGoal('human-1', immediatePause, db);

const discussingPause = create('Discussing pause');
startDiscussion('owner-agent', discussingPause, db);
const discussingHeartbeat = enqueueHeartbeat({
  scopeId: discussingPause, goalId: discussingPause, phase: 'owner_scoping', agentId: 'owner-agent', revision: 1, triggerRef: 'phase',
}, db);
const discussingRun = prepareRun({
  heartbeatId: discussingHeartbeat, goalId: discussingPause, agentId: 'owner-agent', phase: 'owner_scoping',
  adapter: 'claude', model: 'test', attempt: 'primary', estimatedInputTokens: 1, estimatedOutputTokens: 1,
  estimateBasis: 'test', estimateConfidence: 'high', quotaSnapshotJson: '{}',
}, db);
markRunRunning(discussingRun, db);
assert.strictEqual(pauseGoal('human-1', discussingPause, true, db), 'scheduled', '執行中的討論 Run 必須延後暫停');
assert.strictEqual(getGoal(discussingPause, db)?.status, 'Discussing');
finishRun(discussingRun, {
  status: 'failed', actualInputTokens: null, actualOutputTokens: null, actualCost: null, credibleBilling: false,
  outcome: null, errorCategory: 'test', evidenceRef: null, sideEffectState: 'none',
}, db);
assert.strictEqual(applyPendingGoalPause('owner-agent', discussingPause, true, db), true);
cancelGoal('human-1', discussingPause, db);

const discussionBlocked = create('Discussion blocked');
startDiscussion('owner-agent', discussionBlocked, db);
setDiscussionPhase('owner-agent', discussionBlocked, 'round_1', db);
blockGoal('owner-agent', discussionBlocked, 'no contribution', db);
const blockedEventCount = (db.prepare('SELECT COUNT(*) AS n FROM event_store WHERE aggregate_id = ?').get(discussionBlocked) as { n: number }).n;
assert.throws(() => reviseGoal('human-1', discussionBlocked, 'must resume first', db), /先恢復/);
assert.strictEqual((db.prepare('SELECT COUNT(*) AS n FROM event_store WHERE aggregate_id = ?').get(discussionBlocked) as { n: number }).n, blockedEventCount,
  'Blocked Goal 修訂失敗不得新增事件');
assert.throws(() => resumeGoal('human-1', discussionBlocked, '', db), /變更說明/);
resumeGoal('human-1', discussionBlocked, '調整參與者與討論面向', db);
assert.deepStrictEqual(
  { status: getGoal(discussionBlocked, db)?.status, phase: getGoal(discussionBlocked, db)?.discussion_phase, revision: getGoal(discussionBlocked, db)?.revision },
  { status: 'Discussing', phase: 'owner_scoping', revision: 2 },
);
assert.match(String((db.prepare("SELECT payload_json FROM event_store WHERE aggregate_id = ? AND event_type = 'goal.resumed'").get(discussionBlocked) as { payload_json: string }).payload_json), /調整參與者/);
cancelGoal('human-1', discussionBlocked, db);

const executingBlocked = create('Executing blocked');
startDiscussion('owner-agent', executingBlocked, db);
setDiscussionPhase('owner-agent', executingBlocked, 'round_1', db);
setDiscussionPhase('owner-agent', executingBlocked, 'awaiting_lease', db);
acquireRepoLease('owner-agent', executingBlocked, db);
startExecution('owner-agent', executingBlocked, db);
blockGoal('owner-agent', executingBlocked, 'implementation blocked', db);
resumeGoal('human-1', executingBlocked, '人工修復環境', db);
assert.deepStrictEqual(
  { status: getGoal(executingBlocked, db)?.status, revision: getGoal(executingBlocked, db)?.revision },
  { status: 'Executing', revision: 2 },
);
assert.ok(db.prepare('SELECT 1 FROM repo_leases WHERE goal_id = ?').get(executingBlocked), 'Executing Blocked 恢復後 lease 不變');
cancelGoal('human-1', executingBlocked, db);

const revised = create('Revise');
startDiscussion('owner-agent', revised, db);
setDiscussionPhase('owner-agent', revised, 'round_1', db);
setDiscussionPhase('owner-agent', revised, 'awaiting_lease', db);
acquireRepoLease('owner-agent', revised, db);
startExecution('owner-agent', revised, db);
reviseGoal('human-1', revised, 'new acceptance', db);
assert.strictEqual(getGoal(revised, db)?.status, 'Discussing');
assert.strictEqual(getGoal(revised, db)?.discussion_phase, 'owner_synthesis');
assert.strictEqual(getGoal(revised, db)?.revision, 2);
assert.strictEqual(getGoal(revised, db)?.data_scope, 'Revise files');
reviseGoalDataScope('human-1', revised, 'src/goal.ts and tests', db);
assert.strictEqual(getGoal(revised, db)?.discussion_phase, 'owner_synthesis');
assert.strictEqual(getGoal(revised, db)?.revision, 3);
assert.strictEqual(getGoal(revised, db)?.data_scope, 'src/goal.ts and tests');
const cancelledTask = 'cancelled-task';
appendEvent('Task', cancelledTask, 0, 'task.created', {
  workspaceId: 'ws-1', projectId: 'project-1', goalId: revised, title: 'cancel me', description: '',
  status: 'Todo', priority: 'Medium', assigneeId: null, dueAt: null,
}, {}, db);
cancelGoal('human-1', revised, db);
assert.strictEqual(getTask(cancelledTask, db)?.status, 'Archived', 'Cancelled Goal 必須以 event 封存未完成 Task');
assert.strictEqual(
  JSON.parse((db.prepare("SELECT metadata_json FROM event_store WHERE aggregate_id = ? AND event_type = 'task.archived'").get(cancelledTask) as { metadata_json: string }).metadata_json).actor_id,
  'owner-user',
  'Goal cancel 必須固定由 Owner Agent 經 archive command 封存 Task',
);

const revisedDiscussion = create('Revise discussion');
startDiscussion('owner-agent', revisedDiscussion, db);
setDiscussionPhase('owner-agent', revisedDiscussion, 'round_1', db);
reviseGoal('human-1', revisedDiscussion, 'new discussion acceptance', db);
assert.deepStrictEqual(
  {
    status: getGoal(revisedDiscussion, db)?.status,
    phase: getGoal(revisedDiscussion, db)?.discussion_phase,
    revision: getGoal(revisedDiscussion, db)?.revision,
  },
  { status: 'Discussing', phase: 'owner_scoping', revision: 2 },
);
assert.ok(db.prepare("SELECT 1 FROM goal_heartbeats WHERE goal_id = ? AND revision = 2 AND phase = 'owner_scoping' AND trigger_ref = 'phase' AND status = 'pending'").get(revisedDiscussion),
  'round_1 修訂後必須排入新 revision 的 owner_scoping heartbeat');
cancelGoal('human-1', revisedDiscussion, db);

const autonomous = create('Auto', 'owner_discovery');
assert.throws(() => create('Duplicate Auto', 'owner_discovery'), /active 自治 Goal/);
cancelGoal('human-1', autonomous, db);

const queuedPause = create('Pause before discussion');
pauseGoal('human-1', queuedPause, true, db);
resumeGoal('human-1', queuedPause, undefined, db);
assert.strictEqual(getGoal(queuedPause, db)?.status, 'Queued');
assert.strictEqual(getGoal(queuedPause, db)?.revision, 1, '未持有 lease 的 Paused 恢復不增加 revision');
cancelGoal('human-1', queuedPause, db);

assert.throws(
  () => createGoal('human-1', {
    workspaceId: 'ws-1', projectId: 'project-1', source: 'human', objective: ' ',
    successCriteria: 'x', ownerAgentId: 'owner-agent',
  }, db, repos),
  /objective/,
);
assert.throws(() => createGoal('human-1', {
  workspaceId: 'ws-1', projectId: 'project-1', objective: 'wrong owner', successCriteria: 'x', ownerAgentId: 'member-agent',
}, db, repos), /Owner Agent/);
assert.throws(() => createGoal('human-1', {
  workspaceId: 'ws-1', projectId: 'project-1', objective: 'unregistered repo', successCriteria: 'x', ownerAgentId: 'owner-agent',
}, db, new Map()), /target repo 未登記/);
const queuedCannotBlock = create('Queued cannot block');
assert.throws(() => blockGoal('owner-agent', queuedCannotBlock, 'invalid transition', db), /Queued/);
cancelGoal('human-1', queuedCannotBlock, db);
assert.throws(() => startExecution('owner-agent', first, db), /狀態/);

const waitingAutonomous = create('Waiting autonomous', 'owner_discovery');
startDiscussion('owner-agent', waitingAutonomous, db);
const priorityHuman = create('Priority human');
assert.strictEqual(getGoal(waitingAutonomous, db)?.status, 'Queued', '未持 lease 的自治 Goal 應讓位回 Queued');
cancelGoal('human-1', priorityHuman, db);
assert.ok(db.prepare("SELECT 1 FROM goal_heartbeats WHERE goal_id = ? AND phase = 'owner_scoping' AND status = 'pending'").get(waitingAutonomous),
  '人類 Goal 終態後應恢復 Queued 自治 Goal');
cancelGoal('human-1', waitingAutonomous, db);

const roundOneAutonomous = create('Round one autonomous', 'owner_discovery');
startDiscussion('owner-agent', roundOneAutonomous, db);
setDiscussionPhase('owner-agent', roundOneAutonomous, 'round_1', db);
const humanDuringRoundOne = create('Human during round one');
assert.strictEqual(getGoal(roundOneAutonomous, db)?.status, 'Queued', 'round_1 自治 Goal 仍應讓位回 Queued');
cancelGoal('human-1', humanDuringRoundOne, db);
cancelGoal('human-1', roundOneAutonomous, db);

const manuallyPausedAutonomous = create('Manually paused autonomous', 'owner_discovery');
startDiscussion('owner-agent', manuallyPausedAutonomous, db);
setDiscussionPhase('owner-agent', manuallyPausedAutonomous, 'round_1', db);
setDiscussionPhase('owner-agent', manuallyPausedAutonomous, 'awaiting_lease', db);
acquireRepoLease('owner-agent', manuallyPausedAutonomous, db);
startExecution('owner-agent', manuallyPausedAutonomous, db);
assert.strictEqual(pauseGoal('human-1', manuallyPausedAutonomous, true, db), 'paused');
assert.strictEqual(getGoal(manuallyPausedAutonomous, db)?.paused_from_status, 'Executing');
const humanAfterManualPause = create('Human after manual pause');
assert.deepStrictEqual(
  { status: getGoal(manuallyPausedAutonomous, db)?.status, pausedFromStatus: getGoal(manuallyPausedAutonomous, db)?.paused_from_status },
  { status: 'Paused', pausedFromStatus: 'Executing' },
  '人工暫停的自治 Goal 不得被插隊改回 Queued',
);
assert.strictEqual(
  db.prepare('SELECT 1 FROM goal_preemptions WHERE human_goal_id = ? AND autonomous_goal_id = ?').get(humanAfterManualPause, manuallyPausedAutonomous),
  undefined,
  '人工暫停的自治 Goal 不得建立插隊紀錄',
);
cancelGoal('human-1', humanAfterManualPause, db);
assert.strictEqual(getGoal(manuallyPausedAutonomous, db)?.status, 'Paused');
assert.strictEqual(
  db.prepare("SELECT 1 FROM goal_heartbeats WHERE goal_id = ? AND status = 'pending'").get(manuallyPausedAutonomous),
  undefined,
  '人工暫停的自治 Goal 不得被自動重啟',
);
cancelGoal('human-1', manuallyPausedAutonomous, db);

const manuallyScheduledAutonomous = create('Manually scheduled autonomous', 'owner_discovery');
startDiscussion('owner-agent', manuallyScheduledAutonomous, db);
setDiscussionPhase('owner-agent', manuallyScheduledAutonomous, 'round_1', db);
setDiscussionPhase('owner-agent', manuallyScheduledAutonomous, 'awaiting_lease', db);
acquireRepoLease('owner-agent', manuallyScheduledAutonomous, db);
startExecution('owner-agent', manuallyScheduledAutonomous, db);
assert.strictEqual(pauseGoal('human-1', manuallyScheduledAutonomous, false, db), 'scheduled');
const humanAfterScheduledPause = create('Human after scheduled pause');
assert.strictEqual(
  db.prepare('SELECT 1 FROM goal_preemptions WHERE human_goal_id = ? AND autonomous_goal_id = ?').get(humanAfterScheduledPause, manuallyScheduledAutonomous),
  undefined,
  '已有人工暫停請求的自治 Goal 不得建立插隊紀錄',
);
cancelGoal('human-1', humanAfterScheduledPause, db);
assert.strictEqual(
  getGoal(manuallyScheduledAutonomous, db)?.pause_requested,
  1,
  '人工送出的暫停請求不得在插隊結束時被清除',
);
cancelGoal('human-1', manuallyScheduledAutonomous, db);

const heldAutonomous = create('Held autonomous', 'owner_discovery');
startDiscussion('owner-agent', heldAutonomous, db);
setDiscussionPhase('owner-agent', heldAutonomous, 'round_1', db);
setDiscussionPhase('owner-agent', heldAutonomous, 'awaiting_lease', db);
acquireRepoLease('owner-agent', heldAutonomous, db);
startExecution('owner-agent', heldAutonomous, db);
const priorityDuringExecution = create('Priority during execution');
assert.strictEqual(getGoal(heldAutonomous, db)?.pause_requested, 1, '持 lease 自治 Goal 應排定暫停');
assert.strictEqual(applyPendingGoalPause('owner-agent', heldAutonomous, true, db), true);
cancelGoal('human-1', priorityDuringExecution, db);
assert.deepStrictEqual(
  { status: getGoal(heldAutonomous, db)?.status, phase: getGoal(heldAutonomous, db)?.discussion_phase },
  { status: 'Discussing', phase: 'awaiting_lease' },
  '人類 Goal Cancelled 後恢復自治 Goal',
);
cancelGoal('human-1', heldAutonomous, db);

const blockedLeaseAutonomous = create('Blocked lease autonomous', 'owner_discovery');
startDiscussion('owner-agent', blockedLeaseAutonomous, db);
setDiscussionPhase('owner-agent', blockedLeaseAutonomous, 'round_1', db);
setDiscussionPhase('owner-agent', blockedLeaseAutonomous, 'awaiting_lease', db);
acquireRepoLease('owner-agent', blockedLeaseAutonomous, db);
blockGoal('owner-agent', blockedLeaseAutonomous, 'human must resolve', db);
const humanBehindBlocked = create('Human behind blocked');
assert.strictEqual(getGoal(blockedLeaseAutonomous, db)?.status, 'Blocked');
assert.ok(db.prepare('SELECT 1 FROM repo_leases WHERE goal_id = ?').get(blockedLeaseAutonomous), 'Blocked 自治 Goal 保留 lease');
startDiscussion('owner-agent', humanBehindBlocked, db);
blockGoal('owner-agent', humanBehindBlocked, 'cannot preempt blocked lease', db);
assert.strictEqual(getGoal(blockedLeaseAutonomous, db)?.status, 'Blocked', '人類 Goal Blocked 也不得搖醒原 Blocked lease holder');
cancelGoal('human-1', humanBehindBlocked, db);
cancelGoal('human-1', blockedLeaseAutonomous, db);

archiveProject('project-1', db);
assert.strictEqual(getProject('project-1', db)?.status, 'archived');

console.log('goal.test.ts OK');
