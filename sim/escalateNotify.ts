import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

interface EscRow { rowid: number; content: string; created_at: string; title: string | null }

// 掃描 state 記錄點之後的新 [ESCALATE] 留言，逐則交給 send；state 前進到全表 MAX(rowid)。
export function scanNewEscalates(dbPath: string, statePath: string, send: (msg: string) => void): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let last = 0;
  try {
    last = JSON.parse(readFileSync(statePath, 'utf8')).lastRowid ?? 0;
  } catch { /* 首次執行：state 不存在 */ }
  const rows = db.prepare(`SELECT c.rowid AS rowid, c.content, c.created_at, t.title
    FROM comments c LEFT JOIN tasks_read_model t ON t.task_id = c.task_id
    WHERE c.rowid > ? AND c.content LIKE '%[ESCALATE]%' ORDER BY c.rowid`).all(last) as unknown as EscRow[];
  for (const r of rows) {
    send(`🚨 [ESCALATE] ${r.title ?? '(unknown task)'}｜${r.created_at}\n${r.content.slice(0, 300)}`);
  }
  const maxRowid = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM comments').get() as unknown as { m: number };
  db.close();
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ lastRowid: maxRowid.m }));
  return rows.length;
}

// CLI 進入點：node --import tsx sim/escalateNotify.ts [dbPath]
if (require.main === module) {
  const dbPath = process.argv[2] ?? join(__dirname, '..', 'data', 'dev.db');
  const statePath = join(process.env.HOME ?? '/home/hom', '.local', 'state', 'sim-escalate', 'state.json');
  const n = scanNewEscalates(dbPath, statePath, (msg) => {
    try {
      execFileSync(join(__dirname, 'notify-human.sh'), [msg], { stdio: 'ignore' });
    } catch (e) {
      console.error('notify failed:', (e as Error).message);
    }
  });
  console.log(`escalate-notify: ${n} new`);
}
