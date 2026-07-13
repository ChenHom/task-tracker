import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';
import {
  appendEvent,
  appendEventInTransaction,
  loadEvents,
  rebuild,
  registerProjection,
  resetProjections,
  ConcurrencyError,
} from './eventStore';

// 獨立 in-memory db + 一張 demo read model，驗證 append → project → read model 這條線。
const db = new DatabaseSync(':memory:');
runMigrations(db);
db.exec('CREATE TABLE demo_rm (aggregate_id TEXT PRIMARY KEY, count INTEGER NOT NULL)');

resetProjections();
registerProjection('demo.incremented', (e, database) => {
  const cur = database.prepare('SELECT count FROM demo_rm WHERE aggregate_id = ?').get(e.aggregate_id) as
    | { count: number }
    | undefined;
  const n = (cur?.count ?? 0) + 1;
  database
    .prepare('INSERT INTO demo_rm (aggregate_id, count) VALUES (?, ?) ON CONFLICT(aggregate_id) DO UPDATE SET count = ?')
    .run(e.aggregate_id, n, n);
});

// ── 樂觀鎖：版本遞增 ──
const e1 = appendEvent('Demo', 'agg-1', 0, 'demo.incremented', {}, {}, db);
assert.strictEqual(e1.aggregate_version, 1, '第一個事件 expectedVersion=0 → v1');
const e2 = appendEvent('Demo', 'agg-1', 1, 'demo.incremented', {}, {}, db);
assert.strictEqual(e2.aggregate_version, 2, '第二個事件 expectedVersion=1 → v2');

// ── 樂觀鎖：expectedVersion 對不上 → 拒絕 + rollback ──
assert.throws(
  () => appendEvent('Demo', 'agg-1', 0, 'demo.incremented', {}, {}, db),
  ConcurrencyError,
  '過期的 expectedVersion 應丟 ConcurrencyError',
);
assert.strictEqual(loadEvents('agg-1', db).length, 2, 'ConcurrencyError 後不應留下多餘事件（rollback 生效）');

// ── 端到端：append → project → read model 有值 ──
const rm = db.prepare('SELECT count FROM demo_rm WHERE aggregate_id = ?').get('agg-1') as { count: number };
assert.strictEqual(rm.count, 2, 'append → project → read model：agg-1 count 應為 2');

// ── loadEvents：排序 + payload/metadata parse ──
appendEvent('Demo', 'agg-2', 0, 'demo.incremented', { note: 'hi' }, { actor: 'u1' }, db);
const evs = loadEvents('agg-2', db);
assert.strictEqual(evs.length, 1);
assert.strictEqual(evs[0].aggregate_version, 1);
assert.deepStrictEqual(evs[0].payload, { note: 'hi' }, 'payload 應被 parse 回物件');
assert.deepStrictEqual(evs[0].metadata, { actor: 'u1' }, 'metadata 應被 parse 回物件');

// ── rebuild：事件流 reduce 成現狀 ──
assert.strictEqual(
  rebuild('agg-1', (s: number) => s + 1, 0, db),
  2,
  'rebuild 應把 agg-1 的 2 個事件 reduce 成 2',
);

assert.throws(
  () => appendEventInTransaction('Demo', 'tx-outside', 0, 'demo.incremented', {}, {}, db),
  /active transaction|not a function/,
  'caller 未開 transaction 時不可使用內層 append',
);

db.exec('BEGIN IMMEDIATE');
appendEventInTransaction('Demo', 'tx-rollback', 0, 'demo.incremented', {}, {}, db);
db.exec('ROLLBACK');
assert.strictEqual(loadEvents('tx-rollback', db).length, 0, '外層 rollback 應移除 event');
assert.strictEqual(
  db.prepare('SELECT count FROM demo_rm WHERE aggregate_id = ?').get('tx-rollback'),
  undefined,
  '外層 rollback 應一併移除 projection',
);

db.exec('BEGIN IMMEDIATE');
appendEventInTransaction('Demo', 'tx-commit', 0, 'demo.incremented', {}, {}, db);
db.exec('COMMIT');
assert.strictEqual(loadEvents('tx-commit', db).length, 1, '外層 commit 應保存 event');

// ── projection 一對一：重複註冊同 event_type 應報錯 ──
assert.throws(() => registerProjection('demo.incremented', () => {}), /已註冊/, '同 event_type 重複註冊 projection 應報錯');

console.log('eventStore.test.ts OK');
