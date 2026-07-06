// AI 團隊真實 sprint sim（Claude + Codex 混合車隊，真討論/真實作/真審查）
// 用法：npm run sim            — 完整一場（owner 開場 → member 輪1 → owner 中場審查 → member 輪2-3 → owner 收尾 merge → 統計）
//       npm run sim -- --smoke — 只跑 bootstrap + 1 haiku + 1 codex session，驗證管線
// 前置：task-tracker 跑在 localhost:3000、`npm run seed` 已建立 user01-30、工作樹乾淨（會打 tag）
// 回退：git reset --hard <本場 tag>；git worktree remove sim-work/<u> --force；git branch -D sim/<u>
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const BASE = 'http://localhost:3000';
const ROOT = join(__dirname, '..');
const LOG_DIR = join(ROOT, 'sim-logs');
const WORK_DIR = join(ROOT, 'sim-work');
const SMOKE = process.argv.includes('--smoke');
const PASSWORD = 'test1234';
const MEMBER_TIMEOUT = 12 * 60 * 1000;
const OWNER_TIMEOUT = 25 * 60 * 1000; // opus 審查/協調較久；driver 已把機械工作（跑測試）分擔掉，這是安全上限

interface Member {
  email: string;
  name: string;
  user: string; // email 前綴，branch/worktree 命名用
  runner: 'claude' | 'codex';
  model: string;
  userId?: string;
}

interface MemberRunnerConfig {
  email: string;
  runner: 'claude' | 'codex';
  model: string;
}

export interface PromptArtifact {
  label: string;
  path: string;
  bytes: number;
}

interface CommandCheck {
  ok: boolean;
  outputPath: string;
}

export interface BranchReviewPacket {
  branch: string;
  memberName: string;
  memberEmail: string;
  ahead: number;
  commits: string[];
  changedFiles: string[];
  diffstat: string;
  tsc: CommandCheck;
  test: CommandCheck;
  packetPath: string;
}

interface SprintMemberSummary {
  email: string;
  name: string;
  branch: string;
}

interface SprintTaskSummary {
  taskId: string;
  title: string;
  status: string;
  priority: string;
}

export interface SprintReport {
  runId: string;
  scenarioKey: string;
  workspaceId: string;
  tag: string;
  startedAt: string;
  finishedAt: string;
  members: SprintMemberSummary[];
  tasks: SprintTaskSummary[];
  branches: BranchReviewPacket[];
  promptArtifacts: PromptArtifact[];
  bugTasks: number;
  escalateComments: number;
  totalPromptBytes: number;
  commentCount: number;
  eventCount: number;
}

const OWNER = { email: 'user01@test.local', name: '阿哲（Tech Lead / Owner）' };
const MEMBER_RUNNERS: MemberRunnerConfig[] = [
  { email: 'user02@test.local', runner: 'claude', model: 'claude-haiku-4-5-20251001' },
  { email: 'user03@test.local', runner: 'codex', model: 'gpt-5.4' },
  { email: 'user04@test.local', runner: 'codex', model: 'gpt-5.4-mini' },
  { email: 'user05@test.local', runner: 'codex', model: 'gpt-5.4-mini' },
];

const SCENARIOS = {
  'technical-debt': {
    key: 'technical-debt',
    title: '技術債清償 Sprint',
    taskCreationMode: 'current-backlog',
  },
  'product-ideation': {
    key: 'product-ideation',
    title: '產品發想 Sprint',
    taskCreationMode: 'owner-prompt',
  },
} as const;

type ScenarioKey = keyof typeof SCENARIOS;
type Scenario = (typeof SCENARIOS)[ScenarioKey];

let MEMBERS: Member[] = [];
const wt = (m: Member) => join(WORK_DIR, m.user);
const branch = (m: Member) => `sim/${m.user}`;

export function loadMembersFromUsers(databasePath = join(ROOT, 'data/dev.db')): Member[] {
  if (!existsSync(databasePath)) throw new Error(`找不到 users database：${databasePath}。請先執行 npm run seed`);

  const database = new DatabaseSync(databasePath);
  try {
    const select = database.prepare('SELECT email, name FROM users WHERE email = ?');
    return MEMBER_RUNNERS.map((config) => {
      const row = select.get(config.email) as { email: string; name: string } | undefined;
      if (!row) throw new Error(`users 表缺少 sim member：${config.email}。請先執行 npm run seed`);
      const name = row.name.trim();
      if (!name) throw new Error(`users 表的 ${config.email} 缺少 name`);
      return {
        email: row.email,
        name,
        user: config.email.split('@')[0],
        runner: config.runner,
        model: config.model,
      };
    });
  } finally {
    database.close();
  }
}

// 6 個真技術債（same-file 給同人避免 merge 衝突）；owner 開場照表建 task
const BACKLOG = (byName: Record<string, string>) => [
  { assignee: byName['小美'], title: 'session cookie 加 Secure flag', desc: 'src/auth.ts 的 sessionCookie()/clearSessionCookie() 目前沒有 Secure 屬性（見 ponytail 註記）。加環境變數開關（如 COOKIE_SECURE=1 時附加 Secure），本機 http dev 預設不開。驗收：auth.test.ts 補一條開關行為的 assert，npx tsc --noEmit 與 npm test 全過。' },
  { assignee: byName['小美'], title: 'session 過期資料清理', desc: 'sessions 表的過期 row 目前只在 getSessionUser 查到時懶清（src/auth.ts）。在 server 啟動時（src/server.ts）加一次 DELETE FROM sessions WHERE expires_at <= now 的清理（src/auth.ts 加 cleanupExpiredSessions() 供呼叫與測試）。驗收：auth.test.ts 補測試，tsc/test 全過。' },
  { assignee: byName['阿凱'], title: '實作 sim/run.ts 強化計畫（prompt artifact + review packet + sprint report + scenario 選擇）', desc: '倉庫裡 docs/superpowers/plans/2026-07-07-sim-run-amplification.md 是一份已核准、寫死步驟的 TDD 實作計畫，目標是強化 sim/run.ts 這支 AI 模擬 sprint driver：Task1 把每個 session 的 prompt 存成檔案（sim-logs/<run-id>/prompts/）；Task2 把 verifyBranches() 擴充成含 commits/diffstat/changedFiles/tsc/test 輸出的 review packet 檔案；Task3 產生 report.md 與 report.json；Task4 加 --scenario 參數與 SCENARIOS map（technical-debt / product-ideation）。請先用 Read 工具讀完整份計畫文件（裡面每個 Task 都附了具體程式碼片段與驗收指令），完全照文件的 4 個 Task 順序（Task1→2→3→4）逐一實作，每個 Task 做完照文件指示跑測試、commit 一次。若時間內做不完全部 4 個 Task，做到哪個 Task 就完整做完該 Task（測試通過、已 commit）再收工，不要留下半成品；留言說明目前進度與下一步建議。' },
  { assignee: byName['婷婷'], title: 'attachment 讀寫路徑 symlink 硬化', desc: 'src/attachment.ts 讀/刪附件時用 stored_name 組路徑，未做 realpath 檢查——若 ATTACH_DIR 內出現 symlink 可逃出目錄。在 readAttachment/deleteAttachment 實際碰檔案前用 realpathSync 確認解析後路徑仍在 ATTACH_DIR 內，否則丟 CommandError。驗收：attachment.test.ts 補 symlink 逃逸被擋的測試，tsc/test 全過。' },
  { assignee: byName['大熊'], title: 'clientIp 支援 X-Forwarded-For', desc: 'src/server.ts 的 clientIp() 直取 socket（見 ponytail 註記），過 reverse proxy 後 rate limit 會全部算在 proxy IP 上。加 TRUST_PROXY=1 環境變數開關：開啟時取 X-Forwarded-For 最左邊的 IP，未開啟維持現狀。驗收：把 clientIp 抽成可測函式並補測試，tsc/test 全過。' },
];

const PRODUCT_DISCOVERY_BACKLOG = (byName: Record<string, string>) => [
  { assignee: byName['小美'], title: '定義目標用戶與核心痛點', desc: '整理 1 份 problem framing：目標用戶、痛點、既有替代方案、為什麼現在要做。驗收：在 task 留言列出至少 3 個高優先痛點與待驗證假設，不要求改 code。' },
  { assignee: byName['阿凱'], title: '盤點競品與差異化方向', desc: '研究同類產品或替代流程，整理競品比較與可切入差異。驗收：在 task 留言整理至少 3 個競品/替代方案與我們可主打的差異，不要求改 code。' },
  { assignee: byName['婷婷'], title: '設計產品探索訪談/驗證計畫', desc: '提出最小可行的訪談或驗證實驗：對象、問題、成功/失敗訊號。驗收：在 task 留言交付一份可直接執行的訪談/驗證清單，不要求改 code。' },
  { assignee: byName['大熊'], title: '整理 MVP 假設與成功指標', desc: '把前面探索結果收斂成 MVP 範圍、關鍵假設、成功指標與風險。驗收：在 task 留言列出 MVP 範圍、3 個成功指標與主要風險，不要求改 code。' },
];

export function parseScenario(argv: string[]): Scenario {
  const index = argv.indexOf('--scenario');
  if (index === -1) return SCENARIOS['technical-debt'];
  const key = argv[index + 1] as ScenarioKey | undefined;
  if (!key || !(key in SCENARIOS)) throw new Error(`Unknown scenario: ${key ?? '(missing)'}`);
  return SCENARIOS[key];
}

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

  // 全員用 git worktree（branch 直接在主 repo，owner 免 fetch 即可審/merge）。
  // 注意：codex 的 workspace-write sandbox 刻意保護 .git 唯讀（防竄改歷史），worktree
  // 或 clone 都一樣擋——所以 codex member 不自己 commit，改由 driver 在 session 後代 commit
  // （commitCodexWork）；claude member 工具權限能自己 commit。
  for (const m of MEMBERS) {
    if (existsSync(wt(m))) throw new Error(`${wt(m)} 已存在。清理：git worktree remove sim-work/${m.user} --force && git branch -D sim/${m.user} 2>/dev/null`);
    git(['worktree', 'add', wt(m), '-b', branch(m), 'master']);
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

export function createRunDir(root: string, runId: string): string {
  const dir = join(root, runId);
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  mkdirSync(join(dir, 'review-packets'), { recursive: true });
  return dir;
}

export function writePromptArtifact(runDir: string, label: string, prompt: string): PromptArtifact {
  const safe = label.replace(/[^a-zA-Z0-9_-]+/g, '-');
  const existing = readdirSync(join(runDir, 'prompts')).filter((name) => name.endsWith('.md')).length;
  const path = join(runDir, 'prompts', `${String(existing + 1).padStart(3, '0')}-${safe}.md`);
  writeFileSync(path, prompt);
  return { label, path, bytes: Buffer.byteLength(prompt, 'utf8') };
}

function runSession(
  label: string,
  runner: 'claude' | 'codex',
  model: string,
  prompt: string,
  opts: { cwd: string; tools: string; timeoutMs: number; runDir?: string; promptArtifacts?: PromptArtifact[]; promptLabel?: string },
): Promise<void> {
  const logFile = join(LOG_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.log`);
  if (opts.runDir) {
    const artifact = writePromptArtifact(opts.runDir, opts.promptLabel ?? label, prompt);
    opts.promptArtifacts?.push(artifact);
  }
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
- 絕對不要執行 npm run sim（含 --smoke）：那會遞迴啟動一整場新的真實 AI sprint（呼叫 claude/codex CLI），只能用 npx tsc --noEmit、npm test、npx tsx sim/run.test.ts 這類驗證指令
${m.runner === 'claude'
  ? '- 完成後 git add -A && git commit -m "<描述>"，取得 commit hash（git log -1 --format=%h）'
  : '- 你不需要（也無法）自己 git commit——這個工作環境的 .git 是唯讀的，團隊 CI 會在你下線後自動把你的變更提交到 branch ' + branch(m) + '。你只要把檔案改好、驗證通過即可'}
本次流程：
1. 登入後 GET ${BASE}/api/workspaces/${wsId}/tasks，看 assignee_id=${m.userId} 的 task
2. 優先序：status=Doing 且有 owner 審查意見的（先 GET 該 task 的 comments 讀意見，回覆你的理解，照意見修正）＞ status=Todo 的新題
3. 開工前：PATCH {"status":"Doing"}（若還在 Todo），留言說明你的實作計畫（改哪個檔、怎麼驗）
4. 實作 → 跑驗證${m.runner === 'claude' ? ' → commit' : '（改檔+驗證即可，不用 commit）'}
5. 完成留言：做法摘要、tsc/test 實際結果${m.runner === 'claude' ? '、commit hash' : '（CI 會補上 commit）'}（branch ${branch(m)}）→ PATCH {"status":"Review"}
6. 若沒有可做的 task：讀一個隊友 task 的留言串，留一則有實質內容的意見，然後總結下線
結束時輸出一行總結。`;
}

function ownerOpenPrompt(wsId: string, scenario: Scenario): string {
  const jar = join(LOG_DIR, 'jar-owner.txt');
  const byName: Record<string, string> = {};
  for (const m of MEMBERS) byName[m.name] = m.userId!;
  if (scenario.key === 'product-ideation') {
    const items = PRODUCT_DISCOVERY_BACKLOG(byName).map((task, index) => `${index + 1}. title:「${task.title}」 assignee:${task.assignee}\n   說明素材：${task.desc}`).join('\n');
    return `你是「${OWNER.name}」（${OWNER.email}），task-tracker 的 Owner。開一個真實的 ${scenario.title}：這輪只做產品探索，不要求成員改 repo code。
workspace：${wsId}。
${API_RULES(jar)}
本次要做的事（只用 curl，不改 code）：
1. POST ${BASE}/api/workspaces/${wsId}/projects {"name":"${scenario.title}"}
2. 照下表建產品探索 task（POST ${BASE}/api/workspaces/${wsId}/tasks，欄位 title/description/priority/assignee/projectId）。
   description 請基於「說明素材」潤飾，明確寫出期望的研究產出與留言驗收方式；priority 自行判斷；assignee 必須照表填 user_id：
${items}
3. 每個 task 留一則說明留言：說明這題要回答的產品問題、判斷標準、以及不要直接跳成 code implementation
結束時輸出一行總結。`;
  }
  const items = BACKLOG(byName).map((task, index) => `${index + 1}. title:「${task.title}」 assignee:${task.assignee}\n   說明素材：${task.desc}`).join('\n');
  return `你是「${OWNER.name}」（${OWNER.email}），task-tracker 的 Owner。開一個真實的 ${scenario.title}：團隊要真的修掉這些技術債。
workspace：${wsId}。
${API_RULES(jar)}
本次要做的事（只用 curl，不改 code）：
1. POST ${BASE}/api/workspaces/${wsId}/projects {"name":"${scenario.title}"}
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

function ownerClosePrompt(wsId: string, tag: string, verified: BranchReviewPacket[]): string {
  const jar = join(LOG_DIR, 'jar-owner-close.txt');
  const packetByBranch = new Map(verified.map((packet) => [packet.branch, packet]));
  const map = MEMBERS.map((m) => {
    const packet = packetByBranch.get(branch(m));
    if (!packet || packet.ahead === 0) return `- ${m.name} / ${branch(m)}: 無 commit`;
    return `- ${m.name} / ${packet.branch}: tsc ${packet.tsc.ok ? 'PASS' : 'FAIL'}, test ${packet.test.ok ? 'PASS' : 'FAIL'}, ${packet.ahead} commits, ${packet.changedFiles.length} files changed, packet: ${packet.packetPath}`;
  }).join('\n');
  return `你是「${OWNER.name}」（${OWNER.email}），Owner。sprint 收尾：審查通過的合併進 master，總結全場。
workspace：${wsId}。目前目錄是主 repo（master）。
CI（driver）已幫你把每個 branch 對 master 獨立跑過 tsc + test，結果如下——你不用自己重跑各 branch 的測試：
${map}
${API_RULES(jar)}
本次流程（省時要點：信任上面 CI 預跑結果，不要逐 branch 重跑測試）：
1. GET ${BASE}/api/workspaces/${wsId}/tasks
2. 對每個 status=Review 且 CI 顯示 tsc/test 皆 ✓ 的 task，依其 branch 逐一 merge（一次一個）：
   a. git diff master...<branch> 快速看 code（審查重點，不用跑測試）
   b. git merge --no-ff <branch> -m "merge: <task 標題>"；若衝突 git merge --abort 並在 task 留言請該成員 rebase
   c. task 留言「已合併進 master（附 merge commit hash）」→ PATCH {"status":"Done"}
3. 全部 merge 完成後，跑「一次」npx tsc --noEmit && npm test 做整合驗證（不是每 branch 一次）；若整合失敗，git log 找出問題 merge、git reset --hard <該 merge 前> 退回它、在對應 task 留言退回原因 + PATCH {"status":"Doing"}
4. CI 顯示 tsc 或 test ✗ 的 branch：不要 merge，直接在 task 留言具體問題 + PATCH {"status":"Doing"} 退回
5. 還在 Todo/Doing 的 task：留言說明未完成原因；[BUG]/[ESCALATE] task：triage 留言、解不了的標「已上報 harness 上層處理」
6. 輸出 sprint 總結（5 行內：合了幾件、退了幾件、學到什麼）
（回退錨點 tag：${tag}，僅供你知道，不要動它）`;
}

// ── 統計 ────────────────────────────────────────────────────────────
export function formatReportMarkdown(report: SprintReport): string {
  return [
    `# Sprint Report ${report.runId}`,
    '',
    `scenario: ${report.scenarioKey}`,
    `workspace: ${report.workspaceId}`,
    `tag: ${report.tag}`,
    `started: ${report.startedAt}`,
    `finished: ${report.finishedAt}`,
    `total prompt bytes: ${report.totalPromptBytes}`,
    '',
    '## Members',
    ...report.members.map((member) => `- ${member.name} <${member.email}> (${member.branch})`),
    ...(report.members.length ? [] : ['- (none)']),
    '',
    '## Tasks',
    ...report.tasks.map((task) => `- [${task.status}/${task.priority}] ${task.title} (${task.taskId})`),
    ...(report.tasks.length ? [] : ['- (none)']),
    '',
    '## Branches',
    ...report.branches.map((packet) => `- ${packet.branch}: tsc ${packet.tsc.ok ? 'PASS' : 'FAIL'}, test ${packet.test.ok ? 'PASS' : 'FAIL'}, commits ${packet.commits.length}, files ${packet.changedFiles.length}`),
    ...(report.branches.length ? [] : ['- (none)']),
    '',
    '## Prompt Artifacts',
    ...report.promptArtifacts.map((artifact) => `- ${artifact.label}: ${artifact.bytes} bytes (${artifact.path})`),
    ...(report.promptArtifacts.length ? [] : ['- (none)']),
    '',
    '## Counts',
    `- bug tasks: ${report.bugTasks}`,
    `- escalate comments: ${report.escalateComments}`,
    `- comments: ${report.commentCount}`,
    `- events: ${report.eventCount}`,
    '',
  ].join('\n');
}

function writeReport(runDir: string, report: SprintReport): void {
  writeFileSync(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(runDir, 'report.md'), formatReportMarkdown(report));
}

function buildSprintReport(
  wsId: string,
  since: string,
  tag: string,
  runId: string,
  scenarioKey: string,
  promptArtifacts: PromptArtifact[],
  branches: BranchReviewPacket[],
): SprintReport {
  const db = new DatabaseSync(join(ROOT, 'data/dev.db'));
  const tasks = db.prepare('SELECT task_id, title, status, priority FROM tasks_read_model WHERE workspace_id = ?').all(wsId) as Array<{ task_id: string; title: string; status: string; priority: string }>;
  const comments = db.prepare('SELECT count(*) AS n FROM comments WHERE task_id IN (SELECT task_id FROM tasks_read_model WHERE workspace_id = ?)').get(wsId) as { n: number };
  const events = db.prepare('SELECT count(*) AS n FROM event_store WHERE occurred_at >= ?').get(since) as { n: number };
  const esc = db.prepare(
    `SELECT c.content, t.title FROM comments c JOIN tasks_read_model t ON t.task_id = c.task_id
      WHERE t.workspace_id = ? AND c.content LIKE '%[ESCALATE]%'`,
  ).all(wsId) as Array<{ content: string; title: string }>;
  db.close();
  return {
    runId,
    scenarioKey,
    workspaceId: wsId,
    tag,
    startedAt: since,
    finishedAt: new Date().toISOString(),
    members: MEMBERS.map((member) => ({ email: member.email, name: member.name, branch: branch(member) })),
    tasks: tasks.map((task) => ({ taskId: task.task_id, title: task.title, status: task.status, priority: task.priority })),
    branches,
    promptArtifacts,
    bugTasks: tasks.filter((task) => String(task.title).startsWith('[BUG]')).length,
    escalateComments: esc.length,
    totalPromptBytes: promptArtifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
    commentCount: comments.n,
    eventCount: events.n,
  };
}

function printStats(
  runDir: string,
  wsId: string,
  since: string,
  tag: string,
  scenarioKey: string,
  promptArtifacts: PromptArtifact[],
  branches: BranchReviewPacket[],
): void {
  const report = buildSprintReport(wsId, since, tag, tag, scenarioKey, promptArtifacts, branches);
  const byStatus: Record<string, number> = {};
  for (const task of report.tasks) byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
  writeReport(runDir, report);
  console.log('\n===== 本場統計 =====');
  console.log(`tasks: ${report.tasks.length}（${Object.entries(byStatus).map(([k, v]) => `${k}:${v}`).join('、')}）`);
  console.log(`comments: ${report.commentCount}，event_store 新增事件: ${report.eventCount}`);
  const bugs = report.tasks.filter((task) => String(task.title).startsWith('[BUG]'));
  console.log(`[BUG] tasks: ${report.bugTasks}`);
  for (const bug of bugs) console.log(`  - [${bug.status}/${bug.priority}] ${bug.title}`);
  console.log(`[ESCALATE] 上報留言: ${report.escalateComments}（owner 解不了的環境問題，需要上層/使用者處理）`);
  try {
    const merged = git(['log', '--oneline', `${tag}..master`]);
    console.log(`\nmaster 自 ${tag} 以來：\n${merged || '（無新 commit）'}`);
    for (const m of MEMBERS) {
      // 全員 worktree，branch 直接在主 repo。
      try { console.log(`${branch(m)}: ${git(['log', '--oneline', `master..${branch(m)}`]).split('\n').filter(Boolean).length} 個未合併 commit`); } catch { /* branch 可能已不存在 */ }
    }
  } catch (e) { console.log(`git 統計失敗: ${e}`); }
  console.log(`\n檢視看板：${BASE} 登入 ${OWNER.email} / ${PASSWORD}`);
  console.log(`回退整場：git reset --hard ${tag} && git worktree remove sim-work/<u> --force && git branch -D sim/<u>`);
}

// ── 主流程 ──────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (minS: number, maxS: number) => (minS + Math.random() * (maxS - minS)) * 1000;

// codex sandbox 不能寫 .git，session 後由 driver 代 commit（在 sandbox 外，能寫）。
// worktree dirty 就 add -A + commit 到該 member 的 branch。回傳是否有 commit。
function commitCodexWork(m: Member, round: number): boolean {
  const dirty = git(['status', '--porcelain'], wt(m));
  if (!dirty) return false;
  git(['add', '-A'], wt(m));
  git(['commit', '-m', `feat(${m.name}/${m.model}): r${round} 產出（driver 代 commit——codex sandbox .git 唯讀）`], wt(m));
  const hash = git(['log', '-1', '--format=%h'], wt(m));
  console.log(`[代commit] ${branch(m)} r${round} → ${hash}`);
  return true;
}

export function formatReviewPacket(packet: BranchReviewPacket): string {
  return [
    `# ${packet.branch}`,
    '',
    `member: ${packet.memberName} <${packet.memberEmail}>`,
    `ahead: ${packet.ahead}`,
    `tsc: ${packet.tsc.ok ? 'PASS' : 'FAIL'} (${packet.tsc.outputPath})`,
    `test: ${packet.test.ok ? 'PASS' : 'FAIL'} (${packet.test.outputPath})`,
    '',
    '## Commits',
    ...packet.commits.map((commit) => `- ${commit}`),
    ...(packet.commits.length ? [] : ['- (none)']),
    '',
    '## Changed Files',
    ...packet.changedFiles.map((file) => `- ${file}`),
    ...(packet.changedFiles.length ? [] : ['- (none)']),
    '',
    '## Diffstat',
    '```text',
    packet.diffstat || '(empty)',
    '```',
    '',
  ].join('\n');
}

function runCheck(cwd: string, command: string, args: string[], outputPath: string): CommandCheck {
  try {
    const stdout = execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      timeout: 3 * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024,
    });
    writeFileSync(outputPath, stdout);
    return { ok: true, outputPath };
  } catch (error) {
    const failure = error as Error & { stdout?: Buffer | string; stderr?: Buffer | string };
    const stdout = typeof failure.stdout === 'string' ? failure.stdout : failure.stdout?.toString() ?? '';
    const stderr = typeof failure.stderr === 'string' ? failure.stderr : failure.stderr?.toString() ?? '';
    writeFileSync(outputPath, [`$ ${command} ${args.join(' ')}`, stdout && `STDOUT:\n${stdout}`, stderr && `STDERR:\n${stderr}`, `ERR:${String(error)}`].filter(Boolean).join('\n\n'));
    return { ok: false, outputPath };
  }
}

// owner 收尾前，driver 對每個 branch 獨立預跑 tsc+test（機械工作交給 code，不佔 owner 的 LLM session）。
// 在各自 worktree 跑（主 repo 尚未 merge）。結果注入 ownerClosePrompt，owner 只做判斷與 merge。
function verifyBranches(runDir: string): BranchReviewPacket[] {
  const out: BranchReviewPacket[] = [];
  for (const m of MEMBERS) {
    const packetBase = branch(m).replace(/[^a-zA-Z0-9_-]+/g, '-');
    const packetPath = join(runDir, 'review-packets', `${packetBase}.md`);
    const tscPath = join(runDir, 'review-packets', `${packetBase}-tsc.txt`);
    const testPath = join(runDir, 'review-packets', `${packetBase}-test.txt`);
    if (!existsSync(wt(m))) {
      out.push({
        branch: branch(m),
        memberName: m.name,
        memberEmail: m.email,
        ahead: 0,
        commits: [],
        changedFiles: [],
        diffstat: '',
        tsc: { ok: false, outputPath: tscPath },
        test: { ok: false, outputPath: testPath },
        packetPath,
      });
      continue;
    }
    const ahead = Number(git(['rev-list', '--count', `master..${branch(m)}`]));
    const packet: BranchReviewPacket = {
      branch: branch(m),
      memberName: m.name,
      memberEmail: m.email,
      ahead,
      commits: [],
      changedFiles: [],
      diffstat: '',
      tsc: { ok: false, outputPath: tscPath },
      test: { ok: false, outputPath: testPath },
      packetPath,
    };
    if (!ahead) {
      out.push(packet);
      continue;
    }
    packet.commits = git(['log', '--oneline', `master..${branch(m)}`]).split('\n').filter(Boolean);
    packet.changedFiles = git(['diff', '--name-only', `master...${branch(m)}`]).split('\n').filter(Boolean);
    packet.diffstat = git(['diff', '--stat', `master...${branch(m)}`]);
    packet.tsc = runCheck(wt(m), 'npx', ['tsc', '--noEmit'], tscPath);
    packet.test = runCheck(wt(m), 'npm', ['test'], testPath);
    writeFileSync(packetPath, formatReviewPacket(packet));
    out.push(packet);
    console.log(`[CI預跑] ${branch(m)}: tsc ${packet.tsc.ok ? '✓' : '✗'} / test ${packet.test.ok ? '✓' : '✗'}（${ahead} commit）`);
  }
  return out;
}

async function main(): Promise<void> {
  mkdirSync(LOG_DIR, { recursive: true });
  MEMBERS = loadMembersFromUsers();
  const scenario = parseScenario(process.argv);
  const since = new Date().toISOString();
  const { wsId, tag } = await bootstrap();
  const runDir = createRunDir(LOG_DIR, tag);
  const promptArtifacts: PromptArtifact[] = [];

  const memberOpts = (m: Member) => ({ cwd: wt(m), tools: MEMBER_TOOLS, timeoutMs: MEMBER_TIMEOUT, runDir, promptArtifacts });
  const ownerOpts = { cwd: ROOT, tools: OWNER_TOOLS, timeoutMs: OWNER_TIMEOUT, runDir, promptArtifacts };

  // 一個 member session：跑 + 若是 codex 則 driver 代 commit
  const memberSession = async (m: Member, round: number) => {
    await runSession(`${m.name}-r${round}`, m.runner, m.model, memberPrompt(m, wsId, round), { ...memberOpts(m), promptLabel: `${m.user}-r${round}` });
    if (m.runner === 'codex') commitCodexWork(m, round);
  };

  if (SMOKE) {
    await memberSession(MEMBERS[0], 1); // haiku
    await memberSession(MEMBERS[2], 1); // codex（驗證 driver 代 commit）
    printStats(runDir, wsId, since, tag, scenario.key, promptArtifacts, []);
    return;
  }

  await runSession('owner-開場', 'claude', 'claude-opus-4-8', ownerOpenPrompt(wsId, scenario), { ...ownerOpts, promptLabel: 'owner-open' });

  await Promise.all(MEMBERS.map(async (m) => {
    await sleep(jitter(5, 30));
    await memberSession(m, 1);
  }));

  await runSession('owner-中場審查', 'claude', 'claude-opus-4-8', ownerMidPrompt(wsId), { ...ownerOpts, promptLabel: 'owner-mid' });

  await Promise.all(MEMBERS.map(async (m) => {
    await sleep(jitter(5, 60));
    for (let r = 2; r <= 3; r++) {
      await memberSession(m, r);
      if (r < 3) await sleep(jitter(60, 300));
    }
  }));

  const verified = verifyBranches(runDir); // driver 預跑，把測試機械工作從 owner session 移出
  await runSession('owner-收尾合併', 'claude', 'claude-opus-4-8', ownerClosePrompt(wsId, tag, verified), { ...ownerOpts, promptLabel: 'owner-close' });
  printStats(runDir, wsId, since, tag, scenario.key, promptArtifacts, verified);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
