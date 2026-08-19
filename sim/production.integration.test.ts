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

import { runOnce, runStatus, describeCutoverDisposition } from './production';
import type { TraceSink } from './trace';

// 測試不寫真的 trace：sim-logs/trace 是要拿來查真實車隊行為的，不能被測試資料汙染。
const silentTrace: TraceSink = () => {};
import type { OwnerSessionRunner } from './production/agent';
import type { MemberSessionRunner } from './production/agent';
import type { IntegrationCommandRunner, AcceptanceCheckResult, SendDiscordMessage } from './production/coordinator';
import type { GetSystemdReadback, CheckHealth, SystemdReadback } from './production/git';
import { CUTOVER_TASKS, MAIN_POLICY_TITLE, LEGACY_CANONICAL_DISCUSSION_TITLE, type TaskSnapshot } from './production/policy';
import { openCoordinatorState, beginTick, endTick, claimLease, upsertTaskCheckpoint, getTaskRun } from './production/state';

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

function makeFakeServerHandler(state: FakeServerState, taskId: string = FAKE_TASK_ID) {
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
          task_id: taskId,
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

    if (req.url === `/api/tasks/${taskId}` && req.method === 'GET') {
      json(200, {
        task_id: taskId,
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

    if (req.url === `/api/tasks/${taskId}` && req.method === 'PATCH') {
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

    if (req.url === `/api/tasks/${taskId}/comments` && req.method === 'GET') {
      json(200, state.comments);
      return;
    }
    if (req.url === `/api/tasks/${taskId}/comments` && req.method === 'POST') {
      state.postCommentCalls++;
      readJsonBody(req)
        .then((body) => {
          const commentId = `comment-${++state.commentSeq}`;
          const comment: FakeComment = {
            comment_id: commentId,
            task_id: taskId,
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
              source_task_id: taskId,
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
// testHappyPathTickLifecycle：Todo assignment -> Doing -> Review -> 模擬部署 ->
// completion -> Done -> Discord 摘要，一次 tick 內完成；第二個 tick 驗證冪等。
// ---------------------------------------------------------------------------
async function testHappyPathTickLifecycle(): Promise<void> {
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
      traceSink: silentTrace,
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
    assert.strictEqual(postCommentCallsAfterFirst, 3, '恰好 3 則留言：OWNER派工 + member 摘要 + SYSTEM 完成留言');
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

// =============================================================================
// testStuckDoingRecoversAfterWorktreeFailure（Critical 回歸測試）：assign＋Doing PATCH
// 都已經 durable 完成之後，ensureTaskWorktree 這一步失敗（這裡用「repo 沒有 master
// ref」重現，模擬 disk full／stale lock／權限錯誤等真實情境）。修好之前的 bug：
// dispatchMemberWork 對 `run.branch === null` 是一句永久 silent `return 'no_change'`
// ——task 卡在 Doing、branch 永遠是 null、noProgressCount 永遠不動、後續每個 tick 都
// 回報 exit 0，卻沒有任何人看得到訊號。這裡驗證兩件事：
//   (a) 在 repo 仍然壞掉的期間，連續失敗會被正確計入 no-progress／Owner 介入／
//       human_blocked 狀態機，最終貼出一則人類看得到的 @user09 留言（不是永遠沉默）；
//   (b) repo 修好之後，下一個 tick 的 worktree 重試會成功，task 能繼續往前走
//       （不是永久卡死，有路徑可以恢復）。
// =============================================================================
async function testStuckDoingRecoversAfterWorktreeFailure(): Promise<void> {
  const STUCK_TASK_ID = 'stuck-task-1';
  const dbDir = mkdtempSync(join(tmpdir(), 'sim-production-integration-stuck-db-'));
  const dbPath = join(dbDir, 'coordinator.db');

  // 一個「壞掉」的 repo：git repo 存在，但完全沒有 commit，所以連 `master` ref 都不
  // 存在——ensureTaskWorktree 內部的 `getHeadSha(repoRoot, 'master')` 會直接拋錯，
  // 完全不需要真的去模擬磁碟滿或檔案權限錯誤，效果等價（「這一步會 throw」才是重點）。
  const brokenRepoRoot = mkdtempSync(join(tmpdir(), 'sim-production-integration-stuck-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: brokenRepoRoot });

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
  const { port, close } = await startFakeServer(makeFakeServerHandler(state, STUCK_TASK_ID));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const ownerSessionRunner: OwnerSessionRunner = async () => ({
      exitCode: 0,
      decision: { action: 'dispatch', rationale: 'assign to member1', evidenceCommentIds: [] },
    });
    // member session runner 這裡永遠不應該真的被呼叫到（worktree 一直建立不出來，
    // dispatchMemberWork 會在呼叫 runMemberSession 之前就先 return），一旦被呼叫就是
    // 這個測試想抓的另一種 regression，所以讓它直接 throw。
    const memberSessionRunner: MemberSessionRunner = async () => {
      throw new Error('member session runner 不應該在 worktree 都還沒建立成功時被呼叫');
    };

    const baseOptions = {
      traceSink: silentTrace,
      live: true as const,
      baseUrl,
      dbPath,
      now: () => new Date(),
      isServiceActive: async () => true,
      allowedPrefixes: ['feature/'],
      runOwnerSession: ownerSessionRunner,
      runMemberSession: memberSessionRunner,
      runVerificationCommand: async () => ({ exitCode: 0, output: 'ok' }),
      runIntegrationCommand: async () => ({ exitCode: 0, output: 'ok' }),
      runBranchCi: async () => ({ passed: true, detail: 'ok' }) as AcceptanceCheckResult,
      runTaskSpecificAcceptance: async () => ({ passed: true, detail: 'ok' }) as AcceptanceCheckResult,
      runTaskLiveAcceptance: async () => ({ passed: true, detail: 'ok' }) as AcceptanceCheckResult,
      getSystemdReadback: (async () => {
        throw new Error('不應該在這個測試裡被呼叫（從沒走到 deploy 階段）');
      }) as GetSystemdReadback,
      checkHealth: (async () => ({ status: 'ok', db: true, rev: 'n/a' })) as CheckHealth,
      sendDiscordMessage: (async () => true) as SendDiscordMessage,
      newId: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
      sleep: async () => {},
    };

    // ---- tick 1：owner_dispatch。assign／Doing PATCH 成功（走假 HTTP server，跟 git
    //      無關），但 ensureTaskWorktree 因為 repo 沒有 master 而失敗——這個 tick 本身
    //      算一次 tick-level error（exit 1），這跟修 bug 前的行為一致，不是這次要修的
    //      部分；重點是「之後」的 tick 不能永遠沉默。
    const tick1 = await runOnce({ ...baseOptions, repoRoot: brokenRepoRoot });
    assert.strictEqual(tick1.exitCode, 1, `tick1 應該因為 worktree 建立失敗回報 exit 1，實際 lines:\n${tick1.lines.join('\n')}`);
    assert.strictEqual(state.taskStatus, 'Doing', 'assign／Doing PATCH 應該已經 durable 完成，即使 worktree 建立失敗');
    assert.strictEqual(state.taskAssignee, MEMBER_ID);

    const dbAfterTick1 = openCoordinatorState(dbPath);
    const runAfterTick1 = getTaskRun(dbAfterTick1, STUCK_TASK_ID);
    dbAfterTick1.close();
    assert.ok(runAfterTick1, 'tick1 之後應該已經有 task_run checkpoint');
    assert.strictEqual(runAfterTick1?.branch, null, 'worktree 建立失敗，branch 應該仍是 null');

    // ---- tick 2、3：repo 仍然是壞的。board 已經是 Doing／已指派，
    //      selectCoordinatorActions 只會選到 member_work；bug 修好前這裡會永久 silent
    //      no_change、noProgressCount 永遠不動；修好後每次都要真的重試 worktree、
    //      失敗後正確計入 no-progress 狀態機。
    for (let i = 0; i < 2; i++) {
      const tick = await runOnce({ ...baseOptions, repoRoot: brokenRepoRoot });
      assert.strictEqual(tick.exitCode, 0, `worktree 重試失敗屬於已追蹤的 no-progress，不是 tick-level error，應該還是 exit 0（第 ${i + 2} 個 tick）`);
    }
    const dbAfterTick3 = openCoordinatorState(dbPath);
    const runAfterTick3 = getTaskRun(dbAfterTick3, STUCK_TASK_ID);
    dbAfterTick3.close();
    assert.strictEqual(runAfterTick3?.branch, null, 'repo 還沒修好，branch 應該仍是 null');
    assert.ok((runAfterTick3?.noProgressCount ?? 0) >= 2, `noProgressCount 必須真的在累計（不是永遠沉默的 0），實際：${runAfterTick3?.noProgressCount}`);

    // ---- tick 4：再一次失敗，這次應該剛好跨過 Owner 介入 + human_blocked 門檻，
    //      貼出一則人類看得到的 @user09 留言——這正是「不是永遠沉默」的證據。
    await runOnce({ ...baseOptions, repoRoot: brokenRepoRoot });
    assert.ok(
      state.comments.some((c) => c.content.includes('@user09') && c.content.includes('已卡關')),
      `連續失敗最終必須貼出人類看得到的 human_blocked 留言，實際留言：\n${state.comments.map((c) => c.content).join('\n---\n')}`,
    );
    const dbAfterTick4 = openCoordinatorState(dbPath);
    const runAfterTick4 = getTaskRun(dbAfterTick4, STUCK_TASK_ID);
    dbAfterTick4.close();
    assert.strictEqual(runAfterTick4?.phase, 'human_blocked', 'task 應該已經轉入 human_blocked（不是永久沉默地卡在 doing）');

    // ---- 恢復路徑：把 repo 修好（補一個 commit，讓 master ref 存在）。human_blocked
    //      的留言本身改變了 evidence fingerprint，下一個 tick 會自然恢復嘗試；這次
    //      worktree 應該真的建立成功，task 可以繼續往前走（不是永久卡死）。
    writeFileSync(join(brokenRepoRoot, 'README.md'), 'root\n');
    execFileSync('git', ['add', 'README.md'], { cwd: brokenRepoRoot });
    execFileSync('git', ['config', 'user.email', 'stuck-repair@example.com'], { cwd: brokenRepoRoot });
    execFileSync('git', ['config', 'user.name', 'Stuck Repair' ], { cwd: brokenRepoRoot });
    execFileSync('git', ['commit', '-q', '-m', 'repair: repo now has a master ref'], { cwd: brokenRepoRoot });

    await runOnce({ ...baseOptions, repoRoot: brokenRepoRoot });
    const dbAfterRepair = openCoordinatorState(dbPath);
    const runAfterRepair = getTaskRun(dbAfterRepair, STUCK_TASK_ID);
    dbAfterRepair.close();
    assert.ok(runAfterRepair?.branch, `repo 修好之後，下一個 tick 的 worktree 重試應該成功並記錄 branch，實際：${JSON.stringify(runAfterRepair)}`);
  } finally {
    await close();
    rmSync(brokenRepoRoot, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
}

// =============================================================================
// testSameTickDoesNotDoubleBookAssignee（Important-1 回歸測試）：同一輪迭代裡有兩個
// 同時 idle 的 unassigned Todo task，也有兩個同時空閒的 candidate member——修好前
// resolveDispatchAssignee 只看單一凍結快照，兩個 task 會各自獨立解出同一個「第一個
// 空閒」member，造成真正的 WIP1 違規（同一人同時扛兩個 task）。這裡驗證兩個 task
// 最終必須落在兩個「不同」的 member 身上。
// =============================================================================
async function testSameTickDoesNotDoubleBookAssignee(): Promise<void> {
  const repoRoot = initTestRepo();
  const dbDir = mkdtempSync(join(tmpdir(), 'sim-production-integration-doublebook-db-'));
  const dbPath = join(dbDir, 'coordinator.db');

  const TASK_A = 'double-book-task-a';
  const TASK_B = 'double-book-task-b';
  const MEMBER1_ID = 'db-member1-id';
  const MEMBER2_ID = 'db-member2-id';

  interface DoubleBookTaskState {
    status: string;
    assigneeId: string | null;
    version: number;
  }
  const tasks: Record<string, DoubleBookTaskState> = {
    [TASK_A]: { status: 'Todo', assigneeId: null, version: 1 },
    [TASK_B]: { status: 'Todo', assigneeId: null, version: 1 },
  };
  const comments: Record<string, FakeComment[]> = { [TASK_A]: [], [TASK_B]: [] };
  let commentSeq = 0;

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.url === '/api/health' && req.method === 'GET') return json(200, { status: 'ok', db: true, rev: 'fake-rev' });
    if (req.url === '/api/auth/login' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'tt_session=owner-session; HttpOnly; Path=/' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === `/api/workspaces/${CANONICAL_WORKSPACE_ID}/tasks` && req.method === 'GET') {
      return json(
        200,
        Object.entries(tasks).map(([taskId, t]) => ({
          task_id: taskId,
          workspace_id: CANONICAL_WORKSPACE_ID,
          title: `task ${taskId}`,
          status: t.status,
          assignee_id: t.assigneeId,
          due_at: null,
          version: t.version,
          updated_at: null,
        })),
      );
    }
    if (req.url === `/api/workspaces/${MAIN_WORKSPACE_ID}/tasks` && req.method === 'GET') return json(200, []);
    if (req.url === `/api/workspaces/${CANONICAL_WORKSPACE_ID}/members` && req.method === 'GET') {
      return json(200, [
        { user_id: OWNER_ID, role: 'Owner', joined_at: '2026-01-01T00:00:00.000Z', email: OWNER_EMAIL, name: 'Owner' },
        { user_id: USER09_ID, role: 'Member', joined_at: '2026-01-01T00:00:00.000Z', email: USER09_EMAIL, name: 'User09' },
        { user_id: MEMBER1_ID, role: 'Member', joined_at: '2026-01-01T00:00:00.000Z', email: 'db-member1@test.local', name: 'M1' },
        { user_id: MEMBER2_ID, role: 'Member', joined_at: '2026-01-01T00:00:00.000Z', email: 'db-member2@test.local', name: 'M2' },
      ]);
    }
    for (const taskId of [TASK_A, TASK_B]) {
      if (req.url === `/api/tasks/${taskId}` && req.method === 'GET') {
        const t = tasks[taskId];
        return json(200, {
          task_id: taskId,
          workspace_id: CANONICAL_WORKSPACE_ID,
          title: `task ${taskId}`,
          status: t.status,
          assignee_id: t.assigneeId,
          due_at: null,
          version: t.version,
          updated_at: null,
        });
      }
      if (req.url === `/api/tasks/${taskId}` && req.method === 'PATCH') {
        readJsonBody(req)
          .then((body) => {
            if ('assignee' in body) tasks[taskId].assigneeId = body.assignee;
            if ('status' in body) tasks[taskId].status = body.status;
            tasks[taskId].version++;
            json(200, { ok: true });
          })
          .catch(() => json(400, { error: 'bad body' }));
        return;
      }
      if (req.url === `/api/tasks/${taskId}/comments` && req.method === 'GET') return json(200, comments[taskId]);
      if (req.url === `/api/tasks/${taskId}/comments` && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => {
            const commentId = `db-comment-${++commentSeq}`;
            comments[taskId].push({
              comment_id: commentId,
              task_id: taskId,
              user_id: OWNER_ID,
              content: body.content,
              created_at: '2026-01-01T00:00:00.000Z',
            });
            json(201, { id: commentId });
          })
          .catch(() => json(400, { error: 'bad body' }));
        return;
      }
    }
    if (req.url === '/api/notifications' && req.method === 'GET') return json(200, []);
    json(404, { error: 'not found' });
  };

  const { port, close } = await startFakeServer(handler);
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const ownerSessionRunner: OwnerSessionRunner = async () => ({
      exitCode: 0,
      decision: { action: 'dispatch', rationale: 'assign whoever is free', evidenceCommentIds: [] },
    });
    // member session 這裡故意回報「沒有真實變更」（no_change），讓兩個 task 在 dispatch
    // 之後就停在 Doing，不需要為這個測試額外準備完整的 deploy-acceptance fixture——
    // 這個測試只關心「dispatch 這一步有沒有把兩個 task 指派給同一個人」。
    const memberSessionRunner: MemberSessionRunner = async () => ({
      exitCode: 0,
      output: { summary: '', changedPaths: [], verificationCommands: [], blocker: 'not implemented yet in this test' },
    });

    const result = await runOnce({
      traceSink: silentTrace,
      live: true,
      baseUrl,
      dbPath,
      repoRoot,
      now: () => new Date(),
      isServiceActive: async () => true,
      allowedPrefixes: ['feature/'],
      runOwnerSession: ownerSessionRunner,
      runMemberSession: memberSessionRunner,
      sleep: async () => {},
    });

    const assigneeA = tasks[TASK_A].assigneeId;
    const assigneeB = tasks[TASK_B].assigneeId;
    assert.ok(assigneeA, `task A 應該被指派，實際 lines:\n${result.lines.join('\n')}`);
    assert.ok(assigneeB, `task B 應該被指派，實際 lines:\n${result.lines.join('\n')}`);
    assert.notStrictEqual(
      assigneeA,
      assigneeB,
      '同一輪迭代裡兩個同時 idle 的 unassigned Todo task 不得被指派給同一個 member（WIP1 違規）',
    );
    assert.deepStrictEqual(
      new Set([assigneeA, assigneeB]),
      new Set([MEMBER1_ID, MEMBER2_ID]),
      '兩個 task 應該剛好分別落在兩個不同的候選 member 身上',
    );
  } finally {
    await close();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
}

// =============================================================================
// testAssignMemberDoesNotCollideWithOwnerDispatch（Important-1 殘留缺口回歸測試）：
// 同一輪迭代裡，`selectCoordinatorActions` 把 deferredAssignment 的 `assign_member`
// action（policy.ts 固定指派給 user05）排在一般 `owner_dispatch` action 前面，兩者
// 共用同一份 frozen snapshot。如果 dispatchAssignMember 沒有把它解出的 assigneeId
// 記進 claimedAssigneesThisIteration，緊接著同一輪的 owner_dispatch 呼叫
// resolveDispatchAssignee 時，user05 在這份快照裡仍然「看起來」空閒，可能被重複指派
// 給另一個 unassigned Todo task——同一人同一輪被指派兩個任務。這裡用最小 fixture
// 重現：一個真的滿足 gate（938aa035 Done）的 deferredAssignment task（027c0052）+
// 一個一般 unassigned Todo task，候選 member 只有 user05 跟 member2 兩人，且刻意讓
// user05 的 userId 排序在 member2 之前（sort 出來會是「第一個空閒」），驗證一般
// Todo task 最終落在 member2 身上，而不是被重複指派給已經拿到 deferredAssignment
// 的 user05。
// =============================================================================
async function testAssignMemberDoesNotCollideWithOwnerDispatch(): Promise<void> {
  const repoRoot = initTestRepo();
  const dbDir = mkdtempSync(join(tmpdir(), 'sim-production-integration-collide-db-'));
  const dbPath = join(dbDir, 'coordinator.db');

  const GENERIC_TASK_ID = 'generic-unassigned-todo';
  const GATE_TASK_ID = CUTOVER_TASKS.deferredAssignment.afterTaskId; // 938aa035...（也是 activeReview.taskId）
  const DEFERRED_TASK_ID = CUTOVER_TASKS.deferredAssignment.taskId; // 027c0052...
  // 刻意讓 user05 排序在 member2 之前，讓「若沒有正確互相看見對方認領狀態，兩個 task
  // 都會被重複指派給 user05（排序後第一個空閒候選人）」這件事在測試裡是可辨識的。
  const USER05_ID = 'aaa-user05-fake-id';
  const MEMBER2_ID = 'zzz-member2-fake-id';

  interface CollideTaskState {
    status: string;
    assigneeId: string | null;
    version: number;
  }
  const tasks: Record<string, CollideTaskState> = {
    [GATE_TASK_ID]: { status: 'Done', assigneeId: USER05_ID, version: 9 },
    [DEFERRED_TASK_ID]: { status: 'Todo', assigneeId: null, version: 1 },
    [GENERIC_TASK_ID]: { status: 'Todo', assigneeId: null, version: 1 },
  };
  const comments: Record<string, FakeComment[]> = { [GATE_TASK_ID]: [], [DEFERRED_TASK_ID]: [], [GENERIC_TASK_ID]: [] };
  let commentSeq = 0;

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.url === '/api/health' && req.method === 'GET') return json(200, { status: 'ok', db: true, rev: 'fake-rev' });
    if (req.url === '/api/auth/login' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'tt_session=owner-session; HttpOnly; Path=/' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === `/api/workspaces/${CANONICAL_WORKSPACE_ID}/tasks` && req.method === 'GET') {
      return json(
        200,
        Object.entries(tasks).map(([taskId, t]) => ({
          task_id: taskId,
          workspace_id: CANONICAL_WORKSPACE_ID,
          title: `task ${taskId}`,
          status: t.status,
          assignee_id: t.assigneeId,
          due_at: null,
          version: t.version,
          updated_at: null,
        })),
      );
    }
    if (req.url === `/api/workspaces/${MAIN_WORKSPACE_ID}/tasks` && req.method === 'GET') return json(200, []);
    if (req.url === `/api/workspaces/${CANONICAL_WORKSPACE_ID}/members` && req.method === 'GET') {
      return json(200, [
        { user_id: OWNER_ID, role: 'Owner', joined_at: '2026-01-01T00:00:00.000Z', email: OWNER_EMAIL, name: 'Owner' },
        { user_id: USER09_ID, role: 'Member', joined_at: '2026-01-01T00:00:00.000Z', email: USER09_EMAIL, name: 'User09' },
        {
          user_id: USER05_ID,
          role: 'Member',
          joined_at: '2026-01-01T00:00:00.000Z',
          email: CUTOVER_TASKS.deferredAssignment.assigneeEmail,
          name: 'User05',
        },
        { user_id: MEMBER2_ID, role: 'Member', joined_at: '2026-01-01T00:00:00.000Z', email: 'member2@test.local', name: 'Member2' },
      ]);
    }
    for (const taskId of [GATE_TASK_ID, DEFERRED_TASK_ID, GENERIC_TASK_ID]) {
      if (req.url === `/api/tasks/${taskId}` && req.method === 'GET') {
        const t = tasks[taskId];
        return json(200, {
          task_id: taskId,
          workspace_id: CANONICAL_WORKSPACE_ID,
          title: `task ${taskId}`,
          status: t.status,
          assignee_id: t.assigneeId,
          due_at: null,
          version: t.version,
          updated_at: null,
        });
      }
      if (req.url === `/api/tasks/${taskId}` && req.method === 'PATCH') {
        readJsonBody(req)
          .then((body) => {
            if ('assignee' in body) tasks[taskId].assigneeId = body.assignee;
            if ('status' in body) tasks[taskId].status = body.status;
            tasks[taskId].version++;
            json(200, { ok: true });
          })
          .catch(() => json(400, { error: 'bad body' }));
        return;
      }
      if (req.url === `/api/tasks/${taskId}/comments` && req.method === 'GET') return json(200, comments[taskId]);
      if (req.url === `/api/tasks/${taskId}/comments` && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => {
            const commentId = `collide-comment-${++commentSeq}`;
            comments[taskId].push({
              comment_id: commentId,
              task_id: taskId,
              user_id: OWNER_ID,
              content: body.content,
              created_at: '2026-01-01T00:00:00.000Z',
            });
            json(201, { id: commentId });
          })
          .catch(() => json(400, { error: 'bad body' }));
        return;
      }
    }
    if (req.url === '/api/notifications' && req.method === 'GET') return json(200, []);
    json(404, { error: 'not found' });
  };

  const { port, close } = await startFakeServer(handler);
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const ownerSessionRunner: OwnerSessionRunner = async () => ({
      exitCode: 0,
      decision: { action: 'dispatch', rationale: 'assign whoever is free', evidenceCommentIds: [] },
    });
    const memberSessionRunner: MemberSessionRunner = async () => ({
      exitCode: 0,
      output: { summary: '', changedPaths: [], verificationCommands: [], blocker: 'not implemented yet in this test' },
    });

    const result = await runOnce({
      traceSink: silentTrace,
      live: true,
      baseUrl,
      dbPath,
      repoRoot,
      now: () => new Date(),
      isServiceActive: async () => true,
      allowedPrefixes: ['feature/'],
      runOwnerSession: ownerSessionRunner,
      runMemberSession: memberSessionRunner,
      sleep: async () => {},
    });

    const deferredAssignee = tasks[DEFERRED_TASK_ID].assigneeId;
    const genericAssignee = tasks[GENERIC_TASK_ID].assigneeId;

    assert.strictEqual(
      deferredAssignee,
      USER05_ID,
      `deferredAssignment task 應該固定指派給 user05，實際 lines:\n${result.lines.join('\n')}`,
    );
    assert.ok(genericAssignee, `一般 unassigned Todo task 也應該在同一輪被指派出去，實際 lines:\n${result.lines.join('\n')}`);
    assert.notStrictEqual(
      genericAssignee,
      USER05_ID,
      'user05 已經在同一輪迭代裡被 deferredAssignment 認領，owner_dispatch 不得把同一個人再指派給另一個 task（WIP1 違規）',
    );
    assert.strictEqual(genericAssignee, MEMBER2_ID, '排除 user05 之後，一般 Todo task 應該落到唯一剩下的候選 member2 身上');
  } finally {
    await close();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
}

// =============================================================================
// testExitCodeCutoverPrerequisiteMissing：`00123ef0...`（completedPrerequisite）
// 存在但完成證據鏈不完整（status 不是 Done）——exit 2，dry-run 與 live 都要驗證，且
// 兩者都必須零 mutation（live 模式必須在呼叫任何 AI runner／dispatch 之前就短路，
// 不需要注入 runOwnerSession／runMemberSession 也能正確回報）。
// =============================================================================
async function testExitCodeCutoverPrerequisiteMissing(): Promise<void> {
  const dbDir = mkdtempSync(join(tmpdir(), 'sim-production-integration-db2-'));
  const dbPath = join(dbDir, 'coordinator.db');
  let patchCalls = 0;
  let postCommentCalls = 0;

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/api/health' && req.method === 'GET') return json(200, { status: 'ok', db: true, rev: 'fake-rev' });
    if (req.url === '/api/auth/login' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'tt_session=owner-session; HttpOnly; Path=/' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === `/api/workspaces/${CANONICAL_WORKSPACE_ID}/tasks` && req.method === 'GET') {
      return json(200, [
        {
          task_id: CUTOVER_TASKS.completedPrerequisite.taskId,
          workspace_id: CANONICAL_WORKSPACE_ID,
          title: 'prerequisite task (incomplete evidence)',
          status: 'Todo', // 不是 requiredStatus('Done')——證據鏈第一步就不成立
          assignee_id: null,
          due_at: null,
          version: 1,
          updated_at: null,
        },
      ]);
    }
    if (req.url === `/api/workspaces/${MAIN_WORKSPACE_ID}/tasks` && req.method === 'GET') return json(200, []);
    if (req.url === `/api/workspaces/${CANONICAL_WORKSPACE_ID}/members` && req.method === 'GET') {
      return json(200, [
        { user_id: OWNER_ID, role: 'Owner', joined_at: '2026-01-01T00:00:00.000Z', email: OWNER_EMAIL, name: 'Owner' },
        { user_id: USER09_ID, role: 'Member', joined_at: '2026-01-01T00:00:00.000Z', email: USER09_EMAIL, name: 'User09' },
      ]);
    }
    if (req.url === `/api/tasks/${CUTOVER_TASKS.completedPrerequisite.taskId}/comments` && req.method === 'GET') return json(200, []);
    if (req.url?.endsWith('/comments') && req.method === 'POST') {
      postCommentCalls++;
      return json(201, { id: 'should-not-happen' });
    }
    if (req.method === 'PATCH') {
      patchCalls++;
      return json(200, { ok: true });
    }
    if (req.url === '/api/notifications' && req.method === 'GET') return json(200, []);
    json(404, { error: 'not found' });
  };

  const { port, close } = await startFakeServer(handler);
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const commonOptions = { traceSink: silentTrace, baseUrl, dbPath, repoRoot: '/nonexistent-not-used', now: () => new Date(), isServiceActive: async () => true };

    const dryRun = await runOnce({ ...commonOptions, live: false });
    assert.strictEqual(dryRun.exitCode, 2, `dry-run 應該回報 CutoverPrerequisiteMissing (exit 2)，實際 lines:\n${dryRun.lines.join('\n')}`);
    assert.ok(dryRun.lines.some((l) => l.includes('CutoverPrerequisiteMissing')), 'dry-run 輸出必須明確提到 CutoverPrerequisiteMissing');

    // live:true 也必須回報 exit 2、零 mutation——注意這裡刻意不注入 runOwnerSession／
    // runMemberSession：如果程式碼真的做到「零 AI」，這個呼叫完全不需要它們也能正確回報。
    const liveRun = await runOnce({ ...commonOptions, live: true });
    assert.strictEqual(liveRun.exitCode, 2, `live 模式也應該回報 CutoverPrerequisiteMissing (exit 2)，實際 lines:\n${liveRun.lines.join('\n')}`);

    assert.strictEqual(patchCalls, 0, 'CutoverPrerequisiteMissing 必須零 PATCH（dry-run + live 兩次呼叫合計）');
    assert.strictEqual(postCommentCalls, 0, 'CutoverPrerequisiteMissing 必須零留言（dry-run + live 兩次呼叫合計）');
  } finally {
    await close();
    rmSync(dbDir, { recursive: true, force: true });
  }
}

// =============================================================================
// testExitCodeDiscoveryUnavailable：兩個代表性子情境（health 非 200／登入失敗），
// 各自驗證 exit 3、零 mutation。不窮舉全部四種觸發條件。
// =============================================================================
async function testExitCodeDiscoveryUnavailable(): Promise<void> {
  const dbDir = mkdtempSync(join(tmpdir(), 'sim-production-integration-db3-'));
  const dbPath = join(dbDir, 'coordinator.db');

  // ---- 子情境 A：/api/health 回非 200 ----
  {
    let mutationCalls = 0;
    const { port, close } = await startFakeServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unavailable' }));
        return;
      }
      if (req.method === 'PATCH' || req.method === 'POST') mutationCalls++;
      res.writeHead(404);
      res.end();
    });
    try {
      const result = await runOnce({
      traceSink: silentTrace,
        live: false,
        baseUrl: `http://127.0.0.1:${port}`,
        dbPath,
        isServiceActive: async () => true,
        now: () => new Date(),
      });
      assert.strictEqual(result.exitCode, 3, `health 非 200 應該回報 DiscoveryUnavailable (exit 3)，實際 lines:\n${result.lines.join('\n')}`);
      assert.ok(result.lines.some((l) => l.includes('DiscoveryUnavailable')), '輸出必須明確提到 DiscoveryUnavailable');
      assert.strictEqual(mutationCalls, 0, 'health 檢查失敗後不得有任何 mutation 呼叫');
    } finally {
      await close();
    }
  }

  // ---- 子情境 B：health 正常，但登入失敗 ----
  {
    let mutationCalls = 0;
    const { port, close } = await startFakeServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', db: true, rev: 'fake-rev' }));
        return;
      }
      if (req.url === '/api/auth/login' && req.method === 'POST') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '帳號或密碼錯誤' }));
        return;
      }
      if (req.method === 'PATCH' || req.method === 'POST') mutationCalls++;
      res.writeHead(404);
      res.end();
    });
    try {
      const result = await runOnce({
      traceSink: silentTrace,
        live: false,
        baseUrl: `http://127.0.0.1:${port}`,
        dbPath,
        isServiceActive: async () => true,
        now: () => new Date(),
      });
      assert.strictEqual(result.exitCode, 3, `登入失敗應該回報 DiscoveryUnavailable (exit 3)，實際 lines:\n${result.lines.join('\n')}`);
      assert.ok(result.lines.some((l) => l.includes('DiscoveryUnavailable')), '輸出必須明確提到 DiscoveryUnavailable');
      assert.strictEqual(mutationCalls, 0, '登入失敗後不得有任何 mutation 呼叫');
    } finally {
      await close();
    }
  }

  rmSync(dbDir, { recursive: true, force: true });
}

// =============================================================================
// testDescribeCutoverDisposition：純函式，用假造的 snapshot 直接驗證每一行輸出都
// 真的是從傳入的 tasks／userIdsByEmail 算出來的——這正是原本 queuedReview 那一行
// 寫死字串的 bug 應該被抓到的測試。兩個情境：尚未收斂（每一行都該反映「現況」）與
// 已收斂／滿足前置條件（每一行都該反映「目標已達成」）。
// =============================================================================
function testDescribeCutoverDisposition(): void {
  const USER06_ID = 'user06-fake-id';
  const USER05_ID = 'user05-fake-id';
  const userIdsByEmail = { 'user06@test.local': USER06_ID, 'user05@test.local': USER05_ID };

  // ---- 情境 A：尚未收斂——activeReview 進行中、queuedReview 還沒被 task 9 reconcile
  //      （現實中就是這個狀態：Review／有 assignee，不是 Todo／unassigned）、
  //      deferredAssignment 的 gate 還沒 Done、prerequisite 未滿足。
  {
    const tasks: TaskSnapshot[] = [
      {
        taskId: CUTOVER_TASKS.activeReview.taskId, // 同時也是 deferredAssignment.afterTaskId
        workspaceId: CANONICAL_WORKSPACE_ID,
        title: 'active review task',
        status: 'Review',
        assigneeId: USER06_ID,
        dueAt: null,
        updatedAt: null,
        version: 1,
      },
      {
        taskId: CUTOVER_TASKS.queuedReview.taskId,
        workspaceId: CANONICAL_WORKSPACE_ID,
        title: 'queued review task',
        status: 'Review', // 尚未收斂到 Todo／unassigned
        assigneeId: USER06_ID,
        dueAt: null,
        updatedAt: null,
        version: 1,
      },
      {
        taskId: CUTOVER_TASKS.deferredAssignment.taskId,
        workspaceId: CANONICAL_WORKSPACE_ID,
        title: 'deferred assignment task',
        status: 'Todo',
        assigneeId: null,
        dueAt: null,
        updatedAt: null,
        version: 1,
      },
    ];
    const lines = describeCutoverDisposition(tasks, userIdsByEmail, false);
    assert.strictEqual(lines[0], `${CUTOVER_TASKS.activeReview.taskId.slice(0, 8)}... -> user06／active`);
    assert.strictEqual(
      lines[1],
      `${CUTOVER_TASKS.queuedReview.taskId.slice(0, 8)}... -> 尚待任務 9 reconciliation（目前：Review／user06）`,
      'queuedReview 尚未收斂時必須誠實反映目前真實的 status／assignee，不得寫死 queued／unassigned',
    );
    assert.strictEqual(
      lines[2],
      `${CUTOVER_TASKS.completedPrerequisite.taskId.slice(0, 8)}... -> CutoverPrerequisiteMissing：完成證據鏈缺漏或不相符`,
    );
    assert.strictEqual(lines[3], `${CUTOVER_TASKS.mainDiscussion.slice(0, 8)}... -> 等待任務1前置條件通過`);
    assert.strictEqual(lines[4], `${CUTOVER_TASKS.deferredAssignment.taskId.slice(0, 8)}... -> 等待 938 Done 後交給 user05`);
  }

  // ---- 情境 B：已收斂——queuedReview 真的是 Todo／unassigned，gate task 已 Done，
  //      prerequisite 已滿足。
  {
    const tasks: TaskSnapshot[] = [
      {
        taskId: CUTOVER_TASKS.activeReview.taskId,
        workspaceId: CANONICAL_WORKSPACE_ID,
        title: 'active review task',
        status: 'Done',
        assigneeId: USER06_ID,
        dueAt: null,
        updatedAt: null,
        version: 1,
      },
      {
        taskId: CUTOVER_TASKS.queuedReview.taskId,
        workspaceId: CANONICAL_WORKSPACE_ID,
        title: 'queued review task',
        status: 'Todo',
        assigneeId: null,
        dueAt: null,
        updatedAt: null,
        version: 1,
      },
      {
        taskId: CUTOVER_TASKS.deferredAssignment.taskId,
        workspaceId: CANONICAL_WORKSPACE_ID,
        title: 'deferred assignment task',
        status: 'Doing',
        assigneeId: USER05_ID,
        dueAt: null,
        updatedAt: null,
        version: 2,
      },
      {
        taskId: CUTOVER_TASKS.mainPolicy,
        workspaceId: MAIN_WORKSPACE_ID,
        title: MAIN_POLICY_TITLE,
        status: 'Todo',
        assigneeId: null,
        dueAt: null,
        updatedAt: null,
        version: 1,
      },
      {
        taskId: CUTOVER_TASKS.legacyCanonicalDiscussion,
        workspaceId: CANONICAL_WORKSPACE_ID,
        title: LEGACY_CANONICAL_DISCUSSION_TITLE,
        status: 'Todo',
        assigneeId: null,
        dueAt: null,
        updatedAt: null,
        version: 1,
      },
    ];
    const lines = describeCutoverDisposition(tasks, userIdsByEmail, true);
    assert.strictEqual(lines[0], `${CUTOVER_TASKS.activeReview.taskId.slice(0, 8)}... -> user06／active`);
    assert.strictEqual(
      lines[1],
      `${CUTOVER_TASKS.queuedReview.taskId.slice(0, 8)}... -> queued／unassigned`,
      'queuedReview 真的收斂到 Todo／unassigned 時才可以顯示 queued／unassigned',
    );
    assert.strictEqual(
      lines[2],
      `${CUTOVER_TASKS.completedPrerequisite.taskId.slice(0, 8)}... -> 任務 1 已完成前置條件／cutover 無 action`,
    );
    assert.strictEqual(lines[3], `${CUTOVER_TASKS.mainDiscussion.slice(0, 8)}... -> 前置條件通過後機械式結案`);
    assert.strictEqual(lines[4], `${CUTOVER_TASKS.deferredAssignment.taskId.slice(0, 8)}... -> user05／已派工`);
    assert.strictEqual(lines[5], `${CUTOVER_TASKS.mainPolicy.slice(0, 8)}... -> excluded (mainPolicy)`);
    assert.strictEqual(lines[6], `${CUTOVER_TASKS.legacyCanonicalDiscussion.slice(0, 8)}... -> excluded (legacyCanonicalDiscussion)`);
  }
}

// =============================================================================
// testRunStatus：heartbeat／active-lease 健康判斷。真的開一個暫存 SQLite（runStatus
// 本身就是直接操作 DatabaseSync，沒有假 HTTP server 可以注入）。
// =============================================================================
function testRunStatus(): void {
  const dbDir = mkdtempSync(join(tmpdir(), 'sim-production-integration-status-'));
  const dbPath = join(dbDir, 'status.db');
  const base = new Date('2026-01-01T00:00:00.000Z');

  try {
    // ---- 情境 A：完全沒有任何 tick、也沒有 active lease -> unhealthy ----
    {
      const result = runStatus({ dbPath, now: () => base });
      assert.strictEqual(result.exitCode, 1, '沒有任何 tick 紀錄且沒有 active lease 應該 unhealthy');
    }

    // ---- 情境 B：剛完成一個 tick（在 30 分鐘窗口內）-> healthy ----
    {
      const db = openCoordinatorState(dbPath);
      beginTick(db, 'tick-recent', base);
      endTick(db, { tickId: 'tick-recent', outcome: 'ok', discoveredCount: 0, processedCount: 0, skippedCount: 0, errorCount: 0 }, base);
      db.close();
      const result = runStatus({ dbPath, now: () => new Date(base.getTime() + 5 * 60 * 1000) }); // 5 分鐘後
      assert.strictEqual(result.exitCode, 0, '30 分鐘內有已完成的 tick 應該 healthy');
    }

    // ---- 情境 C：那個 tick 已經是 31 分鐘前、也沒有 active lease -> unhealthy ----
    {
      const result = runStatus({ dbPath, now: () => new Date(base.getTime() + 31 * 60 * 1000) });
      assert.strictEqual(result.exitCode, 1, '超過 30 分鐘沒有新 heartbeat、且沒有 active lease 應該 unhealthy');
    }

    // ---- 情境 D：一樣是 31 分鐘前的 tick，但現在有一個 active lease（模擬正在等待
    //      部署的長 tick）-> healthy，不誤判 ----
    {
      const db = openCoordinatorState(dbPath);
      const leaseNow = new Date(base.getTime() + 31 * 60 * 1000);
      upsertTaskCheckpoint(db, { taskId: 'long-running-task', workspaceId: CANONICAL_WORKSPACE_ID, phase: 'review', evidenceFingerprint: '' }, leaseNow);
      claimLease(db, { taskId: 'long-running-task', workerId: 'tick-in-flight', now: leaseNow });
      db.close();
      const result = runStatus({ dbPath, now: () => new Date(leaseNow.getTime() + 1000) });
      assert.strictEqual(result.exitCode, 0, '即使超過 30 分鐘沒有新 heartbeat，只要有 active lease 就不該誤判 unhealthy');
      assert.ok(result.lines.some((l) => l.includes('active leases: 1')), 'active leases 計數應該反映剛剛 claim 的那一筆');
    }
  } finally {
    rmSync(dbDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  await testHappyPathTickLifecycle();
  await testStuckDoingRecoversAfterWorktreeFailure();
  await testSameTickDoesNotDoubleBookAssignee();
  await testAssignMemberDoesNotCollideWithOwnerDispatch();
  await testExitCodeCutoverPrerequisiteMissing();
  await testExitCodeDiscoveryUnavailable();
  testDescribeCutoverDisposition();
  testRunStatus();
}

main()
  .then(() => console.log('production.integration.test.ts OK'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
