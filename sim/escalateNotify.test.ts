import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { scanNewEscalates } from './escalateNotify';

const dir = mkdtempSync(join(tmpdir(), 'esc-notify-'));
const dbPath = join(dir, 'dev.db');
const db = new DatabaseSync(dbPath);
db.exec(`CREATE TABLE comments (
  comment_id TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE tasks_read_model (
  task_id TEXT PRIMARY KEY, workspace_id TEXT, project_id TEXT, title TEXT,
  description TEXT, status TEXT, priority TEXT, assignee_id TEXT, due_at TEXT,
  version INTEGER, updated_at TEXT
);`);
db.prepare("INSERT INTO tasks_read_model (task_id, title) VALUES ('t1', '[BUG] guard 卡住')").run();
db.prepare("INSERT INTO comments VALUES ('c1','t1','u3','[ESCALATE] 部署漂移','2026-07-17T10:00:00Z')").run();
db.prepare("INSERT INTO comments VALUES ('c2','t1','u3','一般留言','2026-07-17T10:01:00Z')").run();
db.close();

const statePath = join(dir, 'state.json');

// 第一次掃描：撈到 1 則、狀態前進
const sent: string[] = [];
let n = scanNewEscalates(dbPath, statePath, (msg) => sent.push(msg));
assert.strictEqual(n, 1, '首掃應撈到 1 則 ESCALATE');
assert.ok(sent[0].includes('[BUG] guard 卡住') && sent[0].includes('部署漂移'), '訊息含 task 標題與內容');

// 第二次掃描：無新 ESCALATE → 不發送（去重核心）
n = scanNewEscalates(dbPath, statePath, (msg) => sent.push(msg));
assert.strictEqual(n, 0, '重掃不得重複通知');
assert.strictEqual(sent.length, 1);

// 新 ESCALATE 進來 → 只通知新的那則
const db2 = new DatabaseSync(dbPath);
db2.prepare("INSERT INTO comments VALUES ('c3','t1','u3','[ESCALATE] 新阻塞','2026-07-17T11:00:00Z')").run();
db2.close();
n = scanNewEscalates(dbPath, statePath, (msg) => sent.push(msg));
assert.strictEqual(n, 1, '第三掃只撈新增那則');
assert.ok(sent[1].includes('新阻塞'));

console.log('escalateNotify.test.ts OK');
