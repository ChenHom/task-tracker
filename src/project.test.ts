import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';
import { resetProjections, CommandError } from './eventStore';
import { createProject, listProjects, renameProject, deleteProject, getProjectWorkspaceId } from './project';
import { createTask, listTasks, registerTaskProjections } from './task';

const db = new DatabaseSync(':memory:');
runMigrations(db);
resetProjections();
registerTaskProjections();

const seedWs = (id: string, status = 'active') =>
  db.prepare('INSERT INTO workspaces_read_model (workspace_id, name, status, created_at) VALUES (?, ?, ?, ?)').run(id, id, status, 't');
seedWs('ws-1');
seedWs('ws-2');

// ── create → 直接進表 ──
const id = createProject('ws-1', '  Backend  ', db);
let rows = listProjects('ws-1', db);
assert.strictEqual(rows.length, 1);
assert.strictEqual(rows[0].name, 'Backend', 'name 應 trim');
assert.strictEqual(rows[0].workspace_id, 'ws-1');
assert.strictEqual(getProjectWorkspaceId(id, db), 'ws-1', 'getProjectWorkspaceId 回歸屬 workspace');

// ── rename ──
renameProject(id, 'Frontend', db);
assert.strictEqual(listProjects('ws-1', db)[0].name, 'Frontend');

// ── 輸入驗證 ──
assert.throws(() => createProject('ws-1', '', db), CommandError, '空 name 應拒');
assert.throws(() => createProject('ws-1', '   ', db), CommandError, '純空白 name 應拒');
assert.throws(() => createProject('ws-1', 123 as unknown, db), CommandError, '非字串 name 應拒');
assert.throws(() => renameProject('no-such', 'X', db), CommandError, 'rename 不存在的 project 應拒');
assert.throws(() => deleteProject('no-such', db), CommandError, 'delete 不存在的 project 應拒');

// ── workspace 生命週期 gate ──
seedWs('ws-arch', 'archived');
assert.throws(() => createProject('ws-arch', 'X', db), CommandError, 'archived workspace 不可建 project');
assert.throws(() => createProject('ws-missing', 'X', db), CommandError, '不存在的 workspace 不可建 project');

// ── listProjects 只回該 workspace ──
createProject('ws-2', 'Mobile', db);
assert.ok(listProjects('ws-1', db).every((p) => p.workspace_id === 'ws-1'), 'listProjects 只回指定 workspace');
assert.strictEqual(listProjects('ws-2', db).length, 1);

// ── delete → 從表移除 ──
deleteProject(id, db);
assert.strictEqual(listProjects('ws-1', db).length, 0, 'delete 後應從表移除');
assert.strictEqual(getProjectWorkspaceId(id, db), null, 'deleted project 查不到 workspace（→ 404）');

// ── delete project 應級聯清 task 的 projectId ──
const pid = createProject('ws-1', 'TestProj', db);
const taskId = createTask('u1', 'ws-1', { title: 'Task with project', projectId: pid }, db);
let task = listTasks('ws-1', db).find((t) => t.task_id === taskId)!;
assert.strictEqual(task.project_id, pid, '建 task 時 projectId 應被設');
deleteProject(pid, db);
task = listTasks('ws-1', db).find((t) => t.task_id === taskId)!;
assert.strictEqual(task.project_id, null, 'delete project 後 task 的 projectId 應變成 null');

console.log('project.test.ts OK');
