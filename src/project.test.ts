import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';
import { resetProjections, CommandError } from './eventStore';
import {
  archiveProject,
  createProject,
  deleteProject,
  getProject,
  getProjectWorkspaceId,
  listProjects,
  registerGoalWorktree,
  updateProject,
} from './project';
import { createTask, listTasks, registerTaskProjections } from './task';
import type { RepoRegistry } from './repoRegistry';

const db = new DatabaseSync(':memory:');
runMigrations(db);
resetProjections();
registerTaskProjections();

const seedWs = (id: string, status = 'active') =>
  db.prepare('INSERT INTO workspaces_read_model (workspace_id, name, status, created_at) VALUES (?, ?, ?, ?)').run(id, id, status, 't');
seedWs('ws-1');
seedWs('ws-2');
const repos: RepoRegistry = new Map([
  ['/srv/app', { targetRepo: '/srv/app', checks: ['npm test'], deployment: 'not_required' }],
]);

// ── create → 直接進表 ──
const id = createProject('ws-1', {
  name: '  Backend  ',
  description: ' API work ',
  targetRepo: '/srv/app',
}, db, repos);
let rows = listProjects('ws-1', db);
assert.strictEqual(rows.length, 1);
assert.strictEqual(rows[0].name, 'Backend', 'name 應 trim');
assert.strictEqual(rows[0].description, 'API work', 'description 應 trim');
assert.strictEqual(rows[0].target_repo, '/srv/app');
assert.strictEqual(rows[0].status, 'active');
assert.ok(rows[0].created_at);
assert.ok(rows[0].updated_at);
assert.strictEqual(rows[0].workspace_id, 'ws-1');
assert.strictEqual(getProjectWorkspaceId(id, db), 'ws-1', 'getProjectWorkspaceId 回歸屬 workspace');

// ── update ──
updateProject(id, { name: 'Frontend' }, db, repos);
assert.strictEqual(listProjects('ws-1', db)[0].name, 'Frontend');
assert.strictEqual(getProject(id, db)?.description, 'API work', '單欄更新不可清掉其他欄位');

// ── 輸入驗證 ──
assert.throws(() => createProject('ws-1', { name: '' }, db, repos), CommandError, '空 name 應拒');
assert.throws(() => createProject('ws-1', { name: '   ' }, db, repos), CommandError, '純空白 name 應拒');
assert.throws(() => createProject('ws-1', { name: 123 }, db, repos), CommandError, '非字串 name 應拒');
assert.throws(
  () => createProject('ws-1', { name: 'Bad', targetRepo: '/tmp/nope' }, db, repos),
  /target repo 未登記/,
  '未登記 repo 應拒',
);
assert.throws(() => updateProject('no-such', { name: 'X' }, db, repos), CommandError, 'update 不存在的 project 應拒');
assert.throws(() => deleteProject('no-such', db), CommandError, 'delete 不存在的 project 應拒');

// ── workspace 生命週期 gate ──
seedWs('ws-arch', 'archived');
assert.throws(() => createProject('ws-arch', { name: 'X' }, db, repos), CommandError, 'archived workspace 不可建 project');
assert.throws(() => createProject('ws-missing', { name: 'X' }, db, repos), CommandError, '不存在的 workspace 不可建 project');

// ── listProjects 只回該 workspace ──
createProject('ws-2', { name: 'Mobile' }, db, repos);
assert.ok(listProjects('ws-1', db).every((p) => p.workspace_id === 'ws-1'), 'listProjects 只回指定 workspace');
assert.strictEqual(listProjects('ws-2', db).length, 1);

// ── delete → 從表移除 ──
deleteProject(id, db);
assert.strictEqual(listProjects('ws-1', db).length, 0, 'delete 後應從表移除');
assert.strictEqual(getProjectWorkspaceId(id, db), null, 'deleted project 查不到 workspace（→ 404）');

// ── delete project 應級聯清 task 的 projectId ──
const pid = createProject('ws-1', { name: 'TestProj', targetRepo: '/srv/app' }, db, repos);
const taskId = createTask('u1', 'ws-1', { title: 'Task with project', projectId: pid }, db);
let task = listTasks('ws-1', db).find((t) => t.task_id === taskId)!;
assert.strictEqual(task.project_id, pid, '建 task 時 projectId 應被設');
deleteProject(pid, db);
task = listTasks('ws-1', db).find((t) => t.task_id === taskId)!;
assert.strictEqual(task.project_id, null, 'delete project 後 task 的 projectId 應變成 null');

const archiveId = createProject('ws-1', { name: 'Archive Me', targetRepo: '/srv/app' }, db, repos);
const unfinishedTask = createTask('u1', 'ws-1', { title: 'Still open', projectId: archiveId }, db);
assert.throws(() => archiveProject(archiveId, db), /未完成 task/, '未完成 task 時不可封存 Project');
db.prepare("UPDATE tasks_read_model SET status = 'Done' WHERE task_id = ?").run(unfinishedTask);
archiveProject(archiveId, db);
assert.strictEqual(getProject(archiveId, db)?.status, 'archived');
assert.throws(() => createTask('u1', 'ws-1', { title: 'No new task', projectId: archiveId }, db), /project 已封存/);

const worktreeProject = createProject('ws-1', { name: 'Worktree', targetRepo: '/srv/app' }, db, repos);
db.prepare(`INSERT INTO goals_read_model
  (goal_id, workspace_id, project_id, source, objective, success_criteria, status, revision,
   created_by, owner_agent_id, evidence_refs_json, version, created_at, updated_at)
  VALUES ('worktree-goal', 'ws-1', ?, 'human', 'x', 'y', 'Done', 1, 'u1', 'owner', '[]', 1, 't', 't')`).run(worktreeProject);
registerGoalWorktree('worktree-goal', '/srv/app', '/srv/app/.worktrees/g', db);
assert.throws(() => archiveProject(worktreeProject, db), /dirty 或未合併 worktree/);
db.prepare("UPDATE goal_worktrees SET unmerged = 0 WHERE goal_id = 'worktree-goal'").run();
archiveProject(worktreeProject, db);

console.log('project.test.ts OK');
