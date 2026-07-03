import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';
import { loadEvents, resetProjections, CommandError } from './eventStore';
import {
  createWorkspace,
  renameWorkspace,
  archiveWorkspace,
  deleteWorkspace,
  registerWorkspaceProjections,
  listWorkspaces,
} from './workspace';
import { registerMemberProjections } from './member';

const db = new DatabaseSync(':memory:');
runMigrations(db);
resetProjections();
registerWorkspaceProjections();
registerMemberProjections(); // createWorkspace 會 seedOwner → 需要 member.joined projection

// ── create → read model 有值（name 應 trim）──
const id = createWorkspace('u1', '  My Space  ', db);
let rows = listWorkspaces('u1', db);
assert.strictEqual(rows.length, 1, 'create 後 read model 應有一列');
assert.strictEqual(rows[0].name, 'My Space', 'name 應被 trim');
assert.strictEqual(rows[0].status, 'active');

// ── rename → projection 更新 ──
renameWorkspace('u1', id, 'Renamed', db);
assert.strictEqual(listWorkspaces('u1', db)[0].name, 'Renamed', 'rename 後 read model name 應更新');

// ── 狀態機：active → archived ──
archiveWorkspace('u1', id, db);
assert.strictEqual(listWorkspaces('u1', db)[0].status, 'archived', 'archive 後 status 應為 archived');

// ── 狀態機：archived 不允許 rename / 重複 archive ──
assert.throws(() => renameWorkspace('u1', id, 'X', db), CommandError, 'archived 不可改名');
assert.throws(() => archiveWorkspace('u1', id, db), CommandError, '重複 archive 應拒絕');

// ── 狀態機：archived → deleted（可），deleted 從列表消失 ──
deleteWorkspace('u1', id, db);
assert.strictEqual(listWorkspaces('u1', db).length, 0, 'deleted 不應出現在列表');

// ── 狀態機：deleted 是終態，任何操作都拒絕 ──
assert.throws(() => deleteWorkspace('u1', id, db), CommandError, '重複 delete 應拒絕');
assert.throws(() => renameWorkspace('u1', id, 'X', db), CommandError, 'deleted 不可改名');

// ── 不存在的 aggregate ──
assert.throws(() => renameWorkspace('u1', 'no-such-id', 'X', db), CommandError, '不存在的 workspace 應拒絕');

// ── 輸入驗證（信任邊界）──
assert.throws(() => createWorkspace('u1', '', db), CommandError, '空 name 應拒絕');
assert.throws(() => createWorkspace('u1', '   ', db), CommandError, '純空白 name 應拒絕');
assert.throws(() => createWorkspace('u1', 123 as unknown, db), CommandError, '非字串 name 應拒絕');

// ── 事件流：版本連續遞增 + metadata 記 actor_id ──
const events = loadEvents(id, db);
assert.deepStrictEqual(
  events.map((e) => e.event_type),
  ['workspace.created', 'workspace.renamed', 'workspace.archived', 'workspace.deleted'],
  '4 個事件依序寫入',
);
assert.deepStrictEqual(events.map((e) => e.aggregate_version), [1, 2, 3, 4], '版本連續遞增');
assert.deepStrictEqual(events[0].metadata, { actor_id: 'u1' }, 'metadata 應記 actor_id');

console.log('workspace.test.ts OK');
