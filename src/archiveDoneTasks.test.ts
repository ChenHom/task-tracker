import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// archiveDoneTasks 的 CLI 進入點必須自己註冊 projection：appendEvent 只跑「已註冊」的
// projection，少了那行事件會寫進 event_store 而 tasks_read_model 不動（看板照舊顯示 Done），
// 下一輪掃描撈到同一批、對已 archived 的 aggregate 再 append 就整支 crash。
// 這個行為只有把 CLI 當獨立 process 跑才看得出來——在同一個 process 內測，projection 早被
// 別的 import 註冊掉了，缺陷會被蓋住。
const dataDir = mkdtempSync(join(tmpdir(), 'task-tracker-archive-test-'));
const cli = join(__dirname, 'archiveDoneTasks.ts');

function runCli(): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', cli], {
      env: { ...process.env, TASK_TRACKER_DATA_DIR: dataDir },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { stdout: `${err.stdout ?? ''}${err.stderr ?? ''}`, status: err.status ?? 1 };
  }
}

// 先讓 CLI 跑一次把 schema 建起來（沒有資料，應回報 0 筆）
const bootstrap = runCli();
assert.strictEqual(bootstrap.status, 0, `CLI 首次執行應成功，實際輸出：${bootstrap.stdout}`);

const db = new DatabaseSync(join(dataDir, 'dev.db'));
db.prepare('INSERT INTO workspaces_read_model (workspace_id, name, status, created_at) VALUES (?, ?, ?, ?)')
  .run('ws-archive', '歸檔測試', 'active', '2026-07-01T00:00:00.000Z');
// 直接寫 read model + event_store，模擬「已 Done 超過七天」的既有資料
db.prepare(
  `INSERT INTO tasks_read_model (task_id, workspace_id, title, description, status, priority, done_at, version, updated_at)
   VALUES (?, ?, ?, '', 'Done', 'Medium', ?, 1, ?)`,
).run('t-old', 'ws-archive', '七天前就 Done 的任務', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
db.prepare(
  `INSERT INTO event_store (aggregate_type, aggregate_id, aggregate_version, event_type, payload_json, metadata_json, occurred_at)
   VALUES ('Task', 't-old', 1, 'task.created', ?, '{}', '2026-07-01T00:00:00.000Z')`,
).run(JSON.stringify({ workspaceId: 'ws-archive', title: '七天前就 Done 的任務', description: '', status: 'Done', priority: 'Medium' }));
db.close();

// 第一次真正掃描：事件寫入之外，read model 必須同步變成 Archived
const first = runCli();
assert.strictEqual(first.status, 0, `第一次掃描應成功，實際輸出：${first.stdout}`);
assert.match(first.stdout, /Archived 1 task/, `應回報實際歸檔 1 筆，實際輸出：${first.stdout}`);

const db2 = new DatabaseSync(join(dataDir, 'dev.db'));
const afterFirst = db2.prepare('SELECT status FROM tasks_read_model WHERE task_id = ?').get('t-old') as { status: string };
assert.strictEqual(afterFirst.status, 'Archived', 'CLI 執行後 read model 必須同步成 Archived，不能只寫 event_store');
const events = db2.prepare("SELECT COUNT(*) AS c FROM event_store WHERE aggregate_id = ? AND event_type = 'task.archived'").get('t-old') as { c: number };
assert.strictEqual(events.c, 1, '應寫入一筆 task.archived 事件');
db2.close();

// 第二次掃描：不得重複歸檔，也不得因為 aggregate 已 archived 而 crash
const second = runCli();
assert.strictEqual(second.status, 0, `重跑不得失敗，實際輸出：${second.stdout}`);
assert.match(second.stdout, /Archived 0 task/, `重跑應回報 0 筆，實際輸出：${second.stdout}`);

const db3 = new DatabaseSync(join(dataDir, 'dev.db'));
const events2 = db3.prepare("SELECT COUNT(*) AS c FROM event_store WHERE aggregate_id = ? AND event_type = 'task.archived'").get('t-old') as { c: number };
assert.strictEqual(events2.c, 1, '重跑不得產生第二筆 task.archived 事件');
db3.close();

rmSync(dataDir, { recursive: true, force: true });
console.log('archiveDoneTasks.test.ts OK');
