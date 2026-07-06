import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';
import { seedUsers } from './seed';

const db = new DatabaseSync(':memory:');
runMigrations(db);

seedUsers(db);
const count1 = (db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
assert.strictEqual(count1, 30, '第一次 seed 應建立 30 位使用者');

const namedUsers = db.prepare("SELECT email, name FROM users WHERE email IN ('user02@test.local', 'user03@test.local', 'user04@test.local', 'user05@test.local') ORDER BY email").all() as
  { email: string; name: string }[];
assert.deepStrictEqual(namedUsers.map((user) => ({ email: user.email, name: user.name })), [
  { email: 'user02@test.local', name: '小美' },
  { email: 'user03@test.local', name: '阿凱' },
  { email: 'user04@test.local', name: '婷婷' },
  { email: 'user05@test.local', name: '大熊' },
]);

const blankNames = (db.prepare("SELECT count(*) AS n FROM users WHERE trim(name) = ''").get() as { n: number }).n;
assert.strictEqual(blankNames, 0, 'seed 使用者都應有非空 name');

seedUsers(db);
const count2 = (db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
assert.strictEqual(count2, 30, '重複 seed 不應增加使用者數量（idempotent）');

console.log('seed.test.ts OK');
