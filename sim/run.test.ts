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
  formatReportMarkdown,
  formatReviewPacket,
  hasReviewChanges,
  isSweepWorkTask,
  loadMembersFromUsers,
  MAIN_HANDOFF_PENDING,
  mainDiscussionNeedsOwner,
  MAIN_OWNER_TOOLS,
  MEMBER_TOOLS,
  parseScenario,
  ROOT,
  runMemberSession,
  scenarioFromStoredKey,
  settleAllOrThrow,
  shouldFallbackToModel,
  sweepCandidateUsesRepoSlot,
  sweepBudgets,
  validateGitRootFacts,
  withRunLock,
  workspaceFitsSweepBudget,
  writePromptArtifact,
  isQuotaExhaustion,
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
assert.ok(source.includes('${BASE}/#/task/<id>'), '主工作區 prompt 必須回寫完整 task URL');
assert.ok(source.includes('Todo→Doing→Review→Done'), '主工作區 prompt 必須要求合法相鄰狀態轉移');
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
assert.ok(source.includes('${MAIN_HANDOFF_PENDING} target repo:'), 'main prompt 必須先留下 durable handoff marker');

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

assert.strictEqual(mainDiscussionNeedsOwner('Todo', 'u01', 'u01'), true);
assert.strictEqual(mainDiscussionNeedsOwner('Doing', undefined, 'u01'), true);
assert.strictEqual(mainDiscussionNeedsOwner('Doing', 'u02', 'u01'), true);
assert.strictEqual(mainDiscussionNeedsOwner('Doing', 'u01', 'u01', '一般討論回覆'), false);
assert.strictEqual(
  mainDiscussionNeedsOwner('Doing', 'u01', 'u01', `${MAIN_HANDOFF_PENDING} target repo: /home/hom/code/example`),
  true,
);
assert.strictEqual(
  mainDiscussionNeedsOwner('Doing', 'u01', 'u01', '已建立 http://localhost:3000/#/task/implementation-id'),
  true,
);
assert.strictEqual(mainDiscussionNeedsOwner('Review', 'u01', 'u01'), true);

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
assert.deepStrictEqual(sweepBudgets('team', 0, false), { owner: 0, member: 2 });
assert.deepStrictEqual(sweepBudgets('both', 0, false), { owner: 0, member: 2 });
assert.strictEqual(workspaceFitsSweepBudget(0, 2, [], ['codex-id']), false);
assert.strictEqual(workspaceFitsSweepBudget(0, 2, [{ status: 'Review', assignee_id: 'codex-id' }], ['codex-id']), false);
assert.strictEqual(workspaceFitsSweepBudget(0, 2, [{ status: 'Doing', assignee_id: 'claude-id' }], ['codex-id']), false);
assert.strictEqual(workspaceFitsSweepBudget(0, 2, [{ status: 'Doing', assignee_id: 'codex-id' }], ['codex-id']), true);
assert.strictEqual(workspaceFitsSweepBudget(0, 2, [{ status: 'Todo', assignee_id: null }], []), false);
assert.strictEqual(workspaceFitsSweepBudget(0, 2, [{ status: 'Todo', assignee_id: null }], ['codex-id']), true);

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
