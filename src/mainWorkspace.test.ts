import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';
import { appendEvent, loadEvents, resetProjections } from './eventStore';
import { seedOwner, inviteMember, joinWorkspace, getMemberRole, registerMemberProjections } from './member';
import { renameWorkspace, registerWorkspaceProjections } from './workspace';
import { changeTaskDescription, getTask, listTasks, registerTaskProjections } from './task';
import {
  MAIN_OWNER_EMAIL,
  MAIN_POLICY_DESCRIPTION,
  MAIN_POLICY_TITLE,
  MAIN_WORKSPACE_ID,
  MAIN_WORKSPACE_NAME,
} from './mainWorkspacePolicy';
import { syncMainWorkspace, syncMainWorkspaceUser } from './mainWorkspace';

const db = new DatabaseSync(':memory:');
runMigrations(db);
resetProjections();
registerWorkspaceProjections();
registerMemberProjections();
registerTaskProjections();

const insertUser = db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)');
insertUser.run('u01', MAIN_OWNER_EMAIL, '阿哲', 'x');
insertUser.run('u02', 'user02@test.local', '小美', 'x');
insertUser.run('u09', 'user09@test.local', '老闆', 'x');

appendEvent(
  'Workspace',
  MAIN_WORKSPACE_ID,
  0,
  'workspace.created',
  { name: 'Owner→阿哲 收件匣' },
  { actor_id: 'legacy' },
  db,
);
seedOwner(MAIN_WORKSPACE_ID, 'u01', db);
inviteMember('u01', MAIN_WORKSPACE_ID, 'u09', 'Commenter', db);
joinWorkspace('u09', MAIN_WORKSPACE_ID, db);
appendEvent(
  'Member',
  `${MAIN_WORKSPACE_ID}:u09`,
  2,
  'member.role_changed',
  { workspaceId: MAIN_WORKSPACE_ID, userId: 'u09', role: 'Member' },
  { actor_id: 'legacy' },
  db,
);
assert.strictEqual(getMemberRole(MAIN_WORKSPACE_ID, 'u09', db), 'Member', 'fixture 應保留歷史 Member');

const legacyTaskId = 'legacy-main-discussion';
appendEvent(
  'Task',
  legacyTaskId,
  0,
  'task.created',
  {
    workspaceId: MAIN_WORKSPACE_ID,
    projectId: null,
    title: 'workspace的封存功能',
    description: '保留舊內容',
    status: 'Todo',
    priority: 'Medium',
    assigneeId: null,
    dueAt: null,
  },
  { actor_id: 'legacy' },
  db,
);

const eventCount = (): number =>
  (db.prepare('SELECT count(*) AS count FROM event_store').get() as { count: number }).count;

syncMainWorkspace(db);

const workspace = db
  .prepare('SELECT name FROM workspaces_read_model WHERE workspace_id = ?')
  .get(MAIN_WORKSPACE_ID) as { name: string };
assert.strictEqual(workspace.name, MAIN_WORKSPACE_NAME);
assert.throws(
  () => renameWorkspace('u01', MAIN_WORKSPACE_ID, '其他名稱', db),
  /主工作區名稱固定為主協作工作區/,
);
assert.strictEqual(getMemberRole(MAIN_WORKSPACE_ID, 'u01', db), 'Owner');
assert.strictEqual(getMemberRole(MAIN_WORKSPACE_ID, 'u02', db), 'Commenter');
assert.strictEqual(getMemberRole(MAIN_WORKSPACE_ID, 'u09', db), 'Commenter');
assert.strictEqual(getTask(legacyTaskId, db)?.title, '[討論] workspace的封存功能');
assert.strictEqual(loadEvents(legacyTaskId, db).at(-1)?.event_type, 'task.main_discussion_normalized');

const activePolicies = () =>
  listTasks(MAIN_WORKSPACE_ID, db).filter(
    (task) => task.title === MAIN_POLICY_TITLE && task.status !== 'Archived',
  );
assert.strictEqual(activePolicies().length, 1, '應只有一筆 active policy task');
assert.strictEqual(activePolicies()[0].description, MAIN_POLICY_DESCRIPTION);

const afterFirstSync = eventCount();
syncMainWorkspace(db);
assert.strictEqual(eventCount(), afterFirstSync, '立即重複 sync 不得追加 event');

const policyId = activePolicies()[0].task_id;
changeTaskDescription('u01', policyId, 'stale', db);
const beforePolicyRepair = eventCount();
syncMainWorkspace(db);
assert.strictEqual(getTask(policyId, db)?.description, MAIN_POLICY_DESCRIPTION);
assert.strictEqual(eventCount(), beforePolicyRepair + 1, 'description drift 只修一個 event');
assert.strictEqual(loadEvents(policyId, db).at(-1)?.event_type, 'task.description_changed');
const afterPolicyRepair = eventCount();
syncMainWorkspace(db);
assert.strictEqual(eventCount(), afterPolicyRepair, '已修復的 policy 再 sync 應 no-op');

const u02AggregateId = `${MAIN_WORKSPACE_ID}:u02`;
const u02Version = loadEvents(u02AggregateId, db).at(-1)!.aggregate_version;
appendEvent(
  'Member',
  u02AggregateId,
  u02Version,
  'member.removed',
  { workspaceId: MAIN_WORKSPACE_ID, userId: 'u02' },
  { actor_id: 'legacy' },
  db,
);
assert.strictEqual(getMemberRole(MAIN_WORKSPACE_ID, 'u02', db), null);
syncMainWorkspaceUser('u02', db);
assert.strictEqual(getMemberRole(MAIN_WORKSPACE_ID, 'u02', db), 'Commenter');
assert.deepStrictEqual(
  loadEvents(u02AggregateId, db).slice(-2).map((event) => event.event_type),
  ['member.invited', 'member.joined'],
);
const afterU02Sync = eventCount();
syncMainWorkspaceUser('u02', db);
assert.strictEqual(eventCount(), afterU02Sync, '使用者已是 Commenter 時 sync 應 no-op');

db.prepare('UPDATE workspace_members_read_model SET role = ? WHERE workspace_id = ? AND user_id = ?')
  .run('Admin', MAIN_WORKSPACE_ID, 'u01');
assert.throws(() => syncMainWorkspace(db), /user01 不存在或不是主工作區 Owner/);
assert.strictEqual(getMemberRole(MAIN_WORKSPACE_ID, 'u01', db), 'Admin', 'sync 不得自動提權 owner');
db.prepare('UPDATE workspace_members_read_model SET role = ? WHERE workspace_id = ? AND user_id = ?')
  .run('Owner', MAIN_WORKSPACE_ID, 'u01');

const serverSource = readFileSync(join(__dirname, 'server.ts'), 'utf8');
assert.match(
  serverSource,
  /function\s+syncMainWorkspaceSafely\(userId\?:\s*string\):\s*void\s*{\s*try\s*{\s*if\s*\(userId\)\s*syncMainWorkspaceUser\(userId\);\s*else\s*syncMainWorkspace\(\);\s*}\s*catch\s*\(error\)\s*{\s*console\.error\('\[main-workspace\] sync failed:',\s*error\);\s*}\s*}/,
  'server 應以 try/catch 包住 main workspace sync，失敗只記錄 error',
);
assert.match(
  serverSource,
  /loginLimiter\.reset\(ip\);[\s\S]*?syncMainWorkspaceSafely\(userId\);[\s\S]*?res\.writeHead\(200,/,
  '成功登入回應前應同步該使用者',
);
assert.match(
  serverSource,
  /syncMainWorkspaceSafely\(\);\s*(?:const PORT\s*=\s*3000;\s*)?server\.listen\(/,
  'server.listen 前應同步一次主工作區',
);

console.log('mainWorkspace.test.ts OK');
