import { db } from './db';
import { createUser } from './auth';
import { CommandError } from './eventStore';

const COUNT = 30;
const PASSWORD = 'test1234';

const FIXED_NAMES: Record<string, string> = {
  'user02@test.local': '小美',
  'user03@test.local': '阿凱',
  'user04@test.local': '婷婷',
  'user05@test.local': '大熊',
};

const RANDOM_NAME_POOL = [
  '小明',
  '小華',
  '小安',
  '小宇',
  '小晴',
  '小杰',
  '阿哲',
  '阿倫',
  '阿翔',
  '阿豪',
  '佳佳',
  '雅婷',
  '怡君',
  '志明',
  '家豪',
  '冠宇',
  '宜蓁',
  '佩珊',
  '柏翰',
  '采薇',
];

function randomName(): string {
  return RANDOM_NAME_POOL[Math.floor(Math.random() * RANDOM_NAME_POOL.length)];
}

function backfillDefaultName(email: string, name: string, database = db): void {
  database
    .prepare("UPDATE users SET name = ? WHERE email = ? AND (trim(name) = '' OR name = '未命名')")
    .run(name, email);
}

// idempotent：email 固定可預期，重複執行時 createUser 對已存在的 email 丟 CommandError，直接跳過。
export function seedUsers(database = db): void {
  for (let i = 1; i <= COUNT; i++) {
    const email = `user${String(i).padStart(2, '0')}@test.local`;
    const name = FIXED_NAMES[email] ?? randomName();
    try {
      createUser(email, name, PASSWORD, database);
    } catch (e) {
      if (!(e instanceof CommandError)) throw e;
      backfillDefaultName(email, name, database);
    }
  }
}

if (require.main === module) {
  seedUsers();
  console.log(`Seeded ${COUNT} users (user01@test.local ~ user${COUNT}@test.local, password: ${PASSWORD})`);
}
