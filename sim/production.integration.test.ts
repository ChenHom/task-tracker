// sim/production.ts 的 no-AI end-to-end integration test：暫存 SQLite app DB、fake
// task-tracker HTTP server、fake agent adapter、暫存 Git repo。全部是假的——絕不連線
// 到 localhost:3000 或本專案自己的 repo／worktree。
//
// 驗證：一次 `runOnce({ live: true, ... })` 呼叫，把一個 Todo／unassigned task 從
// 指派一路推進到 Doing -> member 實作 -> Review -> Owner 驗收 -> 模擬部署 -> 完成留言
// -> Done -> Discord 摘要；重新開啟 state（第二次呼叫 runOnce，同一個 dbPath）後，
// 第二個 tick 不得建立任何重複的 PATCH／留言／Discord 傳送。
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runOnce } from './production';
import type { OwnerSessionRunner } from './production/agent';
import type { MemberSessionRunner } from './production/agent';
import type { IntegrationCommandRunner, AcceptanceCheckResult, SendDiscordMessage } from './production/coordinator';
import type { GetSystemdReadback, CheckHealth, SystemdReadback } from './production/git';

// ---------------------------------------------------------------------------
// 暫存 Git repo：master + README，一路讓 ensureTaskWorktree／createIntegrationWorktree／
// mergeTaskIntoMaster 對它做真正的 git 操作（唯一真實 I/O，但完全在 os.tmpdir() 底下）。
// ---------------------------------------------------------------------------
function initTestRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'sim-production-integration-repo-'));
  const g = (args: string[]) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  g(['init', '-q', '-b', 'master']);
  g(['config', 'user.email', 'integration-test@example.com']);
  g(['config', 'user.name', 'Integration Test']);
  writeFileSync(join(repoRoot, 'README.md'), 'root\n');
  g(['add', 'README.md']);
  g(['commit', '-q', '-m', 'init']);
  return repoRoot;
}

function currentMasterSha(repoRoot: string): string {
  return execFileSync('git', ['rev-parse', 'master'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

// ---------------------------------------------------------------------------
// Fake task-tracker HTTP server：唯一的 workspace/task 是我們自建的假 task，ID 與
// CUTOVER_TASKS 裡任何一個真實 UUID 都不同，所以 selectCoordinatorActions 的固定
// cutover disposition 分支（activeReview／completedPrerequisite／deferredAssignment／
// mainDiscussion）全部不會命中，只會走一般 generic 排程——這正是這個測試要驗證的路徑。
// ---------------------------------------------------------------------------
const CANONICAL_WORKSPACE_ID = 'd9da9945-ce5f-400f-806e-1d75e95e313a';
const MAIN_WORKSPACE_ID = '11a82028-fc50-466a-a723-e002032cd9a6';
const OWNER_EMAIL = 'user01@test.local';
const USER09_EMAIL = 'user09@test.local';
const MEMBER_EMAIL = 'member1@test.local';
const OWNER_ID = 'owner-canonical-id';
const USER09_ID = 'user09-canonical-id';
const MEMBER_ID = 'member1-canonical-id';
const FAKE_TASK_ID = 'fake-task-1';

interface FakeComment {
  comment_id: string;
  task_id: string;
  user_id: string;
  content: string;
  created_at: string;
}
interface FakeNotification {
  notification_id: string;
  recipient_id: string;
  source_task_id: string;
  source_comment_id: string;
  snippet: string;
  created_at: string;
  read_at: string | null;
}

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function startFakeServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('startFakeServer: failed to bind'));
        return;
      }
      resolve({ port: address.port, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

interface FakeServerState {
  taskStatus: string;
  taskAssignee: string | null;
  taskVersion: number;
  comments: FakeComment[];
  notifications: FakeNotification[];
  patchCalls: number;
  postCommentCalls: number;
  commentSeq: number;
  notifSeq: number;
}

function makeFakeServerHandler(state: FakeServerState) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const cookie = req.headers.cookie ?? '';
    const isUser09 = cookie.includes('tt_session=user09-session');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.url === '/api/health' && req.method === 'GET') {
      json(200, { status: 'ok', db: true, rev: 'fake-rev' });
      return;
    }

    if (req.url === '/api/auth/login' && req.method === 'POST') {
      readJsonBody(req)
        .then((body) => {
          const session = body.email === USER09_EMAIL ? 'user09-session' : 'owner-session';
          res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `tt_session=${session}; HttpOnly; Path=/` });
          res.end(JSON.stringify({ ok: true }));
        })
        .catch(() => json(400, { error: 'bad body' }));
      return;
    }

    if (req.url === `/api/workspaces/${CANONICAL_WORKSPACE_ID}/tasks` && req.method === 'GET') {
      json(200, [
        {
          task_id: FAKE_TASK_ID,
          workspace_id: CANONICAL_WORKSPACE_ID,
          title: 'fake integration task',
          status: state.taskStatus,
          assignee_id: state.taskAssignee,
          due_at: null,
          version: state.taskVersion,
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ]);
      return;
    }
    if (req.url === `/api/workspaces/${MAIN_WORKSPACE_ID}/tasks` && req.method === 'GET') {
      json(200, []);
      return;
    }

    if (req.url === `/api/workspaces/${CANONICAL_WORKSPACE_ID}/members` && req.method === 'GET') {
      json(200, [
        { user_id: OWNER_ID, role: 'Owner', joined_at: '2026-01-01T00:00:00.000Z', email: OWNER_EMAIL, name: 'Owner' },
        { user_id: USER09_ID, role: 'Member', joined_at: '2026-01-01T00:00:00.000Z', email: USER09_EMAIL, name: 'User09' },
        { user_id: MEMBER_ID, role: 'Member', joined_at: '2026-01-01T00:00:00.000Z', email: MEMBER_EMAIL, name: 'Member1' },
      ]);
      return;
    }

    if (req.url === `/api/tasks/${FAKE_TASK_ID}` && req.method === 'GET') {
      json(200, {
        task_id: FAKE_TASK_ID,
        workspace_id: CANONICAL_WORKSPACE_ID,
        title: 'fake integration task',
        status: state.taskStatus,
        assignee_id: state.taskAssignee,
        due_at: null,
        version: state.taskVersion,
        updated_at: '2026-01-01T00:00:00.000Z',
      });
      return;
    }

    if (req.url === `/api/tasks/${FAKE_TASK_ID}` && req.method === 'PATCH') {
      state.patchCalls++;
      readJsonBody(req)
        .then((body) => {
          if ('assignee' in body) state.taskAssignee = body.assignee;
          if ('status' in body) state.taskStatus = body.status;
          state.taskVersion++;
          json(200, { ok: true });
        })
        .catch(() => json(400, { error: 'bad body' }));
      return;
    }

    if (req.url === `/api/tasks/${FAKE_TASK_ID}/comments` && req.method === 'GET') {
      json(200, state.comments);
      return;
    }
    if (req.url === `/api/tasks/${FAKE_TASK_ID}/comments` && req.method === 'POST') {
      state.postCommentCalls++;
      readJsonBody(req)
        .then((body) => {
          const commentId = `comment-${++state.commentSeq}`;
          const comment: FakeComment = {
            comment_id: commentId,
            task_id: FAKE_TASK_ID,
            user_id: OWNER_ID,
            content: body.content,
            created_at: `2026-01-01T00:00:${String(state.commentSeq).padStart(2, '0')}.000Z`,
          };
          state.comments.push(comment);
          // 真實 app 會在留言 @mention 使用者時自動建立 notification；這裡用同樣規則模擬。
          if (typeof body.content === 'string' && body.content.includes('@user09')) {
            state.notifications.push({
              notification_id: `notif-${++state.notifSeq}`,
              recipient_id: USER09_ID,
              source_task_id: FAKE_TASK_ID,
              source_comment_id: commentId,
              snippet: String(body.content).slice(0, 50),
              created_at: comment.created_at,
              read_at: null,
            });
          }
          json(201, { id: commentId });
        })
        .catch(() => json(400, { error: 'bad body' }));
      return;
    }

    if (req.url === '/api/notifications' && req.method === 'GET') {
      if (!isUser09) {
        json(200, []);
        return;
      }
      json(200, state.notifications);
      return;
    }

    json(404, { error: 'not found' });
  };
}

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const repoRoot = initTestRepo();
  const dbDir = mkdtempSync(join(tmpdir(), 'sim-production-integration-db-'));
  const dbPath = join(dbDir, 'coordinator.db');

  const state: FakeServerState = {
    taskStatus: 'Todo',
    taskAssignee: null,
    taskVersion: 1,
    comments: [],
    notifications: [],
    patchCalls: 0,
    postCommentCalls: 0,
    commentSeq: 0,
    notifSeq: 0,
  };

  const { port, close } = await startFakeServer(makeFakeServerHandler(state));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;

    const ownerSessionRunner: OwnerSessionRunner = async (context) => {
      if (context.reviewedHeadSha) {
        return {
          exitCode: 0,
          decision: { action: 'accept', rationale: `looks good, head ${context.reviewedHeadSha}`, evidenceCommentIds: [] },
        };
      }
      return { exitCode: 0, decision: { action: 'dispatch', rationale: 'assign to member1', evidenceCommentIds: [] } };
    };

    const memberSessionRunner: MemberSessionRunner = async (context) => {
      mkdirSync(join(context.worktreePath, 'feature'), { recursive: true });
      writeFileSync(join(context.worktreePath, 'feature', `${context.taskId}.txt`), 'implemented\n');
      return {
        exitCode: 0,
        output: {
          summary: `implemented ${context.taskId}`,
          changedPaths: [`feature/${context.taskId}.txt`],
          verificationCommands: ['npx tsc --noEmit'],
          blocker: null,
        },
      };
    };

    const alwaysPassCommand = async (_cmd: string, _cwd: string) => ({ exitCode: 0, output: 'ok' });
    const runIntegrationCommand: IntegrationCommandRunner = alwaysPassCommand;
    const acceptancePass = async (): Promise<AcceptanceCheckResult> => ({ passed: true, detail: 'ok' });

    // getSystemdReadback：第一次呼叫（runDeployAcceptance 的 pre-merge precondition 讀取）
    // 回傳 baseline；merge 真正發生之後，第二次起的呼叫回傳「新的一輪 invocation 已結束」，
    // deployed_rev 直接讀當下真正的 master HEAD（merge 已經完成，這裡讀到的就是 mergeSha）。
    let readbackCalls = 0;
    const getSystemdReadback: GetSystemdReadback = async (): Promise<SystemdReadback> => {
      readbackCalls++;
      if (readbackCalls === 1) {
        return {
          pathActive: true,
          serviceActiveState: 'inactive',
          invocationId: 'inv-0',
          execMainStartTimestampMonotonic: 1000,
          result: 'success',
          execMainStatus: 0,
          deployedRev: currentMasterSha(repoRoot),
        };
      }
      return {
        pathActive: true,
        serviceActiveState: 'inactive',
        invocationId: 'inv-1',
        execMainStartTimestampMonotonic: 5000,
        result: 'success',
        execMainStatus: 0,
        deployedRev: currentMasterSha(repoRoot),
      };
    };
    const checkHealth: CheckHealth = async () => ({ status: 'ok', db: true, rev: currentMasterSha(repoRoot) });

    let discordCalls = 0;
    const sendDiscordMessage: SendDiscordMessage = async () => {
      discordCalls++;
      return true;
    };

    let idCounter = 0;
    const newId = () => `id-${++idCounter}`;

    const runOptions = {
      live: true,
      baseUrl,
      dbPath,
      repoRoot,
      now: () => new Date(),
      isServiceActive: async () => true,
      allowedPrefixes: ['feature/'],
      runOwnerSession: ownerSessionRunner,
      runMemberSession: memberSessionRunner,
      runVerificationCommand: alwaysPassCommand,
      runIntegrationCommand,
      runBranchCi: async () => acceptancePass(),
      runTaskSpecificAcceptance: async () => acceptancePass(),
      runTaskLiveAcceptance: async () => acceptancePass(),
      getSystemdReadback,
      checkHealth,
      sendDiscordMessage,
      newId,
      sleep: async () => {},
    };

    // ---- 第一個 tick：Todo assignment -> Doing -> Review -> 模擬 deployment -> completion ----
    const first = await runOnce(runOptions);
    for (const line of first.lines) console.log(`  [tick1] ${line}`);
    assert.strictEqual(first.exitCode, 0, `第一個 tick 應該以 exit 0 完成，實際 lines:\n${first.lines.join('\n')}`);
    assert.strictEqual(state.taskStatus, 'Done', 'task 應該一路推進到 Done');
    assert.strictEqual(state.taskAssignee, MEMBER_ID, 'task 應該指派給 member1');

    const patchCallsAfterFirst = state.patchCalls;
    const postCommentCallsAfterFirst = state.postCommentCalls;
    const discordCallsAfterFirst = discordCalls;

    assert.strictEqual(patchCallsAfterFirst, 4, '恰好 4 次單欄位 PATCH：assignee, status=Doing, status=Review, status=Done');
    assert.strictEqual(postCommentCallsAfterFirst, 2, '恰好 2 則留言：member 摘要 + SYSTEM 完成留言');
    assert.strictEqual(discordCallsAfterFirst, 1, '恰好 1 次 Discord 傳送（單一 batch）');

    // ---- 重新開啟 state：第二個 tick 不得建立任何重複副作用 ----
    const second = await runOnce(runOptions);
    for (const line of second.lines) console.log(`  [tick2] ${line}`);
    assert.strictEqual(second.exitCode, 0, `第二個 tick 應該以 exit 0（task 已經 Done，零 action）完成，實際 lines:\n${second.lines.join('\n')}`);
    assert.strictEqual(state.patchCalls, patchCallsAfterFirst, '第二個 tick 不得再 PATCH 任何欄位');
    assert.strictEqual(state.postCommentCalls, postCommentCallsAfterFirst, '第二個 tick 不得再貼任何留言');
    assert.strictEqual(discordCalls, discordCallsAfterFirst, '第二個 tick 不得再送出任何 Discord 訊息');
  } finally {
    await close();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
}

main()
  .then(() => console.log('production.integration.test.ts OK'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
