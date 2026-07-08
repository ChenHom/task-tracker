// AI 團隊真實 sprint sim（Claude + Codex 混合車隊，真討論/真實作/真審查）
// owner 自主探勘發想主題、開無主 task；成員依專長認領；審過的 branch merge 進該 scenario 的 repo。
// 用法：npm run sim                       — 深度一場（開場→r1→中場審查→r2-3→收尾 merge→repair→統計）
//       npm run sim -- --fast             — 壓縮一場（開場→r1→收尾 merge→repair→統計），目標 ~15-20 分
//       npm run sim -- --scenario brain   — 改在 /home/hom/code/brain 開創/延續主題專案（與 --fast 可組合）
//       npm run sim -- --smoke            — 只跑 bootstrap + 2 個 member session，驗證管線
// 前置：task-tracker 跑在 localhost:3000、`npm run seed` 已建立 user01-30、目標 repo 工作樹乾淨（會打 tag）
// 回退：git reset --hard <本場 tag>；git worktree remove sim-work/<u> --force；git branch -D sim/<u>
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const BASE = 'http://localhost:3000';
const ROOT = join(__dirname, '..');
const LOG_DIR = join(ROOT, 'sim-logs'); // 產物一律留在 task-tracker 底下，方便統一查看
// 成員實作/CI/worktree 針對的 repo 與其 sim-work 目錄；main() 依 scenario.repoRoot 設定（brain 場改指向 /home/hom/code/brain）
let REPO_ROOT = ROOT;
let WORK_DIR = join(ROOT, 'sim-work');
const SMOKE = process.argv.includes('--smoke');
const FAST = process.argv.includes('--fast');
const SWEEP = process.argv.includes('--sweep');
// --sweep 後可接 role：owner（每 30 分，審查/合併/回老闆）｜team（每小時，成員實作）｜省略=both（手動全掃）
const SWEEP_ROLE: 'owner' | 'team' | 'both' = (() => {
  const n = process.argv[process.argv.indexOf('--sweep') + 1];
  return n === 'owner' || n === 'team' ? n : 'both';
})();

// 所有 sim 輸出加 HH:MM:SS 前綴——cron log 才看得出每個 session 何時開始/結束
const _rawLog = console.log.bind(console);
console.log = (...args: unknown[]) => _rawLog(`[${new Date().toTimeString().slice(0, 8)}]`, ...args);
const PASSWORD = 'test1234';
const MEMBER_TIMEOUT = (FAST ? 7 : 12) * 60 * 1000;
const OWNER_TIMEOUT = (FAST ? 12 : 25) * 60 * 1000; // opus 審查/協調較久；driver 已把機械工作（跑測試）分擔掉，這是安全上限

interface Member {
  email: string;
  name: string;
  user: string; // email 前綴，branch/worktree 命名用
  runner: 'claude' | 'codex';
  model: string;
  profile: string; // 專長描述，注入 prompt 供成員自我認知與 owner 設計難度組合參考
  userId?: string;
}

interface MemberRunnerConfig {
  email: string;
  runner: 'claude' | 'codex';
  model: string;
  profile: string;
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
  unmergedGreen: string[];
}

const OWNER = { email: 'user01@test.local', name: '阿哲（Tech Lead / Owner）' };
const MEMBER_RUNNERS: MemberRunnerConfig[] = [
  { email: 'user02@test.local', runner: 'claude', model: 'claude-haiku-4-5-20251001',
    profile: '細心，擅長小範圍 auth/安全類修補與補測試，適合範圍明確的小題' },
  { email: 'user03@test.local', runner: 'codex', model: 'gpt-5.4',
    profile: '主力工程師，可承接跨檔案/架構性大題（曾獨力完成 sim harness 四階段強化）' },
  { email: 'user04@test.local', runner: 'codex', model: 'gpt-5.4-mini',
    profile: '中小題穩定，擅長檔案 IO/防護類修補（曾完成 attachment symlink 硬化）' },
  { email: 'user05@test.local', runner: 'codex', model: 'gpt-5.4-mini',
    profile: '中小題，動手前先查核現況避免重工' },
];

const BRAIN_ROOT = '/home/hom/code/brain';

// repoRoot：成員實作/CI/worktree 針對的 repo；self-directed/product-ideation 是本 task-tracker，brain 是獨立沙盒
const SCENARIOS = {
  'self-directed': {
    key: 'self-directed',
    title: '自主 Sprint',
    taskCreationMode: 'owner-explored',
    repoRoot: ROOT,
  },
  'product-ideation': {
    key: 'product-ideation',
    title: '產品發想 Sprint',
    taskCreationMode: 'owner-prompt',
    repoRoot: ROOT,
  },
  'brain': {
    key: 'brain',
    title: 'Brain 主題 Sprint',
    taskCreationMode: 'brain-explored',
    repoRoot: BRAIN_ROOT,
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
        profile: config.profile,
      };
    });
  } finally {
    database.close();
  }
}

// 一則舊技術債題目文字，當 owner 開題的「格式範例」（保留範例價值，不再寫死指派——改認領制）
const TASK_FORMAT_EXAMPLE =
  'title:「session cookie 加 Secure flag」【小】\n' +
  'description:「src/auth.ts 的 sessionCookie()/clearSessionCookie() 目前沒有 Secure 屬性（見 ponytail 註記）。加環境變數開關（COOKIE_SECURE=1 時附加 Secure），本機 http dev 預設不開。驗收：auth.test.ts 補一條開關行為的 assert，npx tsc --noEmit + npx tsx src/auth.test.ts 通過。」';

const PRODUCT_DISCOVERY_BACKLOG = (byName: Record<string, string>) => [
  { assignee: byName['小美'], title: '定義目標用戶與核心痛點', desc: '整理 1 份 problem framing：目標用戶、痛點、既有替代方案、為什麼現在要做。驗收：在 task 留言列出至少 3 個高優先痛點與待驗證假設，不要求改 code。' },
  { assignee: byName['阿凱'], title: '盤點競品與差異化方向', desc: '研究同類產品或替代流程，整理競品比較與可切入差異。驗收：在 task 留言整理至少 3 個競品/替代方案與我們可主打的差異，不要求改 code。' },
  { assignee: byName['婷婷'], title: '設計產品探索訪談/驗證計畫', desc: '提出最小可行的訪談或驗證實驗：對象、問題、成功/失敗訊號。驗收：在 task 留言交付一份可直接執行的訪談/驗證清單，不要求改 code。' },
  { assignee: byName['大熊'], title: '整理 MVP 假設與成功指標', desc: '把前面探索結果收斂成 MVP 範圍、關鍵假設、成功指標與風險。驗收：在 task 留言列出 MVP 範圍、3 個成功指標與主要風險，不要求改 code。' },
];

export function parseScenario(argv: string[]): Scenario {
  const index = argv.indexOf('--scenario');
  if (index === -1) return SCENARIOS['self-directed'];
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

const git = (args: string[], cwd = REPO_ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// owner session 若違反指示手動解衝突到一半被 timeout SIGKILL，repo 會卡在衝突態；每次 owner-close/repair 後兜底清掉。
function abortStaleMerge(): void {
  if (!existsSync(join(REPO_ROOT, '.git', 'MERGE_HEAD'))) return;
  git(['merge', '--abort']);
  console.log('[兜底] owner session 留下未完成 merge，已 abort 回乾淨態');
}

// brain scenario：repo 可能還不存在。無 .git 就初始化（worktree add 需要至少一個 commit）。
function ensureBrainRepo(): void {
  mkdirSync(BRAIN_ROOT, { recursive: true });
  if (existsSync(join(BRAIN_ROOT, '.git'))) return;
  git(['init', '-b', 'master'], BRAIN_ROOT);
  git(['config', 'user.email', 'sim-brain@local'], BRAIN_ROOT);
  git(['config', 'user.name', 'sim-brain'], BRAIN_ROOT);
  writeFileSync(join(BRAIN_ROOT, 'README.md'), '# brain\n\nAI 團隊自主孵化的主題專案沙盒。每個子目錄是一個專案，由 sim sprint 逐場迭代。\n');
  writeFileSync(join(BRAIN_ROOT, '.gitignore'), 'node_modules\nsim-work/\ndist/\n');
  git(['add', '-A'], BRAIN_ROOT);
  git(['commit', '-m', 'chore: brain repo 初始化（sim driver）'], BRAIN_ROOT);
  console.log('[bootstrap] brain repo 已初始化於 ' + BRAIN_ROOT);
}

// ── Bootstrap：tag、workspace、worktrees ────────────────────────────
async function bootstrap(scenario: Scenario): Promise<{ wsId: string; tag: string }> {
  const health = await api('/api/health');
  if (health.status !== 200) throw new Error('server 不在 localhost:3000，先啟動 task-tracker');
  if (scenario.repoRoot === BRAIN_ROOT) ensureBrainRepo();
  if (git(['status', '--porcelain'])) throw new Error(`工作樹不乾淨（${REPO_ROOT}），先 commit 再跑 sim`);

  const tag = `sim-run-${Date.now()}`;
  git(['tag', tag]);

  // 全員用 git worktree（branch 直接在目標 repo，owner 免 fetch 即可審/merge）。
  // 注意：codex 的 workspace-write sandbox 刻意保護 .git 唯讀（防竄改歷史），worktree
  // 或 clone 都一樣擋——所以 codex member 不自己 commit，改由 driver 在 session 後代 commit
  // （commitCodexWork）；claude member 工具權限能自己 commit。
  for (const m of MEMBERS) {
    if (existsSync(wt(m))) throw new Error(`${wt(m)} 已存在。清理：git worktree remove sim-work/${m.user} --force && git branch -D sim/${m.user} 2>/dev/null`);
    git(['worktree', 'add', wt(m), '-b', branch(m), 'master']);
    // task-tracker 場：symlink 主 repo node_modules（測試現成）；brain 場各子專案自帶依賴，不 symlink
    if (scenario.repoRoot === ROOT) symlinkSync(join(ROOT, 'node_modules'), join(wt(m), 'node_modules'));
  }

  const ownerCookie = await login(OWNER.email);
  const ws = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: scenario.title }) }, ownerCookie);
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
// owner 開場是生成型工作（發想＋開題），交給較快的 sonnet；中場/收尾/repair 是審查判斷，用 opus
const OWNER_OPEN_MODEL = 'claude-sonnet-5';
const OWNER_REVIEW_MODEL = 'claude-opus-4-8';

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

interface SessionResult { timedOut: boolean; errored: boolean }

function runSession(
  label: string,
  runner: 'claude' | 'codex',
  model: string,
  prompt: string,
  opts: { cwd: string; tools: string; timeoutMs: number; runDir?: string; promptArtifacts?: PromptArtifact[]; promptLabel?: string },
): Promise<SessionResult> {
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
        // execFile 逾時→送 killSignal(SIGKILL)＋err.killed=true；據此明確判定「逾時」而非額度/API 錯誤
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
        const timedOut = !!e && (e.killed === true || e.signal === 'SIGKILL');
        const errNote = err ? `${String(err)}${timedOut ? ` [KILLED signal=${e?.signal} → 逾時 timeout=${Math.round(opts.timeoutMs / 60000)}分]` : ''}` : 'none';
        writeFileSync(logFile, `PROMPT:\n${prompt}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}\n\nERR:${errNote}\n`);
        const tail = (stdout || '').trim().split('\n').slice(-2).join(' / ');
        const why = timedOut ? `（逾時 ${Math.round(opts.timeoutMs / 60000)} 分被中止）` : err ? `（異常: ${String(err).slice(0, 80)}）` : '';
        console.log(`[${label}] 結束${why} — ${tail.slice(0, 200)}`);
        resolve({ timedOut, errored: !!err }); // 單一 session 失敗不中斷整場
      });
    child.stdin?.end(); // codex exec 看到 piped stdin 會等 EOF
  });
}

// ── Owner 開場的探勘材料（driver 預蒐，機械工作交給 code，不佔 owner session）──
// best-effort：任一指令失敗不中斷，回退為說明字串。owner 只讀材料做判斷，不自己跑指令。
function shell(cmd: string, args: string[], cwd = REPO_ROOT): string {
  try { return execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: 30 * 1000, maxBuffer: 4 * 1024 * 1024 }).trim(); }
  catch (e) { const out = (e as { stdout?: string }).stdout; return typeof out === 'string' ? out.trim() : ''; }
}

function exploreMaterial(scenario: Scenario): string {
  if (scenario.repoRoot === BRAIN_ROOT) {
    const subs = readdirSync(BRAIN_ROOT).filter((n) => !n.startsWith('.') && n !== 'sim-work' && n !== 'README.md');
    if (!subs.length) {
      return `brain repo（${BRAIN_ROOT}）目前是空的——本場要開創第一個主題專案。\n近期 commit：\n${shell('git', ['log', '--oneline', '-10']) || '（僅初始 commit）'}`;
    }
    const projects = subs.map((sub) => {
      const readmePath = join(BRAIN_ROOT, sub, 'README.md');
      const head = existsSync(readmePath) ? readFileSync(readmePath, 'utf8').split('\n').slice(0, 8).join('\n') : '（無 README）';
      return `### 子專案 ${sub}\n${head}`;
    }).join('\n\n');
    return `brain 現有子專案（優先延續，其次才開新專案）：\n${projects}\n\n近期 commit：\n${shell('git', ['log', '--oneline', '-20'])}`;
  }
  // self-directed / product-ideation：探 task-tracker 本體
  const log = shell('git', ['log', '--oneline', '-30']);
  const ponytail = shell('grep', ['-rn', 'ponytail:', 'src/', 'public/']).split('\n').slice(0, 40).join('\n');
  const docs = shell('ls', ['-1', 'docs/']) || '（無 docs/）';
  const tests = shell('sh', ['-c', 'ls src/*.test.ts sim/*.test.ts 2>/dev/null']);
  return `近 30 筆 commit：\n${log}\n\nponytail 註記（已知簡化點/技術債候選，最多 40 條）：\n${ponytail || '（無）'}\n\ndocs/ 檔案：\n${docs}\n\n現有測試檔：\n${tests || '（無）'}`;
}

// ── Prompts ─────────────────────────────────────────────────────────
const API_RULES = (jar: string) => `
API 操作規則（task-tracker 是團隊的協作看板，所有溝通都要留在上面）：
- 登入：curl -s -c ${jar} -X POST ${BASE}/api/auth/login -H 'Content-Type: application/json' -d '{"email":"<你的email>","password":"${PASSWORD}"}'，之後帶 -b ${jar}
- 狀態機：Todo→Doing→Review→Done 相鄰前進或一步回退；PATCH /api/tasks/<id> 一次只能改一個欄位（如 {"status":"Doing"}）；400/409 就重新 GET 再決定
- 留言 POST /api/tasks/<id>/comments {"content":"..."}：正體中文、像真的工程師、具體（做法/卡點/驗證結果）
- 遇疑似系統 bug：自查重試一次，可重現就建 [BUG] task（POST /api/workspaces/<ws>/tasks，title 以 [BUG] 開頭，description 含重現步驟/預期 vs 實際/原始回應，priority High）
- 卡在環境/權限/工具問題（不是 code 本身的問題）：在該 task 留言以 [ESCALATE] 開頭，寫清楚卡點與已試過的方法，然後繼續做還能做的部分——owner 會處理，owner 也解不了會上報到 harness 上層`;

function memberPrompt(m: Member, wsId: string, round: number, scenario: Scenario): string {
  const jar = join(LOG_DIR, `jar-${m.user}.txt`);
  const isBrain = scenario.repoRoot === BRAIN_ROOT;
  const workdirDesc = isBrain
    ? '你的工作目錄（已是 git worktree，branch ' + branch(m) + '）就是目前目錄，是團隊共用的主題專案沙盒 repo；task 會指明要動哪個子專案。'
    : '你的工作目錄（已是 git worktree，branch ' + branch(m) + '）就是目前目錄，task-tracker 的完整原始碼在這裡。';
  const doneDef = isBrain
    ? '- 完成的定義：task 驗收欄位寫的檢查通過（若子專案有 package.json/test script 就跑它；有 tsconfig 就 npx tsc --noEmit）；至少留一個可重跑的檢查'
    : '- 完成的定義：npx tsc --noEmit 乾淨 + 跑「與你改動相關的測試檔」通過（例如改 auth 就 npx tsx src/auth.test.ts）。完整測試套件由團隊 CI 在你下線後統一跑，你不必自己跑整套 npm test（省時：本地快測、CI 全測）';
  return `你是「${m.name}」（${m.email}），團隊工程師。第 ${round} 次上線工作。你的專長：${m.profile}。
你的 user_id：${m.userId}。workspace：${wsId}。
${workdirDesc}
${API_RULES(jar)}
工程規則：
- 只在目前目錄內改檔案；只改完成 task 需要的檔案，不順手重構
${doneDef}
- 絕對不要執行 npm run sim（含 --smoke / --fast）：那會遞迴啟動一整場新的真實 AI sprint（呼叫 claude/codex CLI）
${m.runner === 'claude'
  ? '- 完成後 git add -A && git commit -m "<描述>"，取得 commit hash（git log -1 --format=%h）'
  : '- 你不需要（也無法）自己 git commit——這個工作環境的 .git 是唯讀的，團隊 CI 會在你下線後自動把你的變更提交到 branch ' + branch(m) + '。你只要把檔案改好、驗證通過即可'}
本次流程（這是認領制看板：task 開出來時沒有指派，誰適合誰認領）：
1. 登入後 GET ${BASE}/api/workspaces/${wsId}/tasks
2. 決定要做哪一題，優先序：
   a.（最優先）assignee_id=${m.userId} 且 status=Doing、有 owner 審查意見的 → 先 GET 該 task 的 comments 讀意見，回覆你的理解，照意見修正
   b. assignee_id=${m.userId} 且 status 還在 Todo/Doing 的（你先前認領未完成的）
   c.（認領新題）assignee_id 為 null 且 status=Todo 的無主題，挑一個「最合你專長」的
3. 認領協議（只在 2c 走這步，避免和隊友撞題）：
   - 先 GET /api/tasks/<id> 確認 assignee_id 仍是 null
   - PATCH /api/tasks/<id> {"assignee":"${m.userId}"} 認領
   - 再 GET 一次確認 assignee_id 現在是你；若不是（被隊友搶先），放棄這題、回步驟 2 重新挑
   - 認領後留言：為什麼你選這題（扣連你的專長）、實作計畫
4. PATCH {"status":"Doing"}（若還在 Todo）
5. 實作 → 跑驗證${m.runner === 'claude' ? ' → commit' : '（改檔+驗證即可，不用 commit）'}
6. 完成留言：做法摘要、驗證實際結果${m.runner === 'claude' ? '、commit hash' : '（CI 會補上 commit）'}（branch ${branch(m)}）→ PATCH {"status":"Review"}
7. 一次只做一題；做完進 Review 才可回步驟 2 認領下一題。若沒有可做也沒有可認領的題：讀一個隊友 task 的留言串，留一則有實質內容的意見，然後總結下線
結束時輸出一行總結。`;
}

function ownerOpenPrompt(wsId: string, scenario: Scenario, material: string): string {
  const jar = join(LOG_DIR, 'jar-owner.txt');
  const byName: Record<string, string> = {};
  for (const m of MEMBERS) byName[m.name] = m.userId!;
  const roster = MEMBERS.map((m) => `- ${m.name}（user_id ${m.userId}）：${m.profile}`).join('\n');

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

  const isBrain = scenario.key === 'brain';
  const missionLine = isBrain
    ? `你要為 AI 團隊發想/延續一個「主題專案」sprint。程式碼寫在獨立沙盒 repo（${BRAIN_ROOT}），題材不限、盡情發揮，但唯一硬約束＝可持續發展（能一場一場長大，不是一次性玩具）。`
    : `你要為團隊發想一個真實的 sprint：先讀下面 driver 已幫你蒐好的探勘材料，歸納一個「有主軸的主題」（技術債清償／健壯性強化／測試補強／前端體驗擇一），再把主題拆成 3-5 個可獨立完成的 task。`;
  const topicRules = isBrain
    ? `題目規則：
- 優先延續既有子專案（材料裡有的）；要開新專案，必須在 project 說明留言寫出「後續 2-3 場 sprint 的發展方向」證明可持續
- 每個 task 範圍明確、可獨立驗收；建議用 Node/TypeScript（環境工具鏈現成），選其他技術棧須在 task 描述自帶驗證指令
- task 描述要寫清楚：改哪個子目錄、要做什麼、怎麼驗收（可重跑的檢查）`
    : `題目規則（很重要，直接決定這場成敗）：
- 每題必須引用探勘材料中「實際看到」的具體檔案與具體問題，不可臆測不存在的東西
- 每題範圍限 1-2 個檔案；不同題不可重疊同一檔案（成員平行開發，重疊＝merge 衝突）
- 驗收＝npx tsc --noEmit + 跑相關測試檔通過，並寫明確的行為驗證
- 避開大工程（FTS5 全文檢索、multipart 上傳、DB migration 工具這類），難度以【小】為主、最多一題【中】
- 每題標難度【小/中/大】`;

  return `你是「${OWNER.name}」（${OWNER.email}），Owner。開一個真實的 sprint（認領制：你只開題、不指派，成員自己認領）。
workspace：${wsId}（目前名稱是暫定的「${scenario.title}」）。目前目錄是主 repo。
${missionLine}

=== driver 預蒐的探勘材料（你不用自己再跑指令，直接讀這個做判斷）===
${material}
=== 材料結束 ===

團隊成員（僅供你設計難度組合的參考，${isBrain ? '' : '注意各人擅長領域，'}不要指派任何 task 給特定人）：
${roster}

${API_RULES(jar)}
本次要做的事（只用 curl／git 讀取，不改 code）：
1. 歸納主題後，PATCH ${BASE}/api/workspaces/${wsId} {"name":"<你定的主題名稱，寫清楚主題，例如『前端錯誤處理一致性』>"} 把 workspace 改名為主題
2. POST ${BASE}/api/workspaces/${wsId}/projects {"name":"<同主題名稱>"}，取得 project id
3. 建 3-5 個 task（POST ${BASE}/api/workspaces/${wsId}/tasks，欄位 title/description/priority/projectId）：
   ${topicRules}
   ⚠️ 認領制：建 task 時 assignee 一律「留空/不填」，讓成員自己認領
   task 格式範例（可參考語氣與詳細度）：
   ${TASK_FORMAT_EXAMPLE}
4. 每個 task 留一則說明留言：為什麼這題重要、實作提示、預期會踩到的陷阱（你是資深工程師，給有價值的提醒）
結束時輸出一行總結（主題是什麼、開了幾題、難度分佈）。`;
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
2. 對每個 status=Review 的 task（認領制：從 task 的 assignee_id 對照上表看是誰做的、對應哪條 branch）：
   a. GET 它的 comments 了解實作者說了什麼
   b. 用 git diff master...<該成員的 branch> -- 看實際改動（也可 Read 檔案），認真審：正確性、測試是否真的驗到行為、有沒有多餘改動
   c. 合格 → 留言具體肯定＋「中場審查通過，收尾時合併」（狀態保持 Review）
   d. 不合格 → 留言具體問題（引用檔案與行為）→ PATCH {"status":"Doing"} 退回
3. 對「還沒被任何人認領」（assignee_id 為 null、還在 Todo）的 task：留言分析為什麼沒人領（題目太大？說明不清楚？），補充說明讓它更好認領，或點名建議哪位成員的專長適合（只是建議，不要強制指派）
4. 留言含 [ESCALATE] 的 task：能給指導就留言具體指導；屬於環境/基礎設施問題你也解不了的 → 留言「已上報 harness 上層處理」並保持該 task 現狀
結束時輸出審查總結（幾件過、幾件退、退的原因、幾件無人認領、幾件上報）。`;
}

function ownerClosePrompt(wsId: string, tag: string, verified: BranchReviewPacket[], scenario: Scenario): string {
  const jar = join(LOG_DIR, 'jar-owner-close.txt');
  const packetByBranch = new Map(verified.map((packet) => [packet.branch, packet]));
  const map = MEMBERS.map((m) => {
    const packet = packetByBranch.get(branch(m));
    if (!packet || packet.ahead === 0) return `- ${m.name} / ${branch(m)}: 無 commit`;
    return `- ${m.name} / ${packet.branch}: tsc ${packet.tsc.ok ? 'PASS' : 'FAIL'}, test ${packet.test.ok ? 'PASS' : 'FAIL'}, ${packet.ahead} commits, ${packet.changedFiles.length} files changed, packet: ${packet.packetPath}`;
  }).join('\n');
  const integrationStep = scenario.repoRoot === BRAIN_ROOT
    ? '3. 全部 merge 完成後，對「有被改動的子專案」各跑一次它自己的驗證（有 package.json+test script 就在該目錄 npm test；有 tsconfig 就 npx tsc --noEmit）做整合驗證；若失敗，git log 找出問題 merge、git reset --hard <該 merge 前> 退回它、在對應 task 留言退回原因 + PATCH {"status":"Doing"}'
    : '3. 全部 merge 完成後，跑「一次」npx tsc --noEmit && npm test 做整合驗證（不是每 branch 一次）；若整合失敗，git log 找出問題 merge、git reset --hard <該 merge 前> 退回它、在對應 task 留言退回原因 + PATCH {"status":"Doing"}';
  return `你是「${OWNER.name}」（${OWNER.email}），Owner。sprint 收尾：審查通過的合併進 master，總結全場。
workspace：${wsId}。目前目錄是主 repo（master，${REPO_ROOT}）。
CI（driver）已幫你把每個 branch 對 master 獨立跑過驗證，結果如下——你不用自己重跑各 branch 的測試：
${map}
${API_RULES(jar)}
本次流程（省時要點：信任上面 CI 預跑結果，不要逐 branch 重跑測試）：
1. GET ${BASE}/api/workspaces/${wsId}/tasks
2. 對每個 status=Review 且 CI 顯示驗證皆 PASS 的 task，依其 branch 逐一 merge（一次一個）：
   a. git diff master...<branch> 快速看 code（審查重點，不用跑測試）
   b. git merge --no-ff <branch> -m "merge: <task 標題>"；⚠️ 絕對不要手動解衝突——你的 session 有硬時限，手動解衝突是上一場 owner 逾時被強制中止的死因。遇衝突一律：git merge --abort → task 留言衝突檔案清單＋請該成員 rebase → PATCH {"status":"Doing"} 退回 → 繼續合下一條乾淨的 branch
   c. task 留言「已合併進 master（附 merge commit hash）」→ PATCH {"status":"Done"}
${integrationStep}
4. CI 顯示驗證 FAIL 的 branch：不要 merge，直接在 task 留言「具體」問題（引用檔案/行為，讓成員知道要修什麼）+ PATCH {"status":"Doing"} 退回——這題會進入重修
5. 還在 Todo/Doing 或無人認領的 task：留言說明現況；[BUG]/[ESCALATE] task：triage 留言、解不了的標「已上報 harness 上層處理」
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
    '## ⚠️ CI 綠燈但未合併',
    ...report.unmergedGreen.map((branchName) => `- ${branchName}`),
    ...(report.unmergedGreen.length ? [] : ['- (none)']),
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
  unmergedGreen: string[],
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
    unmergedGreen,
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
  // CI 綠燈（tsc+test 皆過）卻仍領先 master 的 branch＝該合未合，只信 git 事實，不信 task 狀態
  const greenAhead = branches
    .filter((packet) => packet.tsc.ok && packet.test.ok)
    .map((packet) => ({ branch: packet.branch, ahead: Number(git(['rev-list', '--count', `master..${packet.branch}`])) }))
    .filter((x) => x.ahead > 0);
  const unmergedGreen = greenAhead.map((x) => x.branch);
  const report = buildSprintReport(wsId, since, tag, tag, scenarioKey, promptArtifacts, branches, unmergedGreen);
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
  for (const g of greenAhead) console.log(`⚠️ CI 綠燈但未合併：${g.branch}（${g.ahead} commits）→ 手動：git merge --no-ff ${g.branch}`);
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

// brain 場 best-effort CI：依變動檔的子專案有無 tooling 決定跑什麼。無 tooling → 標記通過但註明需人工審 diff。
function brainChecks(worktree: string, changedFiles: string[], tscPath: string, testPath: string): { tsc: CommandCheck; test: CommandCheck } {
  const subs = [...new Set(changedFiles.map((f) => f.split('/')[0]).filter((s) => s && existsSync(join(worktree, s, 'package.json')) || s && existsSync(join(worktree, s, 'tsconfig.json'))))];
  const tscDir = subs.find((s) => existsSync(join(worktree, s, 'tsconfig.json')));
  const testDir = subs.find((s) => {
    const pkgPath = join(worktree, s, 'package.json');
    if (!existsSync(pkgPath)) return false;
    try { return !!(JSON.parse(readFileSync(pkgPath, 'utf8')).scripts?.test); } catch { return false; }
  });
  const noteOk = (path: string): CommandCheck => { writeFileSync(path, '無自動驗證（子專案未附 tooling）——owner 請人工審 diff\n'); return { ok: true, outputPath: path }; };
  const installIfNeeded = (dir: string) => { if (!existsSync(join(worktree, dir, 'node_modules'))) runCheck(join(worktree, dir), 'npm', ['install'], join(worktree, dir, '.sim-install.log')); };
  return {
    tsc: tscDir ? (installIfNeeded(tscDir), runCheck(join(worktree, tscDir), 'npx', ['tsc', '--noEmit'], tscPath)) : noteOk(tscPath),
    test: testDir ? (installIfNeeded(testDir), runCheck(join(worktree, testDir), 'npm', ['test'], testPath)) : noteOk(testPath),
  };
}

// owner 收尾前，driver 對每個 branch 獨立預跑驗證（機械工作交給 code，不佔 owner 的 LLM session）。
// 在各自 worktree 跑（主 repo 尚未 merge），彼此獨立故平行。結果注入 ownerClosePrompt，owner 只做判斷與 merge。
async function verifyBranches(runDir: string, scenario: Scenario): Promise<BranchReviewPacket[]> {
  const isBrain = scenario.repoRoot === BRAIN_ROOT;
  return Promise.all(MEMBERS.map(async (m) => {
    const packetBase = branch(m).replace(/[^a-zA-Z0-9_-]+/g, '-');
    const packetPath = join(runDir, 'review-packets', `${packetBase}.md`);
    const tscPath = join(runDir, 'review-packets', `${packetBase}-tsc.txt`);
    const testPath = join(runDir, 'review-packets', `${packetBase}-test.txt`);
    const base = (ahead: number): BranchReviewPacket => ({
      branch: branch(m), memberName: m.name, memberEmail: m.email, ahead,
      commits: [], changedFiles: [], diffstat: '',
      tsc: { ok: false, outputPath: tscPath }, test: { ok: false, outputPath: testPath }, packetPath,
    });
    if (!existsSync(wt(m))) return base(0);
    const ahead = Number(git(['rev-list', '--count', `master..${branch(m)}`]));
    const packet = base(ahead);
    if (!ahead) return packet;
    packet.commits = git(['log', '--oneline', `master..${branch(m)}`]).split('\n').filter(Boolean);
    packet.changedFiles = git(['diff', '--name-only', `master...${branch(m)}`]).split('\n').filter(Boolean);
    packet.diffstat = git(['diff', '--stat', `master...${branch(m)}`]);
    if (isBrain) {
      const checks = brainChecks(wt(m), packet.changedFiles, tscPath, testPath);
      packet.tsc = checks.tsc; packet.test = checks.test;
    } else {
      packet.tsc = runCheck(wt(m), 'npx', ['tsc', '--noEmit'], tscPath);
      packet.test = runCheck(wt(m), 'npm', ['test'], testPath);
    }
    writeFileSync(packetPath, formatReviewPacket(packet));
    console.log(`[CI預跑] ${branch(m)}: tsc ${packet.tsc.ok ? '✓' : '✗'} / test ${packet.test.ok ? '✓' : '✗'}（${ahead} commit）`);
    return packet;
  }));
}

// 看板永遠在 task-tracker DB（不論 scenario 的 code repo 是哪個）
function queryTasks(wsId: string): Array<{ assignee_id: string | null; status: string }> {
  const db = new DatabaseSync(join(ROOT, 'data/dev.db'));
  try { return db.prepare('SELECT assignee_id, status FROM tasks_read_model WHERE workspace_id = ?').all(wsId) as Array<{ assignee_id: string | null; status: string }>; }
  finally { db.close(); }
}

// 條件輪：只讓「有無主題可認領」或「名下還有 Todo/Doing」的成員上線，消滅儀式性空轉 session
function membersToRun(wsId: string): Member[] {
  const tasks = queryTasks(wsId);
  const unclaimed = tasks.some((t) => !t.assignee_id && t.status === 'Todo');
  return MEMBERS.filter((m) => unclaimed || tasks.some((t) => t.assignee_id === m.userId && (t.status === 'Todo' || t.status === 'Doing')));
}

// repair：owner 收尾把不合格題退回 Doing，找出名下有被退回題的成員來重修
function membersWithRejects(wsId: string): Member[] {
  const tasks = queryTasks(wsId);
  return MEMBERS.filter((m) => tasks.some((t) => t.assignee_id === m.userId && t.status === 'Doing'));
}

async function main(): Promise<void> {
  mkdirSync(LOG_DIR, { recursive: true });
  MEMBERS = loadMembersFromUsers();
  const scenario = parseScenario(process.argv);
  REPO_ROOT = scenario.repoRoot;
  WORK_DIR = join(REPO_ROOT, 'sim-work');
  const since = new Date().toISOString();
  const { wsId, tag } = await bootstrap(scenario);
  const runDir = createRunDir(LOG_DIR, tag);
  const promptArtifacts: PromptArtifact[] = [];

  const memberOpts = (m: Member) => ({ cwd: wt(m), tools: MEMBER_TOOLS, timeoutMs: MEMBER_TIMEOUT, runDir, promptArtifacts });
  const ownerOpts = { cwd: REPO_ROOT, tools: OWNER_TOOLS, timeoutMs: OWNER_TIMEOUT, runDir, promptArtifacts };

  // 一個 member session：跑 + 若是 codex 則 driver 代 commit
  const memberSession = async (m: Member, round: number) => {
    await runSession(`${m.name}-r${round}`, m.runner, m.model, memberPrompt(m, wsId, round, scenario), { ...memberOpts(m), promptLabel: `${m.user}-r${round}` });
    if (m.runner === 'codex') commitCodexWork(m, round);
  };
  // 一輪：成員並行，登入用小 jitter 錯開避免同秒撞認領
  const runRound = async (members: Member[], round: number, minJit: number, maxJit: number) =>
    Promise.all(members.map(async (m) => { await sleep(jitter(minJit, maxJit)); await memberSession(m, round); }));

  if (SMOKE) {
    await memberSession(MEMBERS[0], 1); // haiku
    await memberSession(MEMBERS[2], 1); // codex（驗證 driver 代 commit）
    printStats(runDir, wsId, since, tag, scenario.key, promptArtifacts, []);
    return;
  }

  // owner 開場（sonnet + driver 預蒐材料）→ 發想主題、改名 workspace、開無主 task
  const material = exploreMaterial(scenario);
  await runSession('owner-開場', 'claude', OWNER_OPEN_MODEL, ownerOpenPrompt(wsId, scenario, material), { ...ownerOpts, promptLabel: 'owner-open' });

  // 第 1 輪：全員上線認領
  await runRound(MEMBERS, 1, 1, 5);

  if (!FAST) {
    // 深度模式：中場審查（opus）＋條件式 r2-3
    await runSession('owner-中場審查', 'claude', OWNER_REVIEW_MODEL, ownerMidPrompt(wsId), { ...ownerOpts, promptLabel: 'owner-mid' });
    for (let r = 2; r <= 3; r++) {
      const active = membersToRun(wsId);
      if (!active.length) { console.log(`[r${r}] 無成員需上線（都已進 Review/Done），跳過`); break; }
      await runRound(active, r, 5, 15);
    }
  }

  // 收尾 merge（opus）＋ repair 迴圈（收尾退回的題重修至合格，上限 2 輪）
  let verified = await verifyBranches(runDir, scenario);
  await runSession('owner-收尾合併', 'claude', OWNER_REVIEW_MODEL, ownerClosePrompt(wsId, tag, verified, scenario), { ...ownerOpts, promptLabel: 'owner-close' });
  abortStaleMerge();

  for (let repair = 1; repair <= 2; repair++) {
    const toFix = membersWithRejects(wsId);
    if (!toFix.length) break;
    console.log(`[repair] 第 ${repair} 輪重修：${toFix.map((m) => m.name).join('、')}`);
    await runRound(toFix, 3 + repair, 1, 5);
    verified = await verifyBranches(runDir, scenario);
    await runSession(`owner-repair${repair}`, 'claude', OWNER_REVIEW_MODEL, ownerClosePrompt(wsId, tag, verified, scenario), { ...ownerOpts, promptLabel: `owner-repair${repair}` });
    abortStaleMerge();
  }

  printStats(runDir, wsId, since, tag, scenario.key, promptArtifacts, verified);
}

// ── Sweep：定時巡檢（systemd timer 觸發 --sweep owner/team）─────────────
// 把看板上未完成的工作收乾淨＋回應老闆留言＋推進無主 Todo。額度死了就直接退出
// ——timer 下個小時自己會再敲門，這就是「限額到了自動等下次」，零重試機制、零狀態。
const SWEEP_OWNER_TIMEOUT = 12 * 60 * 1000;
const SWEEP_MEMBER_TIMEOUT = 7 * 60 * 1000;
const BOSS_EMAIL = 'user09@test.local';

// owner 逾時自適應：跨 tick 狀態（sim-logs 下，gitignored）。上一輪 owner 逾時 → 這輪每逾時 +6 分（封頂 30）、
// 少收一個 workspace（封底 1），並把逾時的 workspace 排到最前面優先收（否則減 budget 反而跳過問題 workspace）。
interface SweepOwnerState { streak: number; timedOutWs: string[] }
const OWNER_STATE_FILE = join(LOG_DIR, '.sweep-owner-state.json');
function readOwnerState(): SweepOwnerState {
  try {
    const s = JSON.parse(readFileSync(OWNER_STATE_FILE, 'utf8')) as Partial<SweepOwnerState>;
    return { streak: Number(s.streak) || 0, timedOutWs: Array.isArray(s.timedOutWs) ? s.timedOutWs : [] };
  } catch { return { streak: 0, timedOutWs: [] }; }
}
function writeOwnerState(s: SweepOwnerState): void {
  try { writeFileSync(OWNER_STATE_FILE, JSON.stringify(s)); } catch { /* 寫不進去不致命，下輪照 base 值 */ }
}

function probeQuota(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('claude', ['-p', '回覆OK兩字即可', '--model', 'claude-haiku-4-5-20251001'],
      { timeout: 90 * 1000, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        const out = `${stdout ?? ''}${stderr ?? ''}`;
        resolve(!err && !/session limit|rate limit/i.test(out));
      });
  });
}

function branchAhead(m: Member): number {
  try {
    if (!git(['branch', '--list', branch(m)])) return 0;
    return Number(git(['rev-list', '--count', `master..${branch(m)}`]));
  } catch { return 0; }
}

// 巡檢的 worktree 可能已被清掉：branch 還有未合併工作就掛回來；branch 已合併/不存在就從 master 重開
function ensureWorktree(m: Member, scenario: Scenario): void {
  if (existsSync(wt(m))) return;
  const hasBranch = !!git(['branch', '--list', branch(m)]);
  if (hasBranch && branchAhead(m) === 0) git(['branch', '-D', branch(m)]);
  if (hasBranch && branchAhead(m) > 0) git(['worktree', 'add', wt(m), branch(m)]);
  else git(['worktree', 'add', wt(m), '-b', branch(m), 'master']);
  if (scenario.repoRoot === ROOT && !existsSync(join(wt(m), 'node_modules'))) {
    symlinkSync(join(ROOT, 'node_modules'), join(wt(m), 'node_modules'));
  }
}

interface SweepTask { task_id: string; title: string; status: string; assignee_id: string | null }

function ownerSweepPrompt(wsId: string, scenario: Scenario, verified: BranchReviewPacket[], bossName: string): string {
  const jar = join(LOG_DIR, 'jar-owner-sweep.txt');
  const packetByBranch = new Map(verified.map((p) => [p.branch, p]));
  const ci = MEMBERS.map((m) => {
    const p = packetByBranch.get(branch(m));
    if (!p || p.ahead === 0) return `- ${m.name} / ${branch(m)}: 無未合併 commit`;
    return `- ${m.name} / ${p.branch}: tsc ${p.tsc.ok ? 'PASS' : 'FAIL'}, test ${p.test.ok ? 'PASS' : 'FAIL'}, ${p.ahead} commits, packet: ${p.packetPath}`;
  }).join('\n');
  const memberIds = MEMBERS.map((m) => `- ${m.name}：user_id ${m.userId}`).join('\n');
  return `你是「${OWNER.name}」（${OWNER.email}），Owner。這是定時（每 30 分）的「巡檢」session：把看板收乾淨、回應老闆、讓團隊持續前進。
workspace：${wsId}。目前目錄是主 repo（master，${REPO_ROOT}）。
成員 user_id 對照：
${memberIds}
CI 摘要（driver 已預跑，信任它，不要自己重跑各 branch 測試）：
${ci || '（本 tick 無 branch 有新 commit）'}
${API_RULES(jar)}
巡檢流程（⚠️ 你有 12 分鐘硬時限，優先序：老闆回覆 > 綠燈合併 > 紅燈退回 > 催辦。時間不夠就少做，下次巡檢還會再來）：
1. GET ${BASE}/api/workspaces/${wsId}/tasks 全覽
2. [討論] task（title 以「[討論]」開頭）——這是你與老闆（${bossName}，真人）的對話串：
   - 不存在 → 建一個（title「[討論] 方向與下一步」，priority Low，不指派），留言 3-5 行提案接下來的方向，請老闆回覆
   - 存在 → 讀留言。最新一則若是老闆說的且你還沒回應：先回覆他；他核准/指示的方向就開成具體 task（認領制：不指派、寫清楚範圍與驗收）
   - [討論] task 永遠保持 Todo，不要推進狀態
3. status=Review 的 task 對照 CI 摘要：
   - CI 全 PASS → git merge --no-ff <branch> -m "merge: <task 標題>" → 留言（附 merge hash）→ PATCH {"status":"Done"}
     ⚠️ 遇衝突「絕對不要手動解」（上一場 owner 就是手動解衝突逾時被強制中止）：git merge --abort → 留言列出衝突檔案、請成員 rebase → PATCH {"status":"Doing"}
   - CI 有 FAIL → 留言具體問題（引檔案/行為）→ PATCH {"status":"Doing"}
   - CI 顯示無未合併 commit（工作佚失或已進 master）→ 用 git log 查 master 是否已含該修改：已含→留言說明並 PATCH Done；未含→留言「工作佚失需重做」→ PATCH {"status":"Doing"} 再 PATCH {"status":"Todo"}，並 PATCH {"assignee":null} 讓人重新認領
4. status=Doing 沒動靜的：催辦留言。無主 Todo 沒人領的：補充說明讓它更好認領
5. 有 merge 的話收尾跑一次整合驗證（${scenario.repoRoot === BRAIN_ROOT ? '被改子專案各自的 tsc/test' : 'npx tsc --noEmit && npm test'}）；失敗→git reset --hard 退回該 merge＋留言退回該 task
6. 結束輸出 3 行內總結（合了幾件、退了幾件、老闆有無新指示）`;
}

async function sweep(role: 'owner' | 'team' | 'both'): Promise<void> {
  mkdirSync(LOG_DIR, { recursive: true });
  MEMBERS = loadMembersFromUsers();
  const db = new DatabaseSync(join(ROOT, 'data/dev.db'));
  const boss = db.prepare('SELECT id, name FROM users WHERE email = ?').get(BOSS_EMAIL) as { id: string; name: string } | undefined;

  // 候選 workspace 來自歷次 run 的 report.json（零新狀態檔）；同 workspace 取最新 scenarioKey
  const wsScenario = new Map<string, { key: string; startedAt: string }>();
  for (const dir of readdirSync(LOG_DIR)) {
    const reportPath = join(LOG_DIR, dir, 'report.json');
    if (!existsSync(reportPath)) continue;
    try {
      const r = JSON.parse(readFileSync(reportPath, 'utf8')) as { workspaceId: string; scenarioKey: string; startedAt: string };
      const prev = wsScenario.get(r.workspaceId);
      if (!prev || r.startedAt > prev.startedAt) wsScenario.set(r.workspaceId, { key: r.scenarioKey, startedAt: r.startedAt });
    } catch { /* 壞檔跳過 */ }
  }

  interface PendingWs { wsId: string; scenario: Scenario; work: SweepTask[]; bossPinged: boolean; startedAt: string }
  const pendings: PendingWs[] = [];
  for (const [wsId, info] of wsScenario) {
    const ws = db.prepare('SELECT status FROM workspaces_read_model WHERE workspace_id = ?').get(wsId) as { status: string } | undefined;
    if (!ws || ws.status !== 'active') continue;
    const tasks = db.prepare("SELECT task_id, title, status, assignee_id FROM tasks_read_model WHERE workspace_id = ? AND status IN ('Todo','Doing','Review')").all(wsId) as unknown as SweepTask[];
    const discussions = tasks.filter((t) => t.title.startsWith('[討論]'));
    const work = tasks.filter((t) => !t.title.startsWith('[討論]'));
    const bossPinged = !!boss && discussions.some((d) => {
      const last = db.prepare('SELECT user_id FROM comments WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(d.task_id) as { user_id: string } | undefined;
      return last?.user_id === boss.id;
    });
    if (!work.length && !bossPinged) continue;
    const scenario = SCENARIOS[info.key as ScenarioKey] ?? SCENARIOS['self-directed'];
    pendings.push({ wsId, scenario, work, bossPinged, startedAt: info.startedAt });
  }
  db.close();

  if (!pendings.length) { console.log(`[sweep:${role}] 看板全收乾淨、老闆無新留言，本 tick 零成本結束`); return; }
  console.log(`[sweep:${role}] ${pendings.length} 個 workspace 有待收工作：${pendings.map((p) => `${p.wsId.slice(0, 8)}(${p.work.length}題${p.bossPinged ? '+老闆留言' : ''})`).join('、')}`);

  if (!(await probeQuota())) { console.log(`[sweep:${role}] 額度不足，本 tick 放棄，等下個 tick timer 再試`); return; }

  // owner 逾時自適應：上一輪 owner 逾時 streak 越高 → 這輪 timeout 越長、owner 收的 workspace 越少
  const ownerState = role === 'team' ? { streak: 0, timedOutWs: [] as string[] } : readOwnerState();
  const ownerTimeoutMs = Math.min(SWEEP_OWNER_TIMEOUT + ownerState.streak * 6 * 60 * 1000, 30 * 60 * 1000);
  // 預算按 role：owner tick 只跑 owner session、team tick 只跑成員 session（both=手動全掃）。做不完留給下個 tick，自癒
  let ownerBudget = role === 'team' ? 0 : Math.max(1, 2 - ownerState.streak);
  let memberBudget = role === 'owner' ? 0 : 2;
  if (ownerState.streak > 0) {
    console.log(`[sweep:${role}] 前輪 owner 逾時（streak ${ownerState.streak}）→ 本輪 timeout=${Math.round(ownerTimeoutMs / 60000)}分、owner 收 ${ownerBudget} 個、優先 ${ownerState.timedOutWs.map((x) => x.slice(0, 8)).join(',') || '(無記錄)'}`);
  }
  // 逾時過的 workspace 排最前（否則減 budget 會跳過它），其次新的優先
  pendings.sort((a, b) => {
    const at = ownerState.timedOutWs.includes(a.wsId) ? 1 : 0;
    const bt = ownerState.timedOutWs.includes(b.wsId) ? 1 : 0;
    return at !== bt ? bt - at : b.startedAt.localeCompare(a.startedAt);
  });
  let ownerSessionsRun = 0;
  const timedOutThisTick: string[] = [];
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

  for (const p of pendings) {
    if (ownerBudget <= 0 && memberBudget <= 0) break;
    REPO_ROOT = p.scenario.repoRoot;
    WORK_DIR = join(REPO_ROOT, 'sim-work');
    const runDir = createRunDir(LOG_DIR, `sweep-${stamp}-${p.wsId.slice(0, 8)}`);
    const promptArtifacts: PromptArtifact[] = [];

    // member userId 需要重新對應（跨 workspace 不同）
    const ownerCookie = await login(OWNER.email);
    const list = await api(`/api/workspaces/${p.wsId}/members`, {}, ownerCookie);
    for (const row of (list.body ?? []) as { user_id: string; email: string }[]) {
      const m = MEMBERS.find((x) => x.email === row.email);
      if (m) m.userId = row.user_id;
    }

    // verifyBranches 只給 owner 判斷 CI 用；team tick 免跑（省時）
    const anyAhead = MEMBERS.some((m) => branchAhead(m) > 0);
    const verified = (ownerBudget > 0 && anyAhead) ? await verifyBranches(runDir, p.scenario) : [];

    if (ownerBudget > 0) {
      const r = await runSession(`owner-巡檢-${p.wsId.slice(0, 8)}`, 'claude', OWNER_REVIEW_MODEL,
        ownerSweepPrompt(p.wsId, p.scenario, verified, boss?.name ?? '老闆'),
        { cwd: REPO_ROOT, tools: OWNER_TOOLS, timeoutMs: ownerTimeoutMs, runDir, promptArtifacts, promptLabel: `owner-sweep-${p.wsId.slice(0, 8)}` });
      ownerSessionsRun++;
      if (r.timedOut) timedOutThisTick.push(p.wsId);
      ownerBudget--;
      abortStaleMerge();
    }

    if (memberBudget > 0) {
      // owner 剛動過看板，重查現況再派工：被退回的優先，其次有無主 Todo 時派沒事做的成員去認領
      const db2 = new DatabaseSync(join(ROOT, 'data/dev.db'));
      const tasks2 = db2.prepare("SELECT task_id, title, status, assignee_id FROM tasks_read_model WHERE workspace_id = ? AND status IN ('Todo','Doing','Review')").all(p.wsId) as unknown as SweepTask[];
      db2.close();
      const work2 = tasks2.filter((t) => !t.title.startsWith('[討論]'));
      const rejected = MEMBERS.filter((m) => work2.some((t) => t.assignee_id === m.userId && t.status === 'Doing'));
      const unclaimed = work2.some((t) => !t.assignee_id && t.status === 'Todo');
      const idle = MEMBERS.filter((m) => !work2.some((t) => t.assignee_id === m.userId));
      const toRun = [...rejected, ...(unclaimed ? idle : [])].slice(0, memberBudget);
      if (toRun.length) {
        for (const m of toRun) ensureWorktree(m, p.scenario);
        const hour = new Date().getHours();
        await Promise.all(toRun.map(async (m) => {
          await sleep(jitter(1, 5));
          await runSession(`${m.name}-巡檢`, m.runner, m.model, memberPrompt(m, p.wsId, hour, p.scenario),
            { cwd: wt(m), tools: MEMBER_TOOLS, timeoutMs: SWEEP_MEMBER_TIMEOUT, runDir, promptArtifacts, promptLabel: `${m.user}-sweep` });
          if (m.runner === 'codex') commitCodexWork(m, hour);
        }));
        memberBudget -= toRun.length;
      }
    }
    console.log(`[sweep] ${p.wsId.slice(0, 8)} 處理完（剩餘預算 owner:${ownerBudget} member:${memberBudget}）`);
  }

  // 只有實際跑過 owner session 才更新逾時狀態：有逾時→streak+1（封頂5）並記下逾時的 workspace；沒逾時→歸零
  if (ownerSessionsRun > 0) {
    writeOwnerState(timedOutThisTick.length
      ? { streak: Math.min(ownerState.streak + 1, 5), timedOutWs: timedOutThisTick }
      : { streak: 0, timedOutWs: [] });
    if (timedOutThisTick.length) console.log(`[sweep:${role}] 本輪 ${timedOutThisTick.length} 個 owner session 逾時 → 下輪自動拉長 timeout、少收一個並優先它們`);
  }
  console.log('[sweep] 本 tick 結束；未完部分下個 tick 繼續');
}

if (require.main === module) {
  (SWEEP ? sweep(SWEEP_ROLE) : main()).catch((e) => { console.error(e); process.exit(1); });
}
