/**
 * production coordinator 的真實 AI runner。
 *
 * 這是 sim/production.ts:762 長期缺席的整合點：CLI 從來沒有提供
 * runOwnerSession／runMemberSession，只有整合測試會注入假的，因此 coordinator 在
 * --live 下必定失敗（2026-07-29 實測）。
 *
 * legacy 的 sim/run.ts 是「跑完 AI，再從 git 與看板讀結果」；coordinator 要的是
 * 結構化回傳（MemberSessionOutput / OwnerDecision）。兩者對不上，所以這裡的工作
 * 不是轉接，而是：在 prompt 裡要求 AI 輸出一段 JSON，跑完把它解析出來。
 *
 * Owner session 的唯讀保證來自 codex 的 `-s read-only` sandbox，不是工具白名單：
 * buildRunnerInvocation 的 codex 分支不看 opts.tools。這一點在 2026-07-29 差點出事
 * ——第一版用工具白名單當防護，而 production 的 dispatch 路徑又傳空的 worktreePath，
 * 使得那個號稱唯讀的 session 實際上是可寫、可連網、cwd 落在 repo root 的 codex。
 *
 * 已知契約落差：OwnerDecision.evidenceCommentIds 型別叫 "CommentIds"，但
 * OwnerSessionRunnerContext.comments 只是 string[]，沒有帶任何 id 進來，AI 不可能
 * 產出真的 comment id。這裡因此把它定義成「留言的位置標籤」（"#0"、"#1"），並在
 * prompt 裡明講。實測（2026-07-29）若不明講，codex 會回傳數字 0 而不是字串。
 * 該欄位目前在 coordinator 裡沒有任何消費者，只是預留的稽核欄位；哪天要拿它反查
 * 留言，得先讓 context 真的帶 comment id 進來。
 *
 * 失敗語意刻意 fail-closed：AI 沒有產生可解析的 JSON、欄位型別不符、或 process
 * 逾時／異常，一律 throw。production.ts:836 的 per-action try/catch 會把它記成
 * errorCount 並跳過該 action，該次 action 零 mutation。絕對不要在這裡回傳一個
 * 「看起來合法」的預設決策——agent.ts:356 解構後會直接使用 decision.action，
 * 不會先檢查 exitCode。
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRunnerInvocation, isQuotaExhaustion, type ModelRoute } from '../run';
import type {
  MemberSessionOutput,
  MemberSessionRunner,
  MemberSessionRunnerContext,
  OwnerDecision,
  OwnerSessionRunner,
  OwnerSessionRunnerContext,
} from './agent';

const LOG_DIR = join(__dirname, '../../sim-logs/production-sessions');

// coordinator 的 session context 刻意不帶成員身分（見 agent.ts 的
// MemberSessionRunnerContext 註解：「沒有任何欄位可以引用或切換到別的 task」），
// 所以這裡用單一固定 route，而不是 legacy 的 per-member 路由。
const OWNER_ROUTE: ModelRoute = {
  runner: 'codex',
  model: process.env.SIM_PROD_OWNER_MODEL ?? 'gpt-5.6-sol',
};
const MEMBER_ROUTE: ModelRoute = {
  runner: 'codex',
  model: process.env.SIM_PROD_MEMBER_MODEL ?? 'gpt-5.6-terra',
};

// 約束來自 codex 的 sandbox 模式，不是工具白名單：buildRunnerInvocation 的 codex 分支
// 根本不看 opts.tools（只有 claude 分支會用），而本模組的 route 硬寫 runner: 'codex'。
// 先前這裡有 OWNER_TOOLS/MEMBER_TOOLS 兩個常數，對 codex 完全不生效，只會讓讀者
// 誤以為 owner session 有防護——已刪除，改用底下的 sandbox 模式。
const OWNER_SANDBOX = 'read-only' as const;   // owner 只做判斷，不得寫任何檔案
const MEMBER_SANDBOX = 'workspace-write' as const; // member 要改檔，寫入被侷限在 -C 指定的 worktree

const SESSION_TIMEOUT_MS = Number(process.env.SIM_PROD_SESSION_TIMEOUT_MS ?? 20 * 60 * 1000);

const OUTPUT_CONTRACT = [
  '完成後，你的最後一段輸出必須是一個 ```json 程式碼區塊，且只包含下面指定的欄位。',
  '不要在 JSON 區塊裡加註解，不要輸出多個 JSON 區塊（會以最後一個為準）。',
].join('\n');

interface AiSessionResult {
  text: string;
  timedOut: boolean;
  errored: boolean;
  quotaExhausted: boolean;
  logFile: string;
}

function runAiSession(
  label: string,
  route: ModelRoute,
  prompt: string,
  cwd: string,
  sandbox: 'read-only' | 'workspace-write',
): Promise<AiSessionResult> {
  mkdirSync(LOG_DIR, { recursive: true });
  const logFile = join(LOG_DIR, `${new Date().toISOString().replace(/[:.]/gu, '-')}-${label}.log`);
  const invocation = buildRunnerInvocation(route, prompt, { cwd, logFile, sandbox });
  return new Promise((resolve) => {
    const child = execFile(
      invocation.command,
      invocation.args,
      { cwd, timeout: SESSION_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
        const timedOut = !!e && (e.killed === true || e.signal === 'SIGKILL');
        const combined = `${stdout}\n${stderr}\n${err ? String(err) : ''}`;
        writeFileSync(logFile, `PROMPT:\n${prompt}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}\n\nERR:${err ? String(err) : 'none'}\n`);
        // codex 會把最後一則訊息單獨寫到 <logFile>.last，比在 stdout 裡撈可靠。
        const lastFile = `${logFile}.last`;
        const text = existsSync(lastFile) ? readFileSync(lastFile, 'utf8') : stdout;
        resolve({ text, timedOut, errored: !!err, quotaExhausted: !!err && isQuotaExhaustion(combined), logFile });
      },
    );
    if (route.runner !== 'claude') child.stdin?.end(); // codex/agy headless 看到 piped stdin 會等 EOF
  });
}

/** 取出最後一個可解析的 JSON 區塊；找不到回 null，由呼叫端 throw 帶診斷訊息。 */
export function extractJsonBlock(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gu)];
  for (let i = fences.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(fences[i][1]);
    } catch {
      // 這個 fence 不是合法 JSON，往前一個試
    }
  }
  // 沒有 fence 時的退路：整段就是一個物件
  const start = text.indexOf('{');
  if (start >= 0) {
    try {
      return JSON.parse(text.slice(start));
    } catch {
      // 交給呼叫端報錯
    }
  }
  return null;
}

function asRecord(raw: unknown, where: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where}: 預期一個 JSON 物件，實際得到 ${JSON.stringify(raw)}`);
  }
  return raw as Record<string, unknown>;
}

function requireString(o: Record<string, unknown>, key: string, where: string): string {
  const value = o[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${where}: 欄位 ${key} 必須是非空字串，實際 ${JSON.stringify(value)}`);
  }
  return value;
}

function requireStringArray(o: Record<string, unknown>, key: string, where: string): string[] {
  const value = o[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${where}: 欄位 ${key} 必須是字串陣列，實際 ${JSON.stringify(value)}`);
  }
  return value as string[];
}

export function parseMemberOutput(raw: unknown, where: string): MemberSessionOutput {
  const o = asRecord(raw, where);
  const blocker = o.blocker;
  if (blocker !== null && typeof blocker !== 'string') {
    throw new Error(`${where}: 欄位 blocker 必須是字串或 null，實際 ${JSON.stringify(blocker)}`);
  }
  return {
    summary: requireString(o, 'summary', where),
    changedPaths: requireStringArray(o, 'changedPaths', where),
    verificationCommands: requireStringArray(o, 'verificationCommands', where),
    blocker: blocker === '' ? null : blocker,
  };
}

const OWNER_ACTIONS = ['classify', 'dispatch', 'intervene', 'accept', 'reject', 'conclude-discussion'] as const;
const CLASSIFICATIONS = ['bug', 'maintenance', 'approved', 'new-feature'] as const;
const OUTCOMES = ['implement', 'no_implementation', 'no_consensus'] as const;

export function parseOwnerDecision(raw: unknown, where: string): OwnerDecision {
  const o = asRecord(raw, where);
  const action = requireString(o, 'action', where);
  if (!(OWNER_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`${where}: action 必須是 ${OWNER_ACTIONS.join('｜')} 之一，實際 ${JSON.stringify(action)}`);
  }
  const decision: OwnerDecision = {
    action: action as OwnerDecision['action'],
    rationale: requireString(o, 'rationale', where),
    evidenceCommentIds: requireStringArray(o, 'evidenceCommentIds', where),
  };
  if (o.classification !== undefined && o.classification !== null) {
    const classification = requireString(o, 'classification', where);
    if (!(CLASSIFICATIONS as readonly string[]).includes(classification)) {
      throw new Error(`${where}: classification 必須是 ${CLASSIFICATIONS.join('｜')} 之一，實際 ${JSON.stringify(classification)}`);
    }
    decision.classification = classification as OwnerDecision['classification'];
  }
  if (o.outcome !== undefined && o.outcome !== null) {
    const outcome = requireString(o, 'outcome', where);
    if (!(OUTCOMES as readonly string[]).includes(outcome)) {
      throw new Error(`${where}: outcome 必須是 ${OUTCOMES.join('｜')} 之一，實際 ${JSON.stringify(outcome)}`);
    }
    decision.outcome = outcome as OwnerDecision['outcome'];
  }
  return decision;
}

export function memberPrompt(context: MemberSessionRunnerContext): string {
  return `你是 task ${context.taskId} 的實作者。

工作目錄：${context.worktreePath}
只能修改以下路徑前綴底下的檔案，其餘一律不得更動：
${context.allowedPrefixes.map((p) => `- ${p}`).join('\n') || '（未宣告，視為不得修改任何檔案）'}

驗收條件：
${context.acceptanceCriteria}

相關留言：
${context.comments.map((c, i) => `#${i} ${c}`).join('\n') || '（無）'}

可用的驗證指令（只能用這些，不得自行擴充）：
${context.verificationCommandAllowlist.map((c) => `- ${c}`).join('\n') || '（無）'}

規則：
- 不要執行任何 git 寫入操作（add／commit／merge／branch／checkout）；commit 由 driver 代勞。
- 不要動 ${context.worktreePath} 以外的任何檔案。
- 卡住就照實回報 blocker，不要假裝完成。

${OUTPUT_CONTRACT}
\`\`\`json
{
  "summary": "你做了什麼，一到三句",
  "changedPaths": ["實際改過的檔案路徑"],
  "verificationCommands": ["你實際跑過的驗證指令"],
  "blocker": null
}
\`\`\``;
}

export function ownerPrompt(context: OwnerSessionRunnerContext): string {
  return `你是 Owner，要對 task ${context.taskId} 做一次決策。

這是唯讀 session：不得修改 ${context.worktreePath} 底下任何檔案，也不得執行任何 git 寫入或 API 呼叫。
所有實際動作（改看板、留言、merge、部署）都由 driver 執行，你只負責產出決策。

待驗收的 head SHA：${context.reviewedHeadSha}
工作目錄（唯讀）：${context.worktreePath}

驗收條件：
${context.acceptanceCriteria}

相關留言：
${context.comments.map((c, i) => `#${i} ${c}`).join('\n') || '（無）'}

規則：
- action 必須是 ${OWNER_ACTIONS.join('、')} 其中之一。
- 若 action 是 accept，rationale 必須原樣引用 head SHA ${context.reviewedHeadSha}，否則整次決策會被判定無效。
- evidenceCommentIds 填你依據的留言標籤字串，就是上面每則留言前面的 #編號，例如 ["#0","#2"]；必須是字串，沒有依據就給空陣列 []。
- classify 時另外填 classification；conclude-discussion 時另外填 outcome。

${OUTPUT_CONTRACT}
\`\`\`json
{
  "action": "accept",
  "rationale": "為什麼，必要時引用 head SHA",
  "evidenceCommentIds": ["#0"],
  "classification": null,
  "outcome": null
}
\`\`\``;
}

/**
 * production 的 dispatch 路徑會傳空的 worktreePath（sim/production.ts:1026——那個階段
 * 還沒有 worktree）。execFile 的 `cwd: ''` 會 fallback 到父 process 的 cwd，也就是這個
 * repo 的 checkout，正是 sim-autodeploy.path 監看的那一個。給它一個拋棄式空目錄：
 * dispatch 階段的 AI 本來就只拿得到 task 標題，不需要任何檔案系統存取。
 */
function resolveSessionCwd(worktreePath: string): { cwd: string; cleanup: () => void } {
  if (worktreePath) return { cwd: worktreePath, cleanup: () => {} };
  const scratch = mkdtempSync(join(tmpdir(), 'prod-session-'));
  return { cwd: scratch, cleanup: () => rmSync(scratch, { recursive: true, force: true }) };
}

function assertSessionUsable(label: string, session: AiSessionResult): void {
  if (session.timedOut) {
    throw new Error(`${label}: AI session 逾時（${Math.round(SESSION_TIMEOUT_MS / 60000)} 分）；log=${session.logFile}`);
  }
  if (session.quotaExhausted) {
    throw new Error(`${label}: AI session 額度耗盡；log=${session.logFile}`);
  }
}

export function createMemberSessionRunner(route: ModelRoute = MEMBER_ROUTE): MemberSessionRunner {
  return async (context) => {
    const label = `member-${context.taskId.slice(0, 8)}`;
    const { cwd, cleanup } = resolveSessionCwd(context.worktreePath);
    try {
      const session = await runAiSession(label, route, memberPrompt(context), cwd, MEMBER_SANDBOX);
      assertSessionUsable(label, session);
      const raw = extractJsonBlock(session.text);
      if (raw === null) {
        throw new Error(`${label}: AI 沒有產生可解析的 JSON 區塊；log=${session.logFile}`);
      }
      return { exitCode: session.errored ? 1 : 0, output: parseMemberOutput(raw, `${label} (log=${session.logFile})`) };
    } finally {
      cleanup();
    }
  };
}

export function createOwnerSessionRunner(route: ModelRoute = OWNER_ROUTE): OwnerSessionRunner {
  return async (context) => {
    const label = `owner-${context.taskId.slice(0, 8)}`;
    const { cwd, cleanup } = resolveSessionCwd(context.worktreePath);
    try {
      const session = await runAiSession(label, route, ownerPrompt(context), cwd, OWNER_SANDBOX);
      assertSessionUsable(label, session);
      const raw = extractJsonBlock(session.text);
      if (raw === null) {
        throw new Error(`${label}: AI 沒有產生可解析的 JSON 區塊；log=${session.logFile}`);
      }
      return { exitCode: session.errored ? 1 : 0, decision: parseOwnerDecision(raw, `${label} (log=${session.logFile})`) };
    } finally {
      cleanup();
    }
  };
}
