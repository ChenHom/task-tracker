import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';
import { seedUsers } from './seed';

const db = new DatabaseSync(':memory:');
runMigrations(db);

seedUsers(db);
const count1 = (db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
assert.strictEqual(count1, 30, '第一次 seed 應建立 30 位使用者');

const namedUsers = db.prepare("SELECT email, name FROM users WHERE email IN ('user01@test.local', 'user02@test.local', 'user03@test.local', 'user04@test.local', 'user05@test.local', 'user06@test.local') ORDER BY email").all() as
  { email: string; name: string }[];
assert.deepStrictEqual(namedUsers.map((user) => ({ email: user.email, name: user.name })), [
  { email: 'user01@test.local', name: '阿哲' },
  { email: 'user02@test.local', name: '小美' },
  { email: 'user03@test.local', name: '阿凱' },
  { email: 'user04@test.local', name: '婷婷' },
  { email: 'user05@test.local', name: '大熊' },
  { email: 'user06@test.local', name: '小芸' },
]);

const blankNames = (db.prepare("SELECT count(*) AS n FROM users WHERE trim(name) = ''").get() as { n: number }).n;
assert.strictEqual(blankNames, 0, 'seed 使用者都應有非空 name');

seedUsers(db);
const count2 = (db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
assert.strictEqual(count2, 30, '重複 seed 不應增加使用者數量（idempotent）');

const db2 = new DatabaseSync(':memory:');
runMigrations(db2);
const insertLegacyUser = db2.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)');
insertLegacyUser.run('legacy-u1', 'user01@test.local', '雅婷', 'hash');
insertLegacyUser.run('legacy-u2', 'user02@test.local', '未命名', 'hash');
insertLegacyUser.run('legacy-u3', 'user03@test.local', '未命名', 'hash');
insertLegacyUser.run('legacy-custom', 'user04@test.local', '既有姓名', 'hash');
insertLegacyUser.run('legacy-random-custom', 'user06@test.local', '自訂姓名', 'hash');
seedUsers(db2);
const legacyRows = db2.prepare("SELECT email, name FROM users WHERE email IN ('user01@test.local', 'user02@test.local', 'user03@test.local', 'user04@test.local', 'user06@test.local') ORDER BY email").all() as
  { email: string; name: string }[];
assert.deepStrictEqual(legacyRows.map((user) => ({ email: user.email, name: user.name })), [
  { email: 'user01@test.local', name: '阿哲' },
  { email: 'user02@test.local', name: '小美' },
  { email: 'user03@test.local', name: '阿凱' },
  { email: 'user04@test.local', name: '婷婷' },
  { email: 'user06@test.local', name: '小芸' },
]);

console.log('seed.test.ts OK');
