import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runMigrations } from './schema';

const DATA_DIR = process.env.TASK_TRACKER_DATA_DIR ?? join(__dirname, '../data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'dev.db'));
// server、goal-coordinator、sim-coordinator 各自開連線寫同一個檔；沒有 busy_timeout 時撞鎖會立刻丟 database is locked
db.exec('PRAGMA busy_timeout = 5000');
runMigrations(db);
