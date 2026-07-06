// AI 模擬使用者 sim harness（Claude + Codex 混合車隊）
// 用法：npm run sim            — 完整一場（owner 開場 → 4 member 並行 → owner 收尾 → 統計）
//       npm run sim -- --smoke — 只跑 bootstrap + 1 haiku + 1 codex session，驗證管線
// 前置：task-tracker 跑在 localhost:3000、`npm run seed` 已建立 user01-30
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const BASE = 'http://localhost:3000';
const ROOT = join(__dirname, '..');
const LOG_DIR = join(ROOT, 'sim-logs');
const JAR_DIR = LOG_DIR; // persona 的 curl cookie jar 也放這，跑完可整目錄刪
const SMOKE = process.argv.includes('--smoke');
const PASSWORD = 'test1234';
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

interface Member {
  email: string;
  name: string;
  runner: 'claude' | 'codex';
  model: string;
  userId?: string;
}

const OWNER = { email: 'user01@test.local', name: '阿哲（Tech Lead / Owner）' };
const MEMBERS: Member[] = [
  { email: 'user02@test.local', name: '小美', runner: 'claude', model: 'claude-haiku-4-5-20251001' },
  { email: 'user03@test.local', name: '阿凱', runner: 'claude', model: 'claude-haiku-4-5-20251001' },
  { email: 'user04@test.local', name: '婷婷', runner: 'codex', model: 'gpt-5.4-mini' },
  { email: 'user05@test.local', name: '大熊', runner: 'codex', model: 'gpt-5.4-mini' },
];

// ── HTTP helpers（bootstrap 用，不經 LLM）────────────────────────────
async function api(path: string, init: RequestInit = {}, cookie?: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as any) };
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(BASE + path, { ...init, headers });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

async function login(email: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${email} 失敗: ${res.status}`);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const m = setCookie.match(/session=[^;]+/);
  if (!m) throw new Error(`login ${email} 沒拿到 session cookie`);
  return m[0];
}

// ── Bootstrap：建模擬 workspace、邀請、join ─────────────────────────
async function bootstrap(): Promise<{ wsId: string }> {
  const health = await api('/api/health');
  if (health.status !== 200) throw new Error('server 不在 localhost:3000，先啟動 task-tracker');

  const ownerCookie = await login(OWNER.email);
  const ws = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: `模擬場 ${new Date().toISOString().slice(0, 16)}` }) }, ownerCookie);
  if (ws.status !== 201) throw new Error(`建 workspace 失敗: ${JSON.stringify(ws.body)}`);
  const wsId: string = ws.body.id;

  for (const m of MEMBERS) {
    const inv = await api(`/api/workspaces/${wsId}/members`, { method: 'POST', body: JSON.stringify({ email: m.email, role: 'Member' }) }, ownerCookie);
    if (inv.status !== 200 && inv.status !== 201) throw new Error(`邀請 ${m.email} 失敗: ${JSON.stringify(inv.body)}`);
    const mc = await login(m.email);
    const join = await api(`/api/workspaces/${wsId}/members/join`, { method: 'POST' }, mc);
    if (join.status !== 200) throw new Error(`${m.email} join 失敗: ${JSON.stringify(join.body)}`);
  }

  const list = await api(`/api/workspaces/${wsId}/members`, {}, ownerCookie);
  for (const row of list.body as { user_id: string; email: string }[]) {
    const m = MEMBERS.find((x) => x.email === row.email);
    if (m) m.userId = row.user_id;
  }
  console.log(`[bootstrap] workspace=${wsId}，成員 ${list.body.length} 人已就位`);
  return { wsId };
}

// ── 子行程 spawn（兩條管線）─────────────────────────────────────────
function runSession(label: string, runner: 'claude' | 'codex', model: string, prompt: string): Promise<void> {
  const logFile = join(LOG_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.log`);
  const args = runner === 'claude'
    ? ['-p', prompt, '--model', model, '--allowedTools', 'Bash(curl:*)']
    : ['exec', '--ephemeral', '--skip-git-repo-check', '-C', LOG_DIR,
       '-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true',
       '-m', model, '--output-last-message', `${logFile}.last`, prompt];
  const cmd = runner === 'claude' ? 'claude' : 'codex';
  console.log(`[${label}] 開始（${runner}/${model}）`);
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: SESSION_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      writeFileSync(logFile, `PROMPT:\n${prompt}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}\n\nERR:${err ? String(err) : 'none'}\n`);
      const tail = (stdout || '').trim().split('\n').slice(-2).join(' / ');
      console.log(`[${label}] 結束${err ? `（異常: ${String(err).slice(0, 80)}）` : ''} — ${tail.slice(0, 160)}`);
      resolve(); // 單一 session 失敗不中斷整場
    });
    child.stdin?.end(); // codex exec 看到 piped stdin 會等 EOF，立即關閉避免卡死
  });
}

// ── Persona prompts ─────────────────────────────────────────────────
const RULES = (jar: string) => `
共通規則：
- 只能用 curl 操作 ${BASE} 的 API，其他工具一律不用。
- 先登入：curl -s -c ${jar} -X POST ${BASE}/api/auth/login -H 'Content-Type: application/json' -d '{"email":"<你的email>","password":"${PASSWORD}"}'
  之後所有請求都帶 -b ${jar}
- 狀態機：Todo→Doing→Review→Done 只能相鄰前進或一步回退；Archived 走 POST /api/tasks/<id>/archive。非法轉換伺服器會回 400，收到 400/409 就重新 GET 最新狀態再決定，不要硬闖。
- PATCH /api/tasks/<id> 一次只能改一個欄位，body 例如 {"status":"Doing"} 或 {"priority":"High"}。
- 留言 POST /api/tasks/<id>/comments body {"content":"..."}，一律正體中文、像真的工程師（講進度、卡點、具體細節），1-3 句。
- Dogfooding QA：操作中遇到疑似系統 bug（非預期 500、錯誤訊息不清楚、權限或狀態機行為怪異）→ 先重試自查一次，可重現就建 [BUG] task：
  POST /api/workspaces/<wsId>/tasks body {"title":"[BUG] <一句話>","description":"重現步驟：...\\n預期：...\\n實際：...\\n原始回應：...","priority":"High"}
- 全程最多 12 個 curl 呼叫。結束時輸出一行總結：本次做了什麼。`;

function memberPrompt(m: Member, wsId: string, sessionNo: number): string {
  const jar = join(JAR_DIR, `jar-${m.email.split('@')[0]}.txt`);
  return `你是「${m.name}」（${m.email}），task-tracker 團隊的工程師。這是你今天第 ${sessionNo} 次上線。
工作 workspace：${wsId}，你的 user_id：${m.userId}。
${RULES(jar)}
本次要做的事：
1. GET ${BASE}/api/workspaces/${wsId}/tasks，找出 assignee_id 等於你的 user_id、且 status 是 Todo 或 Doing 的 task
2. 挑一件推進一步（Todo→Doing 或 Doing→Review），PATCH 前先想清楚目前狀態
3. 對該 task 留言：正在做什麼／遇到什麼、下一步
4. 如果沒有任何指派給你的可推進 task：挑一個 workspace 裡的 task 留言詢問，或建一個 task（標題「詢問：目前沒有指派給${m.name}的工作」）請 owner 指派`;
}

function ownerOpenPrompt(wsId: string): string {
  const jar = join(JAR_DIR, 'jar-owner.txt');
  const roster = MEMBERS.map((m) => `- ${m.name}: user_id=${m.userId}`).join('\n');
  return `你是「${OWNER.name}」（${OWNER.email}），task-tracker 的 Owner。現在開一個新 sprint。
工作 workspace：${wsId}。
${RULES(jar)}
團隊成員（指派 task 用 assignee 欄位填 user_id）：
${roster}
本次要做的事：
1. 建一個 project：POST ${BASE}/api/workspaces/${wsId}/projects body {"name":"task-tracker 下一版"}
2. 建 8 個 task（POST ${BASE}/api/workspaces/${wsId}/tasks，body 可用欄位：title/description/priority(Low|Medium|High)/assignee/projectId），
   從下列真實技術債挑選並潤飾成具體工作項（標題要像真的 sprint 項目，描述含改哪裡與驗收方式）：
   - session cookie 加 Secure flag（HTTPS 部署前提）
   - attachment 目錄 symlink 硬化（realpath 檢查補完）
   - 搜尋從 LIKE 換成 SQLite FTS5
   - rate limiter 的 in-memory Map 加上限與清理（LRU）
   - attachment 上傳改 multipart（現為 raw body + X-Filename）
   - 導入正式 migration 工具（版本化/回滾）
   - reverse proxy 下的 client IP 處理（X-Forwarded-For 信任設定）
   - session 過期資料清理排程（現在只在查詢時懶清）
3. 每個 task 平均指派給四位成員（assignee 填 user_id）
4. 對每個 task 留一則說明留言（為什麼做、注意什麼）`;
}

function ownerClosePrompt(wsId: string): string {
  const jar = join(JAR_DIR, 'jar-owner-close.txt');
  return `你是「${OWNER.name}」（${OWNER.email}），task-tracker 的 Owner。sprint 接近尾聲，來巡場收尾。
工作 workspace：${wsId}。
${RULES(jar)}
本次要做的事：
1. GET ${BASE}/api/workspaces/${wsId}/tasks 看全貌
2. 對每個 status=Review 的 task：GET 它的 comments 了解脈絡 → 留一則檢視意見 → PATCH {"status":"Done"}（若明顯沒做完就留言退回原因並 PATCH {"status":"Doing"}）
3. 對還停在 Todo 且沒人留言的 task：留一則催辦留言
4. 對每個標題 [BUG] 開頭的 task：檢視描述，留言確認或補充，並視嚴重度 PATCH priority
5. 挑一個活動最多的 task，GET ${BASE}/api/audit?aggregate_id=<task_id> 看它的完整歷史，在總結中描述這個 task 的生命週期
6. 結束輸出 3-5 行 sprint 總結`;
}

// ── 統計 ────────────────────────────────────────────────────────────
function printStats(wsId: string, since: string): void {
  const db = new DatabaseSync(join(ROOT, 'data/dev.db'));
  const tasks = db.prepare('SELECT task_id, title, status, priority, assignee_id FROM tasks_read_model WHERE workspace_id = ?').all(wsId) as any[];
  const byStatus: Record<string, number> = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  const comments = db.prepare(`SELECT count(*) AS n FROM comments WHERE task_id IN (SELECT task_id FROM tasks_read_model WHERE workspace_id = ?)`).get(wsId) as any;
  const events = db.prepare('SELECT count(*) AS n FROM event_store WHERE occurred_at >= ?').get(since) as any;
  console.log('\n===== 本場統計 =====');
  console.log(`tasks: ${tasks.length}（${Object.entries(byStatus).map(([k, v]) => `${k}:${v}`).join('、')}）`);
  console.log(`comments: ${comments.n}，event_store 新增事件: ${events.n}`);
  const bugs = tasks.filter((t) => String(t.title).startsWith('[BUG]'));
  console.log(`[BUG] tasks: ${bugs.length}`);
  for (const b of bugs) console.log(`  - [${b.status}/${b.priority}] ${b.title}`);
  console.log(`檢視看板：${BASE} 登入 ${OWNER.email} / ${PASSWORD}`);
}

// ── 主流程 ──────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (minS: number, maxS: number) => (minS + Math.random() * (maxS - minS)) * 1000;

async function main(): Promise<void> {
  mkdirSync(LOG_DIR, { recursive: true });
  const since = new Date().toISOString();
  const { wsId } = await bootstrap();

  if (SMOKE) {
    // 每條管線各跑一個 member session（此時沒有指派 task，會走「建詢問 task」分支——剛好測到建 task 路徑）
    await runSession('smoke-haiku-小美', 'claude', MEMBERS[0].model, memberPrompt(MEMBERS[0], wsId, 1));
    await runSession('smoke-codex-婷婷', 'codex', MEMBERS[2].model, memberPrompt(MEMBERS[2], wsId, 1));
    printStats(wsId, since);
    return;
  }

  await runSession('owner-開場', 'claude', 'claude-opus-4-8', ownerOpenPrompt(wsId));

  await Promise.all(MEMBERS.map(async (m) => {
    await sleep(jitter(5, 30)); // 錯開起跑
    for (let i = 1; i <= 3; i++) {
      await runSession(`${m.name}-s${i}`, m.runner, m.model, memberPrompt(m, wsId, i));
      if (i < 3) await sleep(jitter(60, 300)); // 不定時：1-5 分鐘
    }
  }));

  await runSession('owner-收尾', 'claude', 'claude-opus-4-8', ownerClosePrompt(wsId));
  printStats(wsId, since);
}

main().catch((e) => { console.error(e); process.exit(1); });
