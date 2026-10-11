import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { resetProjections } from './eventStore';
import {
  acquireRepoLease,
  blockGoal,
  cancelGoal,
  completeGoal,
  createGoal,
  getGoal,
  listGoals,
  pauseGoal,
  registerGoalProjections,
  resumeGoal,
  reviseGoal,
  setDiscussionPhase,
  startDiscussion,
  startExecution,
  startVerification,
} from './goal';
import { archiveProject, getProject, updateProject } from './project';
import type { RepoRegistry } from './repoRegistry';
import { runMigrations } from './schema';

const db = new DatabaseSync(':memory:');
runMigrations(db);
resetProjections();
registerGoalProjections();

db.prepare('INSERT INTO workspaces_read_model (workspace_id, name, status, created_at) VALUES (?, ?, ?, ?)')
  .run('ws-1', 'Workspace', 'active', 't');
db.prepare(
  `INSERT INTO projects_read_model
     (project_id, workspace_id, name, description, status, target_repo, created_at, updated_at)
   VALUES (?, ?, ?, '', 'active', ?, ?, ?)`,
).run('project-1', 'ws-1', 'Project', '/srv/app', 't', 't');

const create = (objective: string, source: 'human' | 'owner_discovery' = 'human') => createGoal('human-1', {
  workspaceId: 'ws-1',
  projectId: 'project-1',
  source,
  objective,
  successCriteria: `${objective} accepted`,
  ownerAgentId: 'owner-agent',
}, db);

const first = create('A');
const second = create('B');
const repos: RepoRegistry = new Map([
  ['/srv/app', { targetRepo: '/srv/app', checks: ['npm test'], deployment: 'not_required' }],
  ['/srv/other', { targetRepo: '/srv/other', checks: ['npm test'], deployment: 'not_required' }],
]);
assert.throws(
  () => updateProject('project-1', { targetRepo: '/srv/other' }, db, repos),
  /active Goal/,
  'active Goal 期間不可改 target repo',
);
assert.notStrictEqual(first, second, '一個 Project 可保存多個 Goal');
assert.deepStrictEqual(listGoals('ws-1', db).map((goal) => goal.goal_id), [first, second]);
assert.strictEqual(getGoal(first, db)?.status, 'Queued');
assert.strictEqual(getGoal(first, db)?.revision, 1);
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
assert.throws(() => acquireRepoLease('owner-agent', second, db), /repo execution lease/, 'Blocked Goal 保留 lease');
cancelGoal('human-1', first, db);
assert.strictEqual(getGoal(first, db)?.status, 'Cancelled');

acquireRepoLease('owner-agent', second, db);
assert.throws(() => pauseGoal('human-1', second, false, db), /安全 checkpoint/);
pauseGoal('human-1', second, true, db);
assert.strictEqual(getGoal(second, db)?.status, 'Paused');
resumeGoal('human-1', second, db);
assert.strictEqual(getGoal(second, db)?.status, 'Discussing');
assert.strictEqual(getGoal(second, db)?.discussion_phase, 'awaiting_lease');
assert.strictEqual(getGoal(second, db)?.revision, 2);
acquireRepoLease('owner-agent', second, db);
startExecution('owner-agent', second, db);
startVerification('owner-agent', second, db);
completeGoal('owner-agent', second, ['health:200'], db);
assert.strictEqual(getGoal(second, db)?.status, 'Done');
assert.deepStrictEqual(JSON.parse(getGoal(second, db)?.evidence_refs_json ?? '[]'), ['health:200']);

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
cancelGoal('human-1', revised, db);

const autonomous = create('Auto', 'owner_discovery');
assert.throws(() => create('Duplicate Auto', 'owner_discovery'), /active 自治 Goal/);
cancelGoal('human-1', autonomous, db);

const queuedPause = create('Pause before discussion');
pauseGoal('human-1', queuedPause, true, db);
resumeGoal('human-1', queuedPause, db);
assert.strictEqual(getGoal(queuedPause, db)?.status, 'Queued');
assert.strictEqual(getGoal(queuedPause, db)?.revision, 1, '未持有 lease 的 Paused 恢復不增加 revision');
cancelGoal('human-1', queuedPause, db);

assert.throws(
  () => createGoal('human-1', {
    workspaceId: 'ws-1', projectId: 'project-1', source: 'human', objective: ' ',
    successCriteria: 'x', ownerAgentId: 'owner-agent',
  }, db),
  /objective/,
);
assert.throws(() => startExecution('owner-agent', first, db), /狀態/);

archiveProject('project-1', db);
assert.strictEqual(getProject('project-1', db)?.status, 'archived');

console.log('goal.test.ts OK');
