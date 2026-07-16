import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/schema';
import { MAIN_POLICY_TITLE, MAIN_WORKSPACE_ID } from '../src/mainWorkspacePolicy';
import {
  acquireRunLock,
  allChecksPass,
  assertPathWithin,
  BRAIN_ROOT,
  buildRunnerInvocation,
  brainChecks,
  canonicalWorkspaceDirectory,
  canonicalWorkspaceForRepoRoot,
  compareSweepCandidates,
  commitIfSessionSucceeded,
  createRunDir,
  dirtyReviewChecks,
  ensureCanonicalWorkspaceCandidates,
  ensureMainWorkspaceCandidate,
  eligibleManagedRunners,
  formatReportMarkdown,
  formatReviewPacket,
  hasReviewChanges,
  isSweepWorkTask,
  isManagedRosterWorkspace,
  loadMembersFromUsers,
  mainDiscussionNeedsOwner,
  MAIN_OWNER_TOOLS,
  MEMBER_TOOLS,
  notificationRouteForMember,
  parseScenario,
  ROOT,
  runMemberSession,
  scenarioFromStoredKey,
  selectAssignedMembers,
  settleAllOrThrow,
  shouldFallbackToModel,
  sweepCandidateUsesRepoSlot,
  sweepBudgets,
  validateGitRootFacts,
  withRunLock,
  workspaceFitsSweepBudget,
  writePromptArtifact,
  workSessionForMember,
  isQuotaExhaustion,
  notificationGatePrompt,
  processNotificationGate,
  reconcileManagedRoster,
  runNotificationSweep,
  runNotificationSweepForMember,
  runNotificationGatedSession,
  type NotificationGateActor,
  type NotificationGateRequest,
  type NotificationSweepMember,
  type ManagedRosterMember,
} from './run';

const source = readFileSync(join(__dirname, 'run.ts'), 'utf8');
const ownerProbe = source.match(/function probeOwnerRunner\(\): Promise<boolean> \{[\s\S]*?\n\}/)?.[0];
assert.ok(ownerProbe?.includes('const child = execFile('), 'owner probe 必須保留 child，才能管理 stdin lifecycle');
assert.ok(ownerProbe?.includes('child.stdin?.end()'), 'owner probe 必須關閉 Codex stdin，避免等待 EOF 而逾時');
assert.ok(!source.includes('const MEMBERS: Member[] = ['), 'MEMBERS 不應在 sim/run.ts 寫死 email/name');
assert.ok(!source.includes('let REPO_ROOT'), 'scenario 狀態不應拆成多個可不同步的 global');
assert.ok(!source.includes('let WORK_DIR'), 'scenario 狀態不應拆成多個可不同步的 global');
assert.ok(!source.includes('let MEMBERS'), 'scenario 狀態不應拆成多個可不同步的 global');
assert.ok(!MEMBER_TOOLS.includes('Bash(git:*)'), 'member tool policy 不應直接允許任意 Git 指令');
assert.ok(MEMBER_TOOLS.includes('Bash(git merge:*)'), 'member 必須能在 owner 明確退回 merge conflict 時合併 master');
assert.ok(!MEMBER_TOOLS.includes('Bash(git rebase:*)'), 'member 不應使用會改寫 branch history 的 rebase');
assert.ok(
  source.includes('只有 owner 最新審查明確指出 merge conflict 並要求同步 master 時'),
  'member prompt 必須提供 merge conflict 的窄範圍 Git 例外',
);
assert.ok(!source.includes('請該成員 rebase'), 'owner 不可要求被禁止且會改寫 history 的 rebase');
assert.strictEqual(source.match(/請該成員 merge master/g)?.length, 2, '兩種 owner prompt 都必須交接非破壞性的 merge master');
assert.strictEqual(MAIN_OWNER_TOOLS, 'Bash(curl:*)', 'main owner session 只能使用 curl');
assert.ok(source.includes('CI 有 SKIP'), 'owner prompt 必須保留 SKIP 人工審查規則');
assert.ok(source.includes('[CROSS-REPO]'), '跨 repo 轉移需要獨立標記，不能沿用死路的 [ESCALATE]');
assert.strictEqual(
  source.match(/ensureMainWorkspaceCandidate\(wsScenario\);\n\s*ensureCanonicalWorkspaceCandidates\(wsScenario\);/g)?.length,
  1,
  'main candidate 必須恰好一次且緊鄰 canonical candidate 前加入',
);
assert.strictEqual(source.match(/\.filter\(isSweepWorkTask\)/g)?.length, 2, '兩次 sweep task scan 都必須排除討論與規則');
assert.ok(
  source.includes('- 主協作工作區（${MAIN_WORKSPACE_ID}）只放討論；非 user01 不改狀態，實作 task 必須建立在目標工作區。'),
  '所有 agent prompt 都必須知道主工作區邊界',
);
assert.ok(source.includes('未登記，人工介入選定'), '主工作區 prompt 必須標示未登記 repo 需要人工介入');
assert.ok(source.includes('【OWNER想法】'), '主工作區 prompt 必須先提出 OWNER 想法');
for (const field of [
  '現況／問題：',
  '預期價值：',
  '風險與反對理由：',
  '現行可替代方案：',
  '初步判斷：',
  '希望成員確認的問題：',
]) {
  assert.ok(source.includes(field), `主工作區 OWNER prompt 必須提供六欄模板：${field}`);
}
assert.ok(source.includes('【全員回覆：2天】'), '主工作區 prompt 必須使用固定回覆窗口');
assert.ok(source.includes('@user02 @user03 @user04 @user05 @user06 @user09'), '主工作區 prompt 必須通知六位 Commenter');
assert.ok(source.includes('Todo→Done'), '主工作區 prompt 必須只完成 Todo → Done');
assert.ok(source.includes('不追逐、不列缺席者'), '主工作區 prompt 不得追蹤缺席者');
assert.ok(
  source.includes('沒有新增實質意見、直接指示或流程節點變化時，不得 POST 留言'),
  '主工作區 owner 無變化時必須保持靜默，不能重複張貼期限或 Todo 摘要',
);
assert.ok(source.includes('只用 curl/API 操作，不得編輯、提交或合併任何程式碼'), '主工作區 owner session 必須是 API-only');
assert.ok(source.includes('${canonicalWorkspaceDirectory()}'), '主工作區 prompt 必須嵌入 canonical repo/workspace 對照');
assert.ok(source.includes('先從討論內容辨識 target repo'), '主工作區 prompt 必須先辨識目標 repo');
assert.ok(source.includes('先檢查原討論留言與目標 workspace'), '重試 handoff 前必須先檢查既有 task 避免重複建立');
assert.strictEqual(source.match(/\[討論\] task 永遠保持 Todo/g)?.length, 1, '舊 Todo 規則只能保留在非 main prompt');
assert.strictEqual(
  source.match(/ownerBudget > 0 && sweepCandidateUsesRepoSlot\(p\.wsId\)/g)?.length,
  2,
  'main API-only sweep 不得還原 worktree 或執行 branch verification',
);
assert.ok(
  source.includes('sweepCandidateUsesRepoSlot(p.wsId) && processedRepoRoots.has(p.scenario.repoRoot)'),
  '只有使用 repo slot 的 candidate 才能被 processedRepoRoots 擋下',
);
assert.ok(
  source.includes('if (sweepCandidateUsesRepoSlot(p.wsId)) processedRepoRoots.add(p.scenario.repoRoot);'),
  '只有 code workspace 能占用 repo slot',
);
assert.ok(
  source.includes('if (p.wsId === MAIN_WORKSPACE_ID) activateMainSweepContext(members);'),
  'main sweep 必須略過 scenario git 驗證與 brain 初始化',
);
assert.ok(
  source.includes('tools: p.wsId === MAIN_WORKSPACE_ID ? MAIN_OWNER_TOOLS : OWNER_TOOLS'),
  'main owner runSession 必須使用 curl-only tools',
);
assert.ok(source.includes('if (p.wsId !== MAIN_WORKSPACE_ID) abortStaleMerge();'), 'main owner session 後不得操作 git merge 狀態');
const mainPromptSource = source.slice(
  source.indexOf('if (wsId === MAIN_WORKSPACE_ID)'),
  source.indexOf('const packetByBranch', source.indexOf('if (wsId === MAIN_WORKSPACE_ID)')),
);
assert.ok(!mainPromptSource.includes('${BASE}/#/task/<id>'), '主工作區 prompt 不得回寫 URL');
assert.ok(!mainPromptSource.includes('HANDOFF-PENDING'), '主工作區 prompt 不得使用 handoff marker');
assert.ok(
  (source.match(/runActorSessionWithNotificationGate\(/g)?.length ?? 0) >= 8,
  '一般 run 與 owner/team sweep 的每條自動 session 路徑都必須經 notification gate wrapper',
);
assert.ok(source.includes("if (role !== 'owner')"), 'team/both sweep 必須啟動全成員通知巡檢');
assert.ok(
  /runNotificationSweep\(\s*members/.test(source),
  '通知巡檢必須使用 sweep 開頭已載入的 members',
);
assert.ok(
  !/runNotificationSweep\(\s*RUN\.members/.test(source),
  '通知巡檢不得使用尚未 activate scenario 的 RUN.members',
);
assert.ok(source.includes('notification sweep 未完成，略過一般 session'), '通知巡檢失敗時不得進一般 member session');
assert.ok(source.includes('selectAssignedMembers'), '一般派工必須由 assigned member selector 決定');
assert.ok(source.includes('無 assignee Todo 不啟動'), 'scheduler 必須嚴格等待 Owner 指派');
assert.ok(!source.includes('認領制看板'), 'member prompt 不得再使用認領制');

// Notification gate contract (injected HTTP client keeps these tests offline).
const gateActor = {
  id: 'u2', email: 'user02@test.local', name: '小美',
} satisfies NotificationGateActor;
type GateResponse = { status: number; body: unknown };
function fakeGateRequest(queue: Record<string, GateResponse[]>): { request: NotificationGateRequest; calls: string[] } {
  const calls: string[] = [];
  const request: NotificationGateRequest = async (path, init = {}) => {
    const method = init.method ?? 'GET';
    const key = `${method} ${path}`;
    calls.push(key);
    const responses = queue[key] ?? [];
    const response = responses.shift();
    if (!response) throw new Error(`fake response missing: ${key}`);
    return response;
  };
  return { request, calls };
}
const unreadNotification = (notificationId: string, taskId: string, commentId: string, createdAt = '2026-07-14T03:59:00.000Z') => ({
  notification_id: notificationId, recipient_id: gateActor.id, source_task_id: taskId,
  source_comment_id: commentId, snippet: '請確認', created_at: createdAt, read_at: null,
});
const readNotification = (notificationId: string, taskId: string, commentId: string, createdAt?: string) => ({
  ...unreadNotification(notificationId, taskId, commentId, createdAt), read_at: '2026-07-14T04:00:00.000Z',
});
const gateTask = (taskId: string, workspaceId: string) => ({
  task_id: taskId, workspace_id: workspaceId, creator_id: 'creator', project_id: null,
  title: '通知來源', description: '說明', status: 'Todo', priority: 'Medium',
  assignee_id: null, due_at: null, version: 1, updated_at: '2026-07-14T03:58:00.000Z',
});
const gateComment = (taskId: string, commentId: string, userId = 'owner', content = '請確認', createdAt = '2026-07-14T03:59:00.000Z') => ({
  comment_id: commentId, task_id: taskId, user_id: userId, content, created_at: createdAt,
});

async function runNotificationGateTests(): Promise<void> {
  const empty = fakeGateRequest({
    'GET /api/notifications': [{ status: 200, body: [] }],
  });
  const noUnread = await processNotificationGate({
    actor: gateActor,
    cookie: 'session=test',
    request: empty.request,
    runPreflight: async () => { throw new Error('不該啟動 preflight'); },
    log: () => undefined,
    snapshotAt: '2026-07-14T04:00:00.000Z',
  });
  assert.deepStrictEqual(noUnread, { ready: true, snapshotIds: [], preflightStarted: false });

  let regularRuns = 0;
  const skipped = await runNotificationGatedSession(
    async () => ({ ready: false, snapshotIds: ['n-main'], preflightStarted: false }),
    async () => { regularRuns++; return { errored: false, timedOut: false, quotaExhausted: false }; },
  );
  assert.strictEqual(skipped, null);
  assert.strictEqual(regularRuns, 0, 'gate 未清空時不得進入一般 session');

  const general = fakeGateRequest({
    'GET /api/notifications': [
      { status: 200, body: [unreadNotification('n-general', 'task-general', 'comment-general')] },
      { status: 200, body: [readNotification('n-general', 'task-general', 'comment-general')] },
    ],
    'GET /api/tasks/task-general': [{ status: 200, body: gateTask('task-general', 'workspace-general') }],
    'GET /api/tasks/task-general/comments': [{ status: 200, body: [gateComment('task-general', 'comment-general')] }],
    'POST /api/notifications/n-general/read': [{ status: 200, body: { ok: true } }],
  });
  let preflightPrompt = '';
  const generalResult = await processNotificationGate({
    actor: gateActor, cookie: 'session=test', request: general.request,
    runPreflight: async (prompt) => { preflightPrompt = prompt; return { errored: false, timedOut: false }; },
    log: () => undefined, snapshotAt: '2026-07-14T04:00:00.000Z',
  });
  assert.deepStrictEqual(generalResult, { ready: true, snapshotIds: ['n-general'], preflightStarted: true });
  assert.ok(preflightPrompt.includes('task-general'));
  assert.deepStrictEqual(general.calls, [
    'GET /api/notifications', 'GET /api/tasks/task-general', 'GET /api/tasks/task-general/comments',
    'POST /api/notifications/n-general/read', 'GET /api/notifications',
  ]);

  const main = fakeGateRequest({
    'GET /api/notifications': [
      { status: 200, body: [unreadNotification('n-main', 'task-main', 'comment-main')] },
      { status: 200, body: [{ ...unreadNotification('n-main', 'task-main', 'comment-main'), read_at: '2026-07-14T04:02:00.000Z' }] },
    ],
    'GET /api/tasks/task-main': [{ status: 200, body: gateTask('task-main', MAIN_WORKSPACE_ID) }],
    'GET /api/tasks/task-main/comments': [
      { status: 200, body: [gateComment('task-main', 'comment-main')] },
      { status: 200, body: [
        gateComment('task-main', 'comment-main'),
        gateComment('task-main', 'reply-main', gateActor.id, '已閱讀，目前無補充。', '2026-07-14T04:01:00.000Z'),
      ] },
    ],
    'POST /api/notifications/n-main/read': [{ status: 200, body: { ok: true } }],
  });
  const mainResult = await processNotificationGate({
    actor: gateActor, cookie: 'session=test', request: main.request,
    runPreflight: async () => ({ errored: false, timedOut: false }),
    log: () => undefined, snapshotAt: '2026-07-14T04:00:00.000Z',
  });
  assert.deepStrictEqual(mainResult, { ready: true, snapshotIds: ['n-main'], preflightStarted: true });
  assert.ok(main.calls.indexOf('GET /api/tasks/task-main/comments') < main.calls.indexOf('POST /api/notifications/n-main/read'));

  const missingReply = fakeGateRequest({
    'GET /api/notifications': [{ status: 200, body: [unreadNotification('n-missing', 'task-missing', 'comment-missing')] }],
    'GET /api/tasks/task-missing': [{ status: 200, body: gateTask('task-missing', MAIN_WORKSPACE_ID) }],
    'GET /api/tasks/task-missing/comments': [
      { status: 200, body: [gateComment('task-missing', 'comment-missing')] },
      { status: 200, body: [gateComment('task-missing', 'comment-missing')] },
    ],
  });
  const missingReplyResult = await processNotificationGate({
    actor: gateActor, cookie: 'session=test', request: missingReply.request,
    runPreflight: async () => ({ errored: false, timedOut: false }),
    log: () => undefined, snapshotAt: '2026-07-14T04:00:00.000Z',
  });
  assert.deepStrictEqual(missingReplyResult, { ready: false, snapshotIds: ['n-missing'], preflightStarted: true });
  assert.ok(!missingReply.calls.some((call) => call.includes('/read')));

  const selfMention = fakeGateRequest({
    'GET /api/notifications': [{ status: 200, body: [unreadNotification('n-self', 'task-self', 'comment-self')] }],
    'GET /api/tasks/task-self': [{ status: 200, body: gateTask('task-self', MAIN_WORKSPACE_ID) }],
    'GET /api/tasks/task-self/comments': [
      { status: 200, body: [gateComment('task-self', 'comment-self')] },
      { status: 200, body: [gateComment('task-self', 'reply-self', gateActor.id, '@小美 請確認', '2026-07-14T04:01:00.000Z')] },
    ],
  });
  const selfMentionResult = await processNotificationGate({
    actor: gateActor, cookie: 'session=test', request: selfMention.request,
    runPreflight: async () => ({ errored: false, timedOut: false }),
    log: () => undefined, snapshotAt: '2026-07-14T04:00:00.000Z',
  });
  assert.deepStrictEqual(selfMentionResult, { ready: false, snapshotIds: ['n-self'], preflightStarted: true });
  assert.ok(!selfMention.calls.some((call) => call.includes('/read')));

  const unavailableLogs: string[] = [];
  const unavailable = fakeGateRequest({
    'GET /api/notifications': [
      { status: 200, body: [unreadNotification('n-gone', 'task-gone', 'comment-gone')] },
      { status: 200, body: [{ ...unreadNotification('n-gone', 'task-gone', 'comment-gone'), read_at: '2026-07-14T04:01:00.000Z' }] },
    ],
    'GET /api/tasks/task-gone': [{ status: 404, body: { error: 'task 不存在' } }],
    'POST /api/notifications/n-gone/read': [{ status: 200, body: { ok: true } }],
  });
  const unavailableResult = await processNotificationGate({
    actor: gateActor, cookie: 'session=test', request: unavailable.request,
    runPreflight: async () => { throw new Error('unavailable 不該啟動 preflight'); },
    log: (line) => unavailableLogs.push(line), snapshotAt: '2026-07-14T04:00:00.000Z',
  });
  assert.deepStrictEqual(unavailableResult, { ready: true, snapshotIds: ['n-gone'], preflightStarted: false });
  assert.ok(unavailableLogs.some((line) => line.includes('notification=n-gone') && line.includes('task=task-gone') && line.includes('status=404')));

  const failedSource = fakeGateRequest({
    'GET /api/notifications': [{ status: 200, body: [unreadNotification('n-500', 'task-500', 'comment-500')] }],
    'GET /api/tasks/task-500': [{ status: 500, body: { error: 'server error' } }],
  });
  const failedResult = await processNotificationGate({
    actor: gateActor, cookie: 'session=test', request: failedSource.request,
    runPreflight: async () => ({ errored: false, timedOut: false }),
    log: () => undefined, snapshotAt: '2026-07-14T04:00:00.000Z',
  });
  assert.deepStrictEqual(failedResult, { ready: false, snapshotIds: ['n-500'], preflightStarted: false });
  assert.ok(!failedSource.calls.some((call) => call.includes('/read')));

  const commentsGoneLogs: string[] = [];
  const commentsGone = fakeGateRequest({
    'GET /api/notifications': [
      { status: 200, body: [unreadNotification('n-comments-gone', 'task-comments-gone', 'comment-gone')] },
      { status: 200, body: [{ ...unreadNotification('n-comments-gone', 'task-comments-gone', 'comment-gone'), read_at: '2026-07-14T04:01:00.000Z' }] },
    ],
    'GET /api/tasks/task-comments-gone': [{ status: 200, body: gateTask('task-comments-gone', 'workspace-general') }],
    'GET /api/tasks/task-comments-gone/comments': [{ status: 403, body: { error: '禁止' } }],
    'POST /api/notifications/n-comments-gone/read': [{ status: 200, body: { ok: true } }],
  });
  const commentsGoneResult = await processNotificationGate({
    actor: gateActor, cookie: 'session=test', request: commentsGone.request,
    runPreflight: async () => { throw new Error('來源失效不該啟動 preflight'); },
    log: (line) => commentsGoneLogs.push(line), snapshotAt: '2026-07-14T04:00:00.000Z',
  });
  assert.deepStrictEqual(commentsGoneResult, { ready: true, snapshotIds: ['n-comments-gone'], preflightStarted: false });
  assert.ok(commentsGoneLogs.some((line) => line.includes('status=403')));

  const missingSourceComment = fakeGateRequest({
    'GET /api/notifications': [
      { status: 200, body: [unreadNotification('n-comment-missing', 'task-comment-missing', 'comment-missing')] },
      { status: 200, body: [{ ...unreadNotification('n-comment-missing', 'task-comment-missing', 'comment-missing'), read_at: '2026-07-14T04:01:00.000Z' }] },
    ],
    'GET /api/tasks/task-comment-missing': [{ status: 200, body: gateTask('task-comment-missing', 'workspace-general') }],
    'GET /api/tasks/task-comment-missing/comments': [{ status: 200, body: [gateComment('task-comment-missing', 'different-comment')] }],
    'POST /api/notifications/n-comment-missing/read': [{ status: 200, body: { ok: true } }],
  });
  const missingSourceCommentResult = await processNotificationGate({
    actor: gateActor, cookie: 'session=test', request: missingSourceComment.request,
    runPreflight: async () => { throw new Error('缺少留言不該啟動 preflight'); },
    log: () => undefined, snapshotAt: '2026-07-14T04:00:00.000Z',
  });
  assert.deepStrictEqual(missingSourceCommentResult, { ready: true, snapshotIds: ['n-comment-missing'], preflightStarted: false });

  const malformed = fakeGateRequest({
    'GET /api/notifications': [{ status: 200, body: { not: 'array' } }],
  });
  const malformedResult = await processNotificationGate({
    actor: gateActor, cookie: 'session=test', request: malformed.request,
    runPreflight: async () => ({ errored: false, timedOut: false }),
    log: () => undefined, snapshotAt: '2026-07-14T04:00:00.000Z',
  });
  assert.deepStrictEqual(malformedResult, { ready: false, snapshotIds: [], preflightStarted: false });

  const preflightFailed = fakeGateRequest({
    'GET /api/notifications': [{ status: 200, body: [unreadNotification('n-preflight-failed', 'task-preflight-failed', 'comment-preflight-failed')] }],
    'GET /api/tasks/task-preflight-failed': [{ status: 200, body: gateTask('task-preflight-failed', 'workspace-general') }],
    'GET /api/tasks/task-preflight-failed/comments': [{ status: 200, body: [gateComment('task-preflight-failed', 'comment-preflight-failed')] }],
  });
  const preflightFailedResult = await processNotificationGate({
    actor: gateActor, cookie: 'session=test', request: preflightFailed.request,
    runPreflight: async () => ({ errored: true, timedOut: false }),
    log: () => undefined, snapshotAt: '2026-07-14T04:00:00.000Z',
  });
  assert.deepStrictEqual(preflightFailedResult, { ready: false, snapshotIds: ['n-preflight-failed'], preflightStarted: true });
  assert.ok(!preflightFailed.calls.some((call) => call.includes('/read')));

  const multiple = fakeGateRequest({
    'GET /api/notifications': [
      { status: 200, body: [
        unreadNotification('n-one', 'task-one', 'comment-one'),
        unreadNotification('n-two', 'task-two', 'comment-two'),
        readNotification('n-old', 'task-old', 'comment-old'),
      ] },
      { status: 200, body: [
        { ...unreadNotification('n-one', 'task-one', 'comment-one'), read_at: '2026-07-14T04:02:00.000Z' },
        { ...unreadNotification('n-two', 'task-two', 'comment-two'), read_at: '2026-07-14T04:02:00.000Z' },
        unreadNotification('n-new', 'task-new', 'comment-new'),
      ] },
    ],
    'GET /api/tasks/task-one': [{ status: 200, body: gateTask('task-one', 'workspace-general') }],
    'GET /api/tasks/task-one/comments': [{ status: 200, body: [gateComment('task-one', 'comment-one')] }],
    'GET /api/tasks/task-two': [{ status: 200, body: gateTask('task-two', 'workspace-general') }],
    'GET /api/tasks/task-two/comments': [{ status: 200, body: [gateComment('task-two', 'comment-two')] }],
    'POST /api/notifications/n-one/read': [{ status: 200, body: { ok: true } }],
    'POST /api/notifications/n-two/read': [{ status: 200, body: { ok: true } }],
  });
  const multipleResult = await processNotificationGate({
    actor: gateActor, cookie: 'session=test', request: multiple.request,
    runPreflight: async () => ({ errored: false, timedOut: false }),
    log: () => undefined, snapshotAt: '2026-07-14T04:00:00.000Z',
  });
  assert.deepStrictEqual(multipleResult, { ready: true, snapshotIds: ['n-one', 'n-two'], preflightStarted: true });
  assert.strictEqual(multiple.calls.filter((call) => call.includes('/read')).length, 2);

  const independent = fakeGateRequest({
    'GET /api/notifications': [
      { status: 200, body: [
        unreadNotification('n-a', 'task-same', 'comment-a', '2026-07-14T03:59:00.000Z'),
        unreadNotification('n-b', 'task-same', 'comment-b', '2026-07-14T04:00:00.000Z'),
        unreadNotification('n-c', 'task-same', 'comment-c', '2026-07-14T04:01:00.000Z'),
      ] },
      { status: 200, body: [
        readNotification('n-a', 'task-same', 'comment-a'),
        unreadNotification('n-b', 'task-same', 'comment-b'),
        readNotification('n-c', 'task-same', 'comment-c'),
      ] },
    ],
    'GET /api/tasks/task-same': [
      { status: 200, body: gateTask('task-same', 'workspace-general') },
      { status: 200, body: gateTask('task-same', 'workspace-general') },
      { status: 200, body: gateTask('task-same', 'workspace-general') },
    ],
    'GET /api/tasks/task-same/comments': [
      { status: 200, body: [gateComment('task-same', 'comment-a')] },
      { status: 200, body: [gateComment('task-same', 'comment-b')] },
      { status: 200, body: [gateComment('task-same', 'comment-c')] },
    ],
    'POST /api/notifications/n-a/read': [{ status: 200, body: { ok: true } }],
    'POST /api/notifications/n-c/read': [{ status: 200, body: { ok: true } }],
  });
  const independentPrompts: string[] = [];
  let independentRuns = 0;
  const independentResult = await processNotificationGate({
    actor: gateActor, cookie: 'session=test', request: independent.request,
    runPreflight: async (prompt) => {
      independentRuns++;
      independentPrompts.push(prompt);
      return independentRuns === 2 ? { errored: true, timedOut: false } : { errored: false, timedOut: false };
    },
    log: () => undefined, snapshotAt: '2026-07-14T04:00:00.000Z',
  });
  assert.deepStrictEqual(independentResult, { ready: false, snapshotIds: ['n-a', 'n-b', 'n-c'], preflightStarted: true });
  assert.strictEqual(independentRuns, 3, '同 task 三筆通知必須各自呼叫 AI，第二筆失敗不可阻止第三筆');
  assert.strictEqual(independentPrompts.length, 3);
  assert.ok(independentPrompts[0].includes('n-a') && !independentPrompts[0].includes('n-b'));
  assert.ok(independentPrompts[1].includes('n-b') && !independentPrompts[1].includes('n-a'));
  assert.ok(independentPrompts[2].includes('n-c') && !independentPrompts[2].includes('n-a'));
  assert.deepStrictEqual(independent.calls.filter((call) => call.includes('/read')), [
    'POST /api/notifications/n-a/read', 'POST /api/notifications/n-c/read',
  ]);

  const sweepMember: NotificationSweepMember = {
    email: gateActor.email, name: gateActor.name, user: 'user02', runner: 'codex', model: 'test-model',
  };
  const sweepEmpty = fakeGateRequest({
    'GET /api/notifications': [{ status: 200, body: [] }],
  });
  let emptyPreflightRuns = 0;
  const sweepEmptyResult = await runNotificationSweepForMember({
    member: sweepMember,
    request: sweepEmpty.request,
    loginActor: async () => 'session=test',
    runPreflight: async () => { emptyPreflightRuns++; return { errored: false, timedOut: false }; },
    log: () => undefined,
    snapshotAt: '2026-07-14T04:00:00.000Z',
  });
  assert.deepStrictEqual(sweepEmptyResult, {
    actor: gateActor.email, ready: true, unreadCount: 0, preflightStarted: false,
  });
  assert.strictEqual(emptyPreflightRuns, 0, '零未讀不得啟動通知 AI session');

  const sweepGeneral = fakeGateRequest({
    'GET /api/notifications': [
      { status: 200, body: [unreadNotification('n-sweep-general', 'task-sweep-general', 'comment-sweep-general')] },
      { status: 200, body: [{ ...unreadNotification('n-sweep-general', 'task-sweep-general', 'comment-sweep-general'), read_at: '2026-07-14T04:01:00.000Z' }] },
    ],
    'GET /api/tasks/task-sweep-general': [{ status: 200, body: gateTask('task-sweep-general', 'workspace-general') }],
    'GET /api/tasks/task-sweep-general/comments': [{ status: 200, body: [gateComment('task-sweep-general', 'comment-sweep-general')] }],
    'POST /api/notifications/n-sweep-general/read': [{ status: 200, body: { ok: true } }],
  });
  let generalPreflightRuns = 0;
  const sweepGeneralResult = await runNotificationSweepForMember({
    member: sweepMember,
    request: sweepGeneral.request,
    loginActor: async () => 'session=test',
    runPreflight: async () => { generalPreflightRuns++; return { errored: false, timedOut: false }; },
    log: () => undefined,
    snapshotAt: '2026-07-14T04:00:00.000Z',
  });
  assert.deepStrictEqual(sweepGeneralResult, {
    actor: gateActor.email, ready: true, unreadCount: 1, preflightStarted: true,
  });
  assert.strictEqual(generalPreflightRuns, 1);

  const sweepMainMissingReply = fakeGateRequest({
    'GET /api/notifications': [{ status: 200, body: [unreadNotification('n-sweep-main', 'task-sweep-main', 'comment-sweep-main')] }],
    'GET /api/tasks/task-sweep-main': [{ status: 200, body: gateTask('task-sweep-main', MAIN_WORKSPACE_ID) }],
    'GET /api/tasks/task-sweep-main/comments': [
      { status: 200, body: [gateComment('task-sweep-main', 'comment-sweep-main')] },
      { status: 200, body: [gateComment('task-sweep-main', 'comment-sweep-main')] },
    ],
  });
  const sweepMainResult = await runNotificationSweepForMember({
    member: sweepMember,
    request: sweepMainMissingReply.request,
    loginActor: async () => 'session=test',
    runPreflight: async () => ({ errored: false, timedOut: false }),
    log: () => undefined,
    snapshotAt: '2026-07-14T04:00:00.000Z',
  });
  assert.strictEqual(sweepMainResult.ready, false);
  assert.ok(!sweepMainMissingReply.calls.some((call) => call.includes('/read')));

  const prompt = notificationGatePrompt({
    actor: gateActor,
    jar: '/tmp/notification.jar',
    source: {
      notification: unreadNotification('n-prompt', 'task-prompt', 'comment-prompt'),
      task: gateTask('task-prompt', MAIN_WORKSPACE_ID),
      sourceComment: gateComment('task-prompt', 'comment-prompt'),
      comments: [gateComment('task-prompt', 'comment-prompt')],
    },
  });
  assert.ok(prompt.includes('通知前置處理'));
  assert.ok(prompt.includes('已閱讀，目前無補充。'));
  assert.ok(prompt.includes('不得呼叫 POST /api/notifications'));
  assert.ok(prompt.includes('不得在留言中 @ 自己'));
  assert.ok(!prompt.includes('@小美'), 'prompt 指令不得組出 actor 自己的 handle');

  const longSource = 'S'.repeat(5000);
  const boundedPrompt = notificationGatePrompt({
    actor: gateActor,
    jar: '/tmp/notification.jar',
    source: {
      notification: unreadNotification('n-bounded', 'task-bounded', 'comment-bounded'),
      task: { ...gateTask('task-bounded', 'workspace-general'), description: 'D'.repeat(5000) },
      sourceComment: gateComment('task-bounded', 'comment-bounded', 'owner', longSource),
      comments: Array.from({ length: 20 }, (_, index) => gateComment('task-bounded', `context-${index}`, 'owner', `context-${index}-${'C'.repeat(3000)}`, `2026-07-14T04:${String(index).padStart(2, '0')}:00.000Z`)),
    },
  });
  assert.ok(Buffer.byteLength(boundedPrompt, 'utf8') <= 16_000, 'bounded prompt 不得超過 16,000 bytes');
  assert.ok(boundedPrompt.includes(longSource), 'source comment 必須完整保留');
  assert.ok(boundedPrompt.includes('已省略'), 'context 截減必須明確標記');

  const sweepMembers: NotificationSweepMember[] = ['user02', 'user03', 'user04', 'user05', 'user06'].map((user) => ({
    email: `${user}@test.local`, name: user, user, runner: 'codex', model: 'test-model',
  }));
  const seen: string[] = [];
  const sweepResults = await runNotificationSweep(
    sweepMembers,
    async (member) => {
      seen.push(member.email);
      if (member.user === 'user03') throw new Error('user03 notification failed');
      return { actor: member.email, ready: true, unreadCount: 0, preflightStarted: false };
    },
    () => undefined,
  );
  assert.deepStrictEqual(seen, sweepMembers.map((member) => member.email));
  assert.deepStrictEqual(sweepResults.map((result) => ({ actor: result.actor, ready: result.ready })), [
    { actor: 'user02@test.local', ready: true },
    { actor: 'user03@test.local', ready: false },
    { actor: 'user04@test.local', ready: true },
    { actor: 'user05@test.local', ready: true },
    { actor: 'user06@test.local', ready: true },
  ]);
}

const dir = mkdtempSync(join(tmpdir(), 'task-tracker-sim-'));
const dbPath = join(dir, 'dev.db');
const db = new DatabaseSync(dbPath);
runMigrations(db);
const insert = db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)');
insert.run('u2', 'user02@test.local', '小美', 'hash');
insert.run('u3', 'user03@test.local', '阿凱', 'hash');
insert.run('u4', 'user04@test.local', '婷婷', 'hash');
insert.run('u5', 'user05@test.local', '大熊', 'hash');
insert.run('u6', 'user06@test.local', '小芸', 'hash');
db.close();

const members = loadMembersFromUsers(dbPath);
assert.deepStrictEqual(
  members.map((member) => ({ email: member.email, name: member.name, user: member.user, runner: member.runner })),
  [
    { email: 'user02@test.local', name: '小美', user: 'user02', runner: 'codex' },
    { email: 'user03@test.local', name: '阿凱', user: 'user03', runner: 'codex' },
    { email: 'user04@test.local', name: '婷婷', user: 'user04', runner: 'codex' },
    { email: 'user05@test.local', name: '大熊', user: 'user05', runner: 'codex' },
    { email: 'user06@test.local', name: '小芸', user: 'user06', runner: 'agy' },
  ],
  'sim members 應從 users 表讀取 email/name，runner 設定仍由 sim 保留',
);
assert.ok(members.every((member) => member.profile.trim().length > 0), '每個 member 都應有 profile 供認領/難度組合參考');
assert.strictEqual(
  members.find((member) => member.email === 'user02@test.local')?.model,
  'gpt-5.4-mini',
  '小美必須使用可供 ChatGPT Codex 執行的 gpt-5.4-mini',
);

async function runRosterTests(): Promise<void> {
const rosterMembers: ManagedRosterMember[] = [
  { email: 'user02@test.local', userId: 'u2', role: 'Member' },
  { email: 'user03@test.local', userId: 'u3', role: 'Commenter' },
  { email: 'user04@test.local', userId: 'u4', role: 'Admin' },
  { email: 'user05@test.local', userId: 'u5', role: 'Owner' },
  { email: 'user06@test.local', userId: 'u6' },
];
assert.strictEqual(isManagedRosterWorkspace('canonical', false, ['canonical']), true);
assert.strictEqual(isManagedRosterWorkspace('bootstrap', true, []), true);
assert.strictEqual(isManagedRosterWorkspace(MAIN_WORKSPACE_ID, false, ['canonical']), false);
assert.strictEqual(isManagedRosterWorkspace('history', false, ['canonical']), false);

const rosterSync = fakeGateRequest({
  'GET /api/workspaces/canonical/members': [{ status: 200, body: [
    { user_id: 'u2', email: 'user02@test.local', role: 'Member' },
    { user_id: 'u3', email: 'user03@test.local', role: 'Commenter' },
    { user_id: 'u4', email: 'user04@test.local', role: 'Admin' },
    { user_id: 'u5', email: 'user05@test.local', role: 'Owner' },
  ] }, { status: 200, body: [
    { user_id: 'u2', email: 'user02@test.local', role: 'Member' },
    { user_id: 'u3', email: 'user03@test.local', role: 'Member' },
    { user_id: 'u4', email: 'user04@test.local', role: 'Admin' },
    { user_id: 'u5', email: 'user05@test.local', role: 'Owner' },
    { user_id: 'u6', email: 'user06@test.local', role: 'Member' },
  ] }],
  'PATCH /api/workspaces/canonical/members/u3': [{ status: 200, body: { ok: true } }],
  'POST /api/workspaces/canonical/members': [{ status: 201, body: { ok: true } }],
  'POST /api/workspaces/canonical/members/join': [{ status: 200, body: { ok: true } }],
});
const rosterSynced = await reconcileManagedRoster({
  workspaceId: 'canonical', ownerCookie: 'session=owner', members: rosterMembers,
  request: rosterSync.request, loginActor: async () => 'session=member',
  managedWorkspaceIds: ['canonical'], newlyCreated: false, log: () => undefined,
});
assert.deepStrictEqual(eligibleManagedRunners(rosterSynced).map((member) => member.email), [
  'user02@test.local', 'user03@test.local', 'user04@test.local', 'user05@test.local', 'user06@test.local',
]);
assert.deepStrictEqual(rosterSync.calls.filter((call) => call.includes('/members')), [
  'GET /api/workspaces/canonical/members',
  'PATCH /api/workspaces/canonical/members/u3',
  'POST /api/workspaces/canonical/members',
  'POST /api/workspaces/canonical/members/join',
  'GET /api/workspaces/canonical/members',
]);

const rosterIdempotent = fakeGateRequest({
  'GET /api/workspaces/canonical/members': [{ status: 200, body: [
    { user_id: 'u2', email: 'user02@test.local', role: 'Member' },
    { user_id: 'u3', email: 'user03@test.local', role: 'Member' },
    { user_id: 'u4', email: 'user04@test.local', role: 'Admin' },
    { user_id: 'u5', email: 'user05@test.local', role: 'Owner' },
    { user_id: 'u6', email: 'user06@test.local', role: 'Member' },
  ] }],
});
await reconcileManagedRoster({
  workspaceId: 'canonical', ownerCookie: 'session=owner', members: rosterMembers,
  request: rosterIdempotent.request, loginActor: async () => 'session=member',
  managedWorkspaceIds: ['canonical'], newlyCreated: false, log: () => undefined,
});
assert.deepStrictEqual(rosterIdempotent.calls, ['GET /api/workspaces/canonical/members']);

const rosterPartial = fakeGateRequest({
  'GET /api/workspaces/canonical/members': [{ status: 200, body: [
    { user_id: 'u2', email: 'user02@test.local', role: 'Member' },
  ] }, { status: 200, body: [
    { user_id: 'u2', email: 'user02@test.local', role: 'Member' },
  ] }],
  'POST /api/workspaces/canonical/members': [{ status: 500, body: { error: 'temporarily unavailable' } }],
});
const partialResult = await reconcileManagedRoster({
  workspaceId: 'canonical', ownerCookie: 'session=owner', members: [rosterMembers[0], rosterMembers[4]],
  request: rosterPartial.request, loginActor: async () => 'session=member',
  managedWorkspaceIds: ['canonical'], newlyCreated: false, log: () => undefined,
});
assert.deepStrictEqual(eligibleManagedRunners(partialResult).map((member) => member.email), ['user02@test.local']);
}

assert.deepStrictEqual(
  buildRunnerInvocation(
    { runner: 'agy', model: 'Gemini 3.5 Flash (High)' },
    '前端 task prompt',
    { cwd: '/tmp/user06', logFile: '/tmp/user06.log' },
  ),
  {
    command: 'agy',
    args: ['--print', '--model', 'Gemini 3.5 Flash (High)', '--mode', 'accept-edits', '前端 task prompt'],
  },
  'agy runner 應使用 headless print + accept-edits',
);
const user06 = members.find((member) => member.email === 'user06@test.local')!;
const user02 = members.find((member) => member.email === 'user02@test.local')!;
assert.deepStrictEqual(
  notificationRouteForMember(user06),
  { runner: 'codex', model: 'gpt-5.4-mini' },
  'user06 的 Codex notification override 應覆寫 AGY 執行設定',
);
assert.deepStrictEqual(
  notificationRouteForMember(user02),
  { runner: 'codex', model: 'gpt-5.4-mini' },
  'user02 應沿用 Codex 預設 notification route',
);
assert.deepStrictEqual(
  workSessionForMember(user06),
  { route: { runner: 'claude', model: 'claude-sonnet-5' }, fallback: undefined },
  'user06 一般工作必須改走 Claude Sonnet 5，且不得回退 AGY',
);
assert.deepStrictEqual(
  workSessionForMember(user02),
  { route: { runner: 'codex', model: 'gpt-5.4-mini' }, fallback: undefined },
  '未設 override 的 user02 必須維持既有一般工作路由',
);
const normalWorkSessions = source.match(
  /normal: \(\) => runSession\([\s\S]{0,160}?workSession\.route\.runner[\s\S]{0,160}?workSession\.route\.model[\s\S]{0,800}?fallback: workSession\.fallback/g,
) ?? [];
assert.strictEqual(
  normalWorkSessions.length,
  2,
  'full sprint 與 team sweep 的一般工作都必須使用 resolved runner/model/fallback',
);
assert.strictEqual(
  (source.match(/commitMemberWork\(m, (?:round|hour), workSession\.route\.model\)/g) ?? []).length,
  2,
  'full sprint 與 team sweep 的 driver commit 都必須記錄實際一般工作模型',
);
assert.strictEqual(isQuotaExhaustion('HTTP 429: quota exhausted'), true, 'quota 錯誤應可辨識');
assert.strictEqual(isQuotaExhaustion('agy binary not found'), false, 'agy 不存在不可誤判為 quota');
assert.strictEqual(isQuotaExhaustion('authentication failed'), false, '登入失敗不可誤判為 quota');
assert.strictEqual(
  shouldFallbackToModel({ timedOut: false, errored: true, quotaExhausted: true }, true),
  true,
  'primary quota 滿且有 fallback 才切換模型',
);
assert.strictEqual(
  shouldFallbackToModel({ timedOut: false, errored: true, quotaExhausted: false }, true),
  false,
  'agy 一般錯誤不可 fallback',
);
assert.strictEqual(
  shouldFallbackToModel({ timedOut: true, errored: true, quotaExhausted: true }, true),
  false,
  'timeout 不可 fallback',
);

const runRoot = mkdtempSync(join(tmpdir(), 'task-tracker-sim-run-'));
const runDir = createRunDir(runRoot, 'sim-run-test');
const artifact = writePromptArtifact(runDir, 'owner-open', 'hello');
assert.ok(artifact.path.endsWith('001-owner-open.md'));
assert.strictEqual(artifact.bytes, 5);
assert.strictEqual(readFileSync(artifact.path, 'utf8'), 'hello');

const packetMarkdown = formatReviewPacket({
  branch: 'sim/user02',
  memberName: '小美',
  memberEmail: 'user02@test.local',
  ahead: 2,
  dirty: true,
  commits: ['abc123 feat: example'],
  changedFiles: ['src/auth.ts'],
  diffstat: ' src/auth.ts | 2 ++',
  tsc: { status: 'pass', outputPath: '/tmp/tsc.txt' },
  test: { status: 'skip', outputPath: '/tmp/test.txt' },
  packetPath: '/tmp/packet.md',
});
assert.ok(packetMarkdown.includes('sim/user02'));
assert.ok(packetMarkdown.includes('tsc: PASS'));
assert.ok(packetMarkdown.includes('test: SKIP'));
assert.ok(packetMarkdown.includes('dirty: yes'));
assert.ok(packetMarkdown.includes('src/auth.ts'));

assert.strictEqual(allChecksPass(
  { status: 'pass', outputPath: '/tmp/tsc.txt' },
  { status: 'pass', outputPath: '/tmp/test.txt' },
), true);
assert.strictEqual(allChecksPass(
  { status: 'pass', outputPath: '/tmp/tsc.txt' },
  { status: 'skip', outputPath: '/tmp/test.txt' },
), false);
assert.strictEqual(allChecksPass(
  { status: 'fail', outputPath: '/tmp/tsc.txt' },
  { status: 'pass', outputPath: '/tmp/test.txt' },
), false);

let commitCalls = 0;
const commit = () => { commitCalls++; return true; };
assert.strictEqual(commitIfSessionSucceeded({ timedOut: false, errored: false }, commit), true);
assert.strictEqual(commitIfSessionSucceeded({ timedOut: false, errored: true }, commit), false);
assert.strictEqual(commitIfSessionSucceeded({ timedOut: true, errored: true }, commit), false);
assert.strictEqual(commitCalls, 1, '失敗或逾時 session 不得觸發 driver commit');

const noToolingRoot = mkdtempSync(join(tmpdir(), 'task-tracker-sim-no-tooling-'));
const noToolingTsc = join(noToolingRoot, 'tsc.txt');
const noToolingTest = join(noToolingRoot, 'test.txt');
const noToolingChecks = brainChecks(noToolingRoot, ['notes/readme.md'], noToolingTsc, noToolingTest);
assert.strictEqual(noToolingChecks.tsc.status, 'skip');
assert.strictEqual(noToolingChecks.test.status, 'skip');
assert.match(readFileSync(noToolingTsc, 'utf8'), /人工審/);

const multiProjectRoot = mkdtempSync(join(tmpdir(), 'task-tracker-sim-multi-project-'));
for (const project of ['alpha', 'beta']) {
  mkdirSync(join(multiProjectRoot, project));
  writeFileSync(join(multiProjectRoot, project, 'tsconfig.json'), '{}');
}
const multiProjectTsc = join(multiProjectRoot, 'tsc.txt');
const multiProjectChecks = brainChecks(
  multiProjectRoot,
  ['alpha/src.ts', 'beta/src.ts'],
  multiProjectTsc,
  join(multiProjectRoot, 'test.txt'),
);
assert.strictEqual(multiProjectChecks.tsc.status, 'skip');
assert.match(readFileSync(multiProjectTsc, 'utf8'), /alpha、beta/);

const installFailRoot = mkdtempSync(join(tmpdir(), 'task-tracker-sim-install-fail-'));
mkdirSync(join(installFailRoot, 'project'));
writeFileSync(join(installFailRoot, 'project/package.json'), JSON.stringify({ scripts: { test: 'node test.js' } }));
let checkCalls = 0;
const installFailChecks = brainChecks(
  installFailRoot,
  ['project/src.ts'],
  join(installFailRoot, 'tsc.txt'),
  join(installFailRoot, 'test.txt'),
  (_cwd, command, args, outputPath) => {
    checkCalls++;
    assert.strictEqual(command, 'npm');
    assert.strictEqual(args[0], 'install');
    return { status: 'fail', outputPath };
  },
);
assert.strictEqual(installFailChecks.test.status, 'fail');
assert.strictEqual(checkCalls, 1, '依賴安裝失敗後不可繼續執行 test command');

const dirtyRoot = mkdtempSync(join(tmpdir(), 'task-tracker-sim-dirty-'));
const dirtyTsc = join(dirtyRoot, 'tsc.txt');
const dirtyTest = join(dirtyRoot, 'test.txt');
const dirtyChecks = dirtyReviewChecks(dirtyTsc, dirtyTest);
assert.strictEqual(hasReviewChanges(0, true), true);
assert.strictEqual(hasReviewChanges(0, false), false);
assert.strictEqual(allChecksPass(dirtyChecks.tsc, dirtyChecks.test), false);
assert.strictEqual(dirtyChecks.tsc.status, 'fail');
assert.match(readFileSync(dirtyTsc, 'utf8'), /不可視為工作佚失/);

const reportMarkdown = formatReportMarkdown({
  runId: 'sim-run-test',
  scenarioKey: 'technical-debt',
  workspaceId: 'ws1',
  tag: 'sim-run-test',
  startedAt: '2026-07-07T00:00:00.000Z',
  finishedAt: '2026-07-07T00:01:00.000Z',
  members: [{ email: 'user02@test.local', name: '小美', branch: 'sim/user02' }],
  tasks: [{ taskId: 't1', title: 'Example', status: 'Done', priority: 'High' }],
  branches: [{
    branch: 'sim/user02',
    memberName: '小美',
    memberEmail: 'user02@test.local',
    ahead: 1,
    dirty: false,
    commits: ['abc123 feat: example'],
    changedFiles: ['src/auth.ts'],
    diffstat: ' src/auth.ts | 2 ++',
    tsc: { status: 'pass', outputPath: '/tmp/tsc.txt' },
    test: { status: 'skip', outputPath: '/tmp/test.txt' },
    packetPath: '/tmp/packet.md',
  }],
  promptArtifacts: [{ label: 'owner-open', path: '/tmp/p.md', bytes: 10 }],
  bugTasks: 0,
  escalateComments: 0,
  totalPromptBytes: 10,
  commentCount: 1,
  eventCount: 2,
  unmergedGreen: ['sim/user03'],
});
assert.ok(reportMarkdown.includes('sim-run-test'));
assert.ok(reportMarkdown.includes('Example'));
assert.ok(reportMarkdown.includes('total prompt bytes: 10'));
assert.ok(reportMarkdown.includes('sim/user03'));
assert.ok(reportMarkdown.includes('test SKIP'));

assert.strictEqual(parseScenario(['node', 'run.ts']).key, 'self-directed');
assert.strictEqual(parseScenario(['node', 'run.ts', '--scenario', 'product-ideation']).key, 'product-ideation');
assert.throws(() => parseScenario(['node', 'run.ts', '--scenario', 'missing']), /Unknown scenario/);
assert.strictEqual(scenarioFromStoredKey('technical-debt')?.key, 'self-directed');
assert.strictEqual(scenarioFromStoredKey('brain')?.key, 'brain');
assert.strictEqual(scenarioFromStoredKey('missing'), undefined);

const EXPECTED_ROOT_WORKSPACE_ID = 'd9da9945-ce5f-400f-806e-1d75e95e313a';
assert.strictEqual(canonicalWorkspaceForRepoRoot(ROOT), EXPECTED_ROOT_WORKSPACE_ID);
assert.strictEqual(canonicalWorkspaceForRepoRoot(BRAIN_ROOT), undefined);

const canonicalCandidates = new Map<string, { key: string; startedAt: string }>();
ensureCanonicalWorkspaceCandidates(canonicalCandidates);
assert.ok(canonicalCandidates.has(EXPECTED_ROOT_WORKSPACE_ID));

const mainCandidates = new Map<string, { key: string; startedAt: string }>();
ensureMainWorkspaceCandidate(mainCandidates);
assert.deepStrictEqual(mainCandidates.get(MAIN_WORKSPACE_ID), {
  key: 'self-directed',
  startedAt: '1970-01-01T00:00:00.000Z',
});
mainCandidates.set(MAIN_WORKSPACE_ID, { key: 'brain', startedAt: '2026-07-11T00:00:00.000Z' });
ensureMainWorkspaceCandidate(mainCandidates);
assert.deepStrictEqual(mainCandidates.get(MAIN_WORKSPACE_ID), {
  key: 'brain',
  startedAt: '2026-07-11T00:00:00.000Z',
}, 'main candidate 重複加入不得覆寫 report 資訊');

const combinedCandidates = new Map<string, { key: string; startedAt: string }>();
ensureMainWorkspaceCandidate(combinedCandidates);
ensureCanonicalWorkspaceCandidates(combinedCandidates);
const combinedSnapshot = [...combinedCandidates];
ensureMainWorkspaceCandidate(combinedCandidates);
ensureCanonicalWorkspaceCandidates(combinedCandidates);
assert.deepStrictEqual([...combinedCandidates], combinedSnapshot, '重複確保 main/canonical 不得新增或覆寫');
assert.ok(combinedCandidates.has(MAIN_WORKSPACE_ID));
assert.ok(combinedCandidates.has(EXPECTED_ROOT_WORKSPACE_ID));

assert.strictEqual(isSweepWorkTask({ title: MAIN_POLICY_TITLE }), false);
assert.strictEqual(isSweepWorkTask({ title: '[討論] 方向' }), false);
assert.strictEqual(isSweepWorkTask({ title: '實作功能' }), true);

assert.strictEqual(mainDiscussionNeedsOwner('Todo'), true);
assert.strictEqual(mainDiscussionNeedsOwner('Done'), false);
assert.strictEqual(mainDiscussionNeedsOwner('Doing'), false);
assert.strictEqual(mainDiscussionNeedsOwner('Review'), false);

const directory = canonicalWorkspaceDirectory();
assert.match(directory, new RegExp(ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.match(directory, new RegExp(EXPECTED_ROOT_WORKSPACE_ID));

const ordered = [
  { wsId: 'ordinary-new', startedAt: '2026-07-11T00:00:00.000Z' },
  { wsId: 'timed-out', startedAt: '1970-01-01T00:00:00.000Z' },
  { wsId: EXPECTED_ROOT_WORKSPACE_ID, startedAt: '1970-01-01T00:00:00.000Z' },
  { wsId: MAIN_WORKSPACE_ID, startedAt: '1970-01-01T00:00:00.000Z' },
].sort((a, b) => compareSweepCandidates(a, b, ['timed-out']));
assert.deepStrictEqual(ordered.map((item) => item.wsId), [
  'timed-out',
  MAIN_WORKSPACE_ID,
  EXPECTED_ROOT_WORKSPACE_ID,
  'ordinary-new',
]);

assert.strictEqual(sweepCandidateUsesRepoSlot(MAIN_WORKSPACE_ID), false);
assert.strictEqual(sweepCandidateUsesRepoSlot(EXPECTED_ROOT_WORKSPACE_ID), true);
assert.strictEqual(sweepCandidateUsesRepoSlot('ordinary'), true);

assert.deepStrictEqual(sweepBudgets('owner', 0, true), { owner: 2, member: 0 });
assert.deepStrictEqual(sweepBudgets('owner', 0, false), { owner: 0, member: 0 });
assert.deepStrictEqual(sweepBudgets('team', 0, false), { owner: 0, member: 3 });
assert.deepStrictEqual(sweepBudgets('both', 0, false), { owner: 0, member: 3 });
assert.strictEqual(workspaceFitsSweepBudget(0, 2, [], ['codex-id']), false);
assert.strictEqual(workspaceFitsSweepBudget(0, 2, [{ status: 'Review', assignee_id: 'codex-id' }], ['codex-id']), false);
assert.strictEqual(workspaceFitsSweepBudget(0, 2, [{ status: 'Doing', assignee_id: 'claude-id' }], ['codex-id']), false);
assert.strictEqual(workspaceFitsSweepBudget(0, 2, [{ status: 'Doing', assignee_id: 'codex-id' }], ['codex-id']), true);
assert.strictEqual(workspaceFitsSweepBudget(0, 2, [{ status: 'Todo', assignee_id: null }], []), false);
assert.strictEqual(workspaceFitsSweepBudget(0, 2, [{ status: 'Todo', assignee_id: null }], ['codex-id']), false);

const selectorMembers = [
  { email: 'a@test.local', userId: 'u-a' },
  { email: 'b@test.local', userId: 'u-b' },
  { email: 'c@test.local', userId: 'u-c' },
  { email: 'd@test.local', userId: 'u-d' },
];
const selectorTasks = [
  { status: 'Todo', assignee_id: 'u-a', updated_at: '2026-07-14T01:00:00.000Z' },
  { status: 'Doing', assignee_id: 'u-b', updated_at: '2026-07-14T04:00:00.000Z' },
  { status: 'Doing', assignee_id: 'u-c', updated_at: '2026-07-14T03:00:00.000Z' },
  { status: 'Todo', assignee_id: 'u-d', updated_at: '2026-07-14T00:00:00.000Z' },
  { status: 'Todo', assignee_id: 'invalid', updated_at: '2026-07-14T00:00:00.000Z' },
];
assert.deepStrictEqual(
  selectAssignedMembers(selectorTasks, selectorMembers, 3).map((member) => member.userId),
  ['u-c', 'u-b', 'u-d'],
  'Doing 優先，再依最舊 active task，不能依固定 roster 順序飢餓',
);
assert.deepStrictEqual(
  selectAssignedMembers(selectorTasks, selectorMembers, 3, ['u-c']).map((member) => member.userId),
  ['u-b', 'u-d', 'u-a'],
  'notification blocked member 不占 budget，其他 assigned member 遞補',
);
assert.deepStrictEqual(
  selectAssignedMembers([{ status: 'Todo', assignee_id: null, updated_at: '2026-07-14T00:00:00.000Z' }], selectorMembers, 3),
  [],
  '無 assignee Todo 不啟動任何 member',
);

assert.doesNotThrow(() => assertPathWithin('/tmp/sim-root', '/tmp/sim-root/sim-work/user02', 'worktree'));
assert.throws(() => assertPathWithin('/tmp/sim-root', '/tmp/other/user02', 'worktree'), /worktree/);
const symlinkRoot = mkdtempSync(join(tmpdir(), 'task-tracker-sim-path-root-'));
const symlinkOutside = mkdtempSync(join(tmpdir(), 'task-tracker-sim-path-outside-'));
symlinkSync(symlinkOutside, join(symlinkRoot, 'sim-work'));
assert.throws(() => assertPathWithin(symlinkRoot, join(symlinkRoot, 'sim-work/user02'), 'worktree'), /worktree/);

assert.doesNotThrow(() => validateGitRootFacts('/tmp/repo', '/tmp/repo', 'master'));
assert.throws(() => validateGitRootFacts('/tmp/repo/nested', '/tmp/repo', 'master'), /Git top-level/);
assert.throws(() => validateGitRootFacts('/tmp/repo', '/tmp/repo', 'feature/test'), /必須位於 master/);

const lockPath = join(dir, '.run.lock');
const release = acquireRunLock(lockPath);
assert.ok(existsSync(lockPath));
assert.throws(() => acquireRunLock(lockPath), /執行中/);
release();
assert.ok(!existsSync(lockPath));
const releaseAgain = acquireRunLock(lockPath);
releaseAgain();
writeFileSync(lockPath, '999999999\n');
const releaseAfterStale = acquireRunLock(lockPath);
releaseAfterStale();
assert.ok(!existsSync(lockPath));

async function runAsyncPolicyTests(): Promise<void> {
  await runRosterTests();
  await runNotificationGateTests();
  let calls = 0;
  const success = await runMemberSession(
    async () => ({ timedOut: false, errored: false }),
    () => { calls++; return true; },
  );
  assert.strictEqual(success.committed, true);
  const error = await runMemberSession(
    async () => ({ timedOut: false, errored: true }),
    () => { calls++; return true; },
  );
  assert.strictEqual(error.committed, false);
  const timeoutOnly = await runMemberSession(
    async () => ({ timedOut: true, errored: false }),
    () => { calls++; return true; },
  );
  assert.strictEqual(timeoutOnly.committed, false);
  assert.strictEqual(calls, 1);

  const finallyLockPath = join(dir, '.finally.lock');
  await assert.rejects(
    withRunLock(finallyLockPath, async () => { throw new Error('action failed'); }),
    /action failed/,
  );
  assert.ok(!existsSync(finallyLockPath), 'action 失敗時也必須釋放 sim lock');
  await withRunLock(finallyLockPath, async () => {
    await assert.rejects(withRunLock(finallyLockPath, async () => undefined), /執行中/);
  });
  assert.ok(!existsSync(finallyLockPath));

  let delayedFinished = false;
  await assert.rejects(
    withRunLock(finallyLockPath, () => settleAllOrThrow([
      Promise.reject(new Error('commit failed')),
      new Promise<void>((resolve) => setTimeout(() => { delayedFinished = true; resolve(); }, 10)),
    ])),
    /平行 member 工作失敗/,
  );
  assert.strictEqual(delayedFinished, true, '其中一個 member 失敗仍須等待其他 session 結束後才解鎖');
  assert.ok(!existsSync(finallyLockPath));
}

runAsyncPolicyTests()
  .then(() => console.log('sim/run.test.ts OK'))
  .catch((error) => { console.error(error); process.exitCode = 1; });
