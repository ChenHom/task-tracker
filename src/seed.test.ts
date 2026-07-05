import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';
import { seedUsers } from './seed';

const db = new DatabaseSync(':memory:');
runMigrations(db);

seedUsers(db);
const count1 = (db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
assert.strictEqual(count1, 30, '第一次 seed 應建立 30 位使用者');

seedUsers(db);
const count2 = (db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
assert.strictEqual(count2, 30, '重複 seed 不應增加使用者數量（idempotent）');

console.log('seed.test.ts OK');
