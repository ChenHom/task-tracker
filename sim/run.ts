// AI 團隊真實 sprint sim（Claude + Codex 混合車隊，真討論/真實作/真審查）
// 用法：npm run sim            — 完整一場（owner 開場 → member 輪1 → owner 中場審查 → member 輪2-3 → owner 收尾 merge → 統計）
//       npm run sim -- --smoke — 只跑 bootstrap + 1 haiku + 1 codex session，驗證管線
// 前置：task-tracker 跑在 localhost:3000、`npm run seed` 已建立 user01-30、工作樹乾淨（會打 tag）
// 回退：git reset --hard <本場 tag>；git worktree remove sim-work/<u> --force；git branch -D sim/<u>
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const BASE = 'http://localhost:3000';
const ROOT = join(__dirname, '..');
const LOG_DIR = join(ROOT, 'sim-logs');
const WORK_DIR = join(ROOT, 'sim-work');
const SMOKE = process.argv.includes('--smoke');
const PASSWORD = 'test1234';
const MEMBER_TIMEOUT = 12 * 60 * 1000;
const OWNER_TIMEOUT = 15 * 60 * 1000;

interface Member {
  email: string;
  name: string;
  user: string; // email 前綴，branch/worktree 命名用
  runner: 'claude' | 'codex';
  model: string;
  userId?: string;
}

const OWNER = { email: 'user01@test.local', name: '阿哲（Tech Lead / Owner）' };
const MEMBERS: Member[] = [
  { email: 'user02@test.local', name: '小美', user: 'user02', runner: 'claude', model: 'claude-haiku-4-5-20251001' },
  { email: 'user03@test.local', name: '阿凱', user: 'user03', runner: 'claude', model: 'claude-haiku-4-5-20251001' },
  { email: 'user04@test.local', name: '婷婷', user: 'user04', runner: 'codex', model: 'gpt-5.4-mini' },
  { email: 'user05@test.local', name: '大熊', user: 'user05', runner: 'codex', model: 'gpt-5.4-mini' },
];
const wt = (m: Member) => join(WORK_DIR, m.user);
const branch = (m: Member) => `sim/${m.user}`;

// 6 個真技術債（same-file 給同人避免 merge 衝突）；owner 開場照表建 task
const BACKLOG = (byName: Record<string, string>) => [
  { assignee: byName['小美'], title: 'session cookie 加 Secure flag', desc: 'src/auth.ts 的 sessionCookie()/clearSessionCookie() 目前沒有 Secure 屬性（見 ponytail 註記）。加環境變數開關（如 COOKIE_SECURE=1 時附加 Secure），本機 http dev 預設不開。驗收：auth.test.ts 補一條開關行為的 assert，npx tsc --noEmit 與 npm test 全過。' },
  { assignee: byName['小美'], title: 'session 過期資料清理', desc: 'sessions 表的過期 row 目前只在 getSessionUser 查到時懶清（src/auth.ts）。在 server 啟動時（src/server.ts）加一次 DELETE FROM sessions WHERE expires_at <= now 的清理（src/auth.ts 加 cleanupExpiredSessions() 供呼叫與測試）。驗收：auth.test.ts 補測試，tsc/test 全過。' },
  { assignee: byName['阿凱'], title: 'rate limiter Map 加上限防無限成長', desc: 'src/rateLimit.ts 的 in-memory Map 沒有上限（見檔頭 ponytail 註記）。加 maxKeys 上限（預設 10000），超過時清除已過期的 entry，仍超過就拒收新 key 或清最舊。維持現有介面與測試不變。驗收：rateLimit.test.ts 補上限行為測試，tsc/test 全過。' },
  { assignee: byName['阿凱'], title: 'search LIKE 特殊字元跳脫', desc: 'src/search.ts 用 LIKE 查詢，使用者輸入含 % 或 _ 會變萬用字元。用 ESCAPE 子句跳脫 %、_、跳脫字元本身。驗收：search.test.ts 補「查詢含 % 與 _ 字面值」的測試，tsc/test 全過。' },
  { assignee: byName['婷婷'], title: 'attachment 讀寫路徑 symlink 硬化', desc: 'src/attachment.ts 讀/刪附件時用 stored_name 組路徑，未做 realpath 檢查——若 ATTACH_DIR 內出現 symlink 可逃出目錄。在 readAttachment/deleteAttachment 實際碰檔案前用 realpathSync 確認解析後路徑仍在 ATTACH_DIR 內，否則丟 CommandError。驗收：attachment.test.ts 補 symlink 逃逸被擋的測試，tsc/test 全過。' },
  { assignee: byName['大熊'], title: 'clientIp 支援 X-Forwarded-For', desc: 'src/server.ts 的 clientIp() 直取 socket（見 ponytail 註記），過 reverse proxy 後 rate limit 會全部算在 proxy IP 上。加 TRUST_PROXY=1 環境變數開關：開啟時取 X-Forwarded-For 最左邊的 IP，未開啟維持現狀。驗收：把 clientIp 抽成可測函式並補測試，tsc/test 全過。' },
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
  const m = (res.headers.get('set-cookie') ?? '').match(/session=[^;]+/);
  if (!m) throw new Error(`login ${email} 沒拿到 session cookie`);
  return m[0];
}

const git = (args: string[], cwd = ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// ── Bootstrap：tag、workspace、worktrees ────────────────────────────
async function bootstrap(): Promise<{ wsId: string; tag: string }> {
  const health = await api('/api/health');
  if (health.status !== 200) throw new Error('server 不在 localhost:3000，先啟動 task-tracker');
  if (git(['status', '--porcelain'])) throw new Error('工作樹不乾淨，先 commit 再跑 sim');

  const tag = `sim-run-${Date.now()}`;
  git(['tag', tag]);

  // 工作區（已存在就報錯，附清理指令——不自動刪上一場成果）
  // claude member 用 worktree；codex member 用 local clone——codex sandbox 只能寫
  // workspace 目錄，worktree 的 git 元資料在主 repo .git/ 裡會被擋（實測：commit 失敗），
  // clone 的 .git 完整在 workspace 內就沒這問題。owner 審查前 driver 會 fetch 回主 repo。
  for (const m of MEMBERS) {
    if (existsSync(wt(m))) throw new Error(`${wt(m)} 已存在。清理：${m.runner === 'codex' ? `rm -rf sim-work/${m.user}` : `git worktree remove sim-work/${m.user} --force`} && git branch -D sim/${m.user} 2>/dev/null`);
    if (m.runner === 'codex') {
      git(['clone', '--quiet', ROOT, wt(m)]);
      git(['checkout', '-q', '-b', branch(m)], wt(m));
    } else {
      git(['worktree', 'add', wt(m), '-b', branch(m), 'master']);
    }
    symlinkSync(join(ROOT, 'node_modules'), join(wt(m), 'node_modules'));
  }

  const ownerCookie = await login(OWNER.email);
  const ws = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: `真實 Sprint ${new Date().toISOString().slice(0, 16)}` }) }, ownerCookie);
  if (ws.status !== 201) throw new Error(`建 workspace 失敗: ${JSON.stringify(ws.body)}`);
  const wsId: string = ws.body.id;

  for (const m of MEMBERS) {
    const inv = await api(`/api/workspaces/${wsId}/members`, { method: 'POST', body: JSON.stringify({ email: m.email, role: 'Member' }) }, ownerCookie);
    if (inv.status !== 200 && inv.status !== 201) throw new Error(`邀請 ${m.email} 失敗: ${JSON.stringify(inv.body)}`);
    const mc = await login(m.email);
    const join_ = await api(`/api/workspaces/${wsId}/members/join`, { method: 'POST' }, mc);
    if (join_.status !== 200) throw new Error(`${m.email} join 失敗: ${JSON.stringify(join_.body)}`);
  }
  const list = await api(`/api/workspaces/${wsId}/members`, {}, ownerCookie);
  for (const row of list.body as { user_id: string; email: string }[]) {
    const m = MEMBERS.find((x) => x.email === row.email);
    if (m) m.userId = row.user_id;
  }
  console.log(`[bootstrap] tag=${tag} workspace=${wsId} 成員就位，worktrees 建於 sim-work/`);
  return { wsId, tag };
}

// ── 子行程 spawn ────────────────────────────────────────────────────
// Claude Code 的 Bash 權限用冒號前綴語法 Bash(<cmd>:*)（實測：空格版 Bash(curl *) 會卡在權限批准）
const MEMBER_TOOLS = 'Bash(curl:*),Bash(npx:*),Bash(npm:*),Bash(git:*),Read,Write,Edit,Glob,Grep';
const OWNER_TOOLS = 'Bash(curl:*),Bash(npx:*),Bash(npm:*),Bash(git:*),Read,Glob,Grep';

function runSession(label: string, runner: 'claude' | 'codex', model: string, prompt: string, opts: { cwd: string; tools: string; timeoutMs: number }): Promise<void> {
  const logFile = join(LOG_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.log`);
  const args = runner === 'claude'
    ? ['-p', prompt, '--model', model, '--allowedTools', opts.tools]
    : ['exec', '--ephemeral', '--skip-git-repo-check', '-C', opts.cwd,
       '-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true',
       '-m', model, '--output-last-message', `${logFile}.last`, prompt];
  console.log(`[${label}] 開始（${runner}/${model}）`);
  return new Promise((resolve) => {
    const child = execFile(runner === 'claude' ? 'claude' : 'codex', args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        writeFileSync(logFile, `PROMPT:\n${prompt}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}\n\nERR:${err ? String(err) : 'none'}\n`);
        const tail = (stdout || '').trim().split('\n').slice(-2).join(' / ');
        console.log(`[${label}] 結束${err ? `（異常: ${String(err).slice(0, 80)}）` : ''} — ${tail.slice(0, 200)}`);
        resolve(); // 單一 session 失敗不中斷整場
      });
    child.stdin?.end(); // codex exec 看到 piped stdin 會等 EOF
  });
}

// ── Prompts ─────────────────────────────────────────────────────────
const API_RULES = (jar: string) => `
API 操作規則（task-tracker 是團隊的協作看板，所有溝通都要留在上面）：
- 登入：curl -s -c ${jar} -X POST ${BASE}/api/auth/login -H 'Content-Type: application/json' -d '{"email":"<你的email>","password":"${PASSWORD}"}'，之後帶 -b ${jar}
- 狀態機：Todo→Doing→Review→Done 相鄰前進或一步回退；PATCH /api/tasks/<id> 一次只能改一個欄位（如 {"status":"Doing"}）；400/409 就重新 GET 再決定
- 留言 POST /api/tasks/<id>/comments {"content":"..."}：正體中文、像真的工程師、具體（做法/卡點/驗證結果）
- 遇疑似系統 bug：自查重試一次，可重現就建 [BUG] task（POST /api/workspaces/<ws>/tasks，title 以 [BUG] 開頭，description 含重現步驟/預期 vs 實際/原始回應，priority High）
- 卡在環境/權限/工具問題（不是 code 本身的問題）：在該 task 留言以 [ESCALATE] 開頭，寫清楚卡點與已試過的方法，然後繼續做還能做的部分——owner 會處理，owner 也解不了會上報到 harness 上層`;

function memberPrompt(m: Member, wsId: string, round: number): string {
  const jar = join(LOG_DIR, `jar-${m.user}.txt`);
  return `你是「${m.name}」（${m.email}），task-tracker 團隊的工程師。第 ${round} 次上線工作。
你的 user_id：${m.userId}。workspace：${wsId}。
你的工作目錄（已是 git worktree，branch ${branch(m)}）就是目前目錄，task-tracker 的完整原始碼在這裡。
${API_RULES(jar)}
工程規則：
- 只在目前目錄內改檔案；只改完成 task 需要的檔案，不順手重構
- 完成的定義：npx tsc --noEmit 乾淨 + npm test 全過（含你補的測試），兩者都要實際跑
- 完成後 git add -A && git commit -m "<描述>"，取得 commit hash（git log -1 --format=%h）
本次流程：
1. 登入後 GET ${BASE}/api/workspaces/${wsId}/tasks，看 assignee_id=${m.userId} 的 task
2. 優先序：status=Doing 且有 owner 審查意見的（先 GET 該 task 的 comments 讀意見，回覆你的理解，照意見修正）＞ status=Todo 的新題
3. 開工前：PATCH {"status":"Doing"}（若還在 Todo），留言說明你的實作計畫（改哪個檔、怎麼驗）
4. 實作 → 跑驗證 → commit
5. 完成留言：做法摘要、tsc/test 實際結果、commit hash（branch ${branch(m)}）→ PATCH {"status":"Review"}
6. 若沒有可做的 task：讀一個隊友 task 的留言串，留一則有實質內容的意見，然後總結下線
結束時輸出一行總結。`;
}

function ownerOpenPrompt(wsId: string): string {
  const jar = join(LOG_DIR, 'jar-owner.txt');
  const byName: Record<string, string> = {};
  for (const m of MEMBERS) byName[m.name] = m.userId!;
  const items = BACKLOG(byName).map((t, i) => `${i + 1}. title:「${t.title}」 assignee:${t.assignee}\n   說明素材：${t.desc}`).join('\n');
  return `你是「${OWNER.name}」（${OWNER.email}），task-tracker 的 Owner。開一個真實的 sprint：團隊要真的修掉這些技術債。
workspace：${wsId}。
${API_RULES(jar)}
本次要做的事（只用 curl，不改 code）：
1. POST ${BASE}/api/workspaces/${wsId}/projects {"name":"技術債清償 Sprint"}
2. 照下表建 6 個 task（POST ${BASE}/api/workspaces/${wsId}/tasks，欄位 title/description/priority/assignee/projectId）。
   description 請基於「說明素材」潤飾，保留檔案路徑與驗收方式；priority 自行判斷；assignee 必須照表填 user_id：
${items}
3. 每個 task 留一則說明留言：為什麼這題重要、實作時要注意什麼（你是資深工程師，給出有價值的提醒）
結束時輸出一行總結。`;
}

function ownerMidPrompt(wsId: string): string {
  const jar = join(LOG_DIR, 'jar-owner-mid.txt');
  const map = MEMBERS.map((m) => `- ${m.name}（user_id ${m.userId}）→ branch ${branch(m)}`).join('\n');
  return `你是「${OWNER.name}」（${OWNER.email}），Owner。第一輪開發完成，進行中場 code review（只審查，不 merge）。
workspace：${wsId}。目前目錄是主 repo（master）。
成員與 branch 對照：
${map}
${API_RULES(jar)}
本次流程：
1. GET ${BASE}/api/workspaces/${wsId}/tasks
2. 對每個 status=Review 的 task：
   a. GET 它的 comments 了解實作者說了什麼
   b. 用 git diff master...<該成員的 branch> -- 看實際改動（也可 Read 檔案），認真審：正確性、測試是否真的驗到行為、有沒有多餘改動
   c. 合格 → 留言具體肯定＋「中場審查通過，收尾時合併」（狀態保持 Review）
   d. 不合格 → 留言具體問題（引用檔案與行為）→ PATCH {"status":"Doing"} 退回
3. 對還在 Todo/Doing 沒動靜的 task 留一則催辦或協助留言
4. 留言含 [ESCALATE] 的 task：能給指導就留言具體指導；屬於環境/基礎設施問題你也解不了的 → 留言「已上報 harness 上層處理」並保持該 task 現狀
結束時輸出審查總結（幾件過、幾件退、退的原因、幾件上報）。`;
}

function ownerClosePrompt(wsId: string, tag: string): string {
  const jar = join(LOG_DIR, 'jar-owner-close.txt');
  const map = MEMBERS.map((m) => `- ${m.name} → ${branch(m)}`).join('\n');
  return `你是「${OWNER.name}」（${OWNER.email}），Owner。sprint 收尾：審查通過的合併進 master，總結全場。
workspace：${wsId}。目前目錄是主 repo（master）。成員 branch：
${map}
${API_RULES(jar)}
本次流程：
1. GET ${BASE}/api/workspaces/${wsId}/tasks
2. 對每個 status=Review 的 task，依其 branch 逐一（一次一個 branch）：
   a. git diff master...<branch> 最後確認
   b. git merge --no-ff <branch> -m "merge: <task 標題>"
   c. npx tsc --noEmit && npm test —— 兩者都過才算
   d. 過 → task 留言「已合併進 master（附 merge commit hash）」→ PATCH {"status":"Done"}
   e. 爆 → 衝突用 git merge --abort、測試失敗用 git reset --hard ORIG_HEAD 還原 → task 留言貼失敗原因 → PATCH {"status":"Doing"} 退回
3. 還在 Todo/Doing 的 task：留言說明未完成原因與後續安排
4. 每個 [BUG] task：留言 triage 結論、視嚴重度 PATCH priority；留言含 [ESCALATE] 且你解不了的：留言「已上報 harness 上層處理」
5. 挑一個活動最多的 task，GET ${BASE}/api/audit?aggregate_id=<task_id>，在總結描述它的完整生命週期
6. 輸出 sprint 總結（5 行內：合了幾件、退了幾件、[BUG] 幾件、學到什麼）
（回退錨點 tag：${tag}，僅供你知道，不要動它）`;
}

// ── 統計 ────────────────────────────────────────────────────────────
function printStats(wsId: string, since: string, tag: string): void {
  const db = new DatabaseSync(join(ROOT, 'data/dev.db'));
  const tasks = db.prepare('SELECT task_id, title, status, priority FROM tasks_read_model WHERE workspace_id = ?').all(wsId) as any[];
  const byStatus: Record<string, number> = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  const comments = db.prepare('SELECT count(*) AS n FROM comments WHERE task_id IN (SELECT task_id FROM tasks_read_model WHERE workspace_id = ?)').get(wsId) as any;
  const events = db.prepare('SELECT count(*) AS n FROM event_store WHERE occurred_at >= ?').get(since) as any;
  console.log('\n===== 本場統計 =====');
  console.log(`tasks: ${tasks.length}（${Object.entries(byStatus).map(([k, v]) => `${k}:${v}`).join('、')}）`);
  console.log(`comments: ${comments.n}，event_store 新增事件: ${events.n}`);
  const bugs = tasks.filter((t) => String(t.title).startsWith('[BUG]'));
  console.log(`[BUG] tasks: ${bugs.length}`);
  for (const b of bugs) console.log(`  - [${b.status}/${b.priority}] ${b.title}`);
  const esc = db.prepare(
    `SELECT c.content, t.title FROM comments c JOIN tasks_read_model t ON t.task_id = c.task_id
      WHERE t.workspace_id = ? AND c.content LIKE '%[ESCALATE]%'`,
  ).all(wsId) as any[];
  console.log(`[ESCALATE] 上報留言: ${esc.length}（owner 解不了的環境問題，需要上層/使用者處理）`);
  for (const e of esc) console.log(`  - ${e.title}: ${String(e.content).slice(0, 100)}`);
  try {
    const merged = git(['log', '--oneline', `${tag}..master`]);
    console.log(`\nmaster 自 ${tag} 以來：\n${merged || '（無新 commit）'}`);
    for (const m of MEMBERS) {
      // codex branch 在其 clone 裡；主 repo 有（已 fetch）就從主 repo 查，否則直接查 clone。
      const hasInMain = (() => { try { git(['rev-parse', '--verify', branch(m)]); return true; } catch { return false; } })();
      try {
        const n = hasInMain
          ? git(['log', '--oneline', `master..${branch(m)}`]).split('\n').filter(Boolean).length
          : git(['log', '--oneline', 'master..HEAD'], wt(m)).split('\n').filter(Boolean).length;
        console.log(`${branch(m)}: ${n} 個未合併 commit`);
      } catch { /* branch/worktree 可能已不存在 */ }
    }
  } catch (e) { console.log(`git 統計失敗: ${e}`); }
  console.log(`\n檢視看板：${BASE} 登入 ${OWNER.email} / ${PASSWORD}`);
  console.log(`回退整場：git reset --hard ${tag} && git worktree remove sim-work/<u> --force && git branch -D sim/<u>`);
}

// ── 主流程 ──────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (minS: number, maxS: number) => (minS + Math.random() * (maxS - minS)) * 1000;

// codex member 在 local clone 工作，owner 在主 repo 審——審查前把 clone 的 branch 拉回來
function fetchCodexBranches(): void {
  for (const m of MEMBERS.filter((x) => x.runner === 'codex')) {
    try {
      git(['fetch', wt(m), `${branch(m)}:${branch(m)}`]);
      console.log(`[fetch] ${branch(m)} 已同步回主 repo`);
    } catch (e) {
      console.log(`[fetch] ${branch(m)} 無新 commit 可拉`);
    }
  }
}

async function main(): Promise<void> {
  mkdirSync(LOG_DIR, { recursive: true });
  const since = new Date().toISOString();
  const { wsId, tag } = await bootstrap();

  const memberOpts = (m: Member) => ({ cwd: wt(m), tools: MEMBER_TOOLS, timeoutMs: MEMBER_TIMEOUT });
  const ownerOpts = { cwd: ROOT, tools: OWNER_TOOLS, timeoutMs: OWNER_TIMEOUT };

  if (SMOKE) {
    await runSession('smoke-haiku-小美', 'claude', MEMBERS[0].model, memberPrompt(MEMBERS[0], wsId, 1), memberOpts(MEMBERS[0]));
    await runSession('smoke-codex-婷婷', 'codex', MEMBERS[2].model, memberPrompt(MEMBERS[2], wsId, 1), memberOpts(MEMBERS[2]));
    printStats(wsId, since, tag);
    return;
  }

  await runSession('owner-開場', 'claude', 'claude-opus-4-8', ownerOpenPrompt(wsId), ownerOpts);

  await Promise.all(MEMBERS.map(async (m) => {
    await sleep(jitter(5, 30));
    await runSession(`${m.name}-r1`, m.runner, m.model, memberPrompt(m, wsId, 1), memberOpts(m));
  }));

  fetchCodexBranches();
  await runSession('owner-中場審查', 'claude', 'claude-opus-4-8', ownerMidPrompt(wsId), ownerOpts);

  await Promise.all(MEMBERS.map(async (m) => {
    await sleep(jitter(5, 60));
    for (let r = 2; r <= 3; r++) {
      await runSession(`${m.name}-r${r}`, m.runner, m.model, memberPrompt(m, wsId, r), memberOpts(m));
      if (r < 3) await sleep(jitter(60, 300));
    }
  }));

  fetchCodexBranches();
  await runSession('owner-收尾合併', 'claude', 'claude-opus-4-8', ownerClosePrompt(wsId, tag), ownerOpts);
  printStats(wsId, since, tag);
}

main().catch((e) => { console.error(e); process.exit(1); });
