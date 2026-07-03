import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';
import { searchWorkspace } from './search';

const db = new DatabaseSync(':memory:');
runMigrations(db);

const task = (id: string, ws: string, title: string, desc = '') =>
  db.prepare('INSERT INTO tasks_read_model (task_id, workspace_id, title, description, status, priority, version) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, ws, title, desc, 'Todo', 'Medium', 1);
const project = (id: string, ws: string, name: string) =>
  db.prepare('INSERT INTO projects_read_model (project_id, workspace_id, name) VALUES (?, ?, ?)').run(id, ws, name);
const comment = (id: string, taskId: string, content: string) =>
  db.prepare('INSERT INTO comments (comment_id, task_id, user_id, content) VALUES (?, ?, ?, ?)').run(id, taskId, 'u', content);

task('t1', 'ws-1', 'deploy pipeline', 'set up CI');
task('t2', 'ws-1', 'unrelated', 'ci mentioned here'); // description 命中 'ci'
task('t3', 'ws-2', 'deploy elsewhere', ''); // 別的 workspace
project('p1', 'ws-1', 'Deploy Tools');
comment('c1', 't1', 'deploy looks good');
comment('c2', 't3', 'deploy in ws-2'); // 別的 workspace 的 comment

// ── 跨 task/project/comment，且限定 workspace ──
const r = searchWorkspace('ws-1', 'deploy', db);
assert.deepStrictEqual(r.tasks.map((t) => t.task_id).sort(), ['t1'], 'task 命中 title');
assert.deepStrictEqual(r.projects.map((p) => p.project_id), ['p1'], 'project 命中 name');
assert.deepStrictEqual(r.comments.map((c) => c.comment_id), ['c1'], 'comment 命中 content（且只限 ws-1）');
assert.ok(!r.tasks.some((t) => t.task_id === 't3'), 'ws-2 的 task 不應出現');

// ── description 也掃 ──
assert.deepStrictEqual(
  searchWorkspace('ws-1', 'ci', db).tasks.map((t) => t.task_id).sort(),
  ['t1', 't2'],
  'title 或 description 命中皆算',
);

// ── LIKE 萬用字元 escape：'%' 應被當字面，不匹配任意 ──
task('t4', 'ws-1', '100% done', '');
assert.deepStrictEqual(searchWorkspace('ws-1', '100%', db).tasks.map((t) => t.task_id), ['t4'], "'100%' 應字面命中 '100% done'");
assert.strictEqual(searchWorkspace('ws-1', '%', db).tasks.length, 1, "'%' 應只字面命中含 % 的那筆，而非全部");

// ── 空查詢不掃全表 ──
assert.deepStrictEqual(searchWorkspace('ws-1', '   ', db), { tasks: [], projects: [], comments: [] }, '空查詢回空');

console.log('search.test.ts OK');
