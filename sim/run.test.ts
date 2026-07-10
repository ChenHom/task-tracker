import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/schema';
import {
  acquireRunLock,
  allChecksPass,
  assertPathWithin,
  BRAIN_ROOT,
  brainChecks,
  canonicalWorkspaceForRepoRoot,
  commitIfSessionSucceeded,
  createRunDir,
  dirtyReviewChecks,
  ensureCanonicalWorkspaceCandidates,
  formatReportMarkdown,
  formatReviewPacket,
  hasReviewChanges,
  loadMembersFromUsers,
  MEMBER_TOOLS,
  parseScenario,
  ROOT,
  runMemberSession,
  scenarioFromStoredKey,
  settleAllOrThrow,
  sweepBudgets,
  validateGitRootFacts,
  withRunLock,
  workspaceFitsSweepBudget,
  writePromptArtifact,
} from './run';

const source = readFileSync(join(__dirname, 'run.ts'), 'utf8');
assert.ok(!source.includes('const MEMBERS: Member[] = ['), 'MEMBERS 不應在 sim/run.ts 寫死 email/name');
assert.ok(!source.includes('let REPO_ROOT'), 'scenario 狀態不應拆成多個可不同步的 global');
assert.ok(!source.includes('let WORK_DIR'), 'scenario 狀態不應拆成多個可不同步的 global');
assert.ok(!source.includes('let MEMBERS'), 'scenario 狀態不應拆成多個可不同步的 global');
assert.ok(!MEMBER_TOOLS.includes('Bash(git:*)'), 'member tool policy 不應直接允許任意 Git 指令');
assert.ok(source.includes('CI 有 SKIP'), 'owner prompt 必須保留 SKIP 人工審查規則');
assert.ok(source.includes('[CROSS-REPO]'), '跨 repo 轉移需要獨立標記，不能沿用死路的 [ESCALATE]');

const dir = mkdtempSync(join(tmpdir(), 'task-tracker-sim-'));
const dbPath = join(dir, 'dev.db');
const db = new DatabaseSync(dbPath);
runMigrations(db);
const insert = db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)');
insert.run('u2', 'user02@test.local', '小美', 'hash');
insert.run('u3', 'user03@test.local', '阿凱', 'hash');
insert.run('u4', 'user04@test.local', '婷婷', 'hash');
insert.run('u5', 'user05@test.local', '大熊', 'hash');
db.close();

const members = loadMembersFromUsers(dbPath);
assert.deepStrictEqual(
  members.map((member) => ({ email: member.email, name: member.name, user: member.user, runner: member.runner })),
  [
    { email: 'user02@test.local', name: '小美', user: 'user02', runner: 'claude' },
    { email: 'user03@test.local', name: '阿凱', user: 'user03', runner: 'codex' },
    { email: 'user04@test.local', name: '婷婷', user: 'user04', runner: 'codex' },
    { email: 'user05@test.local', name: '大熊', user: 'user05', runner: 'codex' },
  ],
  'sim members 應從 users 表讀取 email/name，runner 設定仍由 sim 保留',
);
assert.ok(members.every((member) => member.profile.trim().length > 0), '每個 member 都應有 profile 供認領/難度組合參考');

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
