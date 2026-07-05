import { db } from './db';
import { createUser } from './auth';
import { CommandError } from './eventStore';

const COUNT = 30;
const PASSWORD = 'test1234';

// idempotent：email 固定可預期，重複執行時 createUser 對已存在的 email 丟 CommandError，直接跳過。
export function seedUsers(database = db): void {
  for (let i = 1; i <= COUNT; i++) {
    const email = `user${String(i).padStart(2, '0')}@test.local`;
    try {
      createUser(email, PASSWORD, database);
    } catch (e) {
      if (!(e instanceof CommandError)) throw e;
    }
  }
}

if (require.main === module) {
  seedUsers();
  console.log(`Seeded ${COUNT} users (user01@test.local ~ user${COUNT}@test.local, password: ${PASSWORD})`);
}
