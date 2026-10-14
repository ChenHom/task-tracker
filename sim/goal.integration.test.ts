import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function count(db: { prepare(sql: string): { get(...args: unknown[]): unknown } }, sql: string, ...args: unknown[]): number {
  return (db.prepare(sql).get(...args) as { n: number }).n;
}

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('test server failed to bind'));
      resolve(address.port);
    });
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'goal-e2e-'));
  const repo = join(root, 'repo');
  const dataDir = join(root, 'data');
  const coordinatorDb = join(root, 'coordinator.db');
  const registryPath = join(root, 'repos.json');
  const coordinatorToken = 'goal-integration-token';
  let server: Server | undefined;

  mkdirSync(repo);
  mkdirSync(dataDir);
  process.env.TASK_TRACKER_DATA_DIR = dataDir;
  process.env.TASK_TRACKER_REPO_REGISTRY_PATH = registryPath;
  process.env.TASK_TRACKER_COORDINATOR_TOKEN = coordinatorToken;

  try {
    git(repo, 'init', '-b', 'master');
    git(repo, 'config', 'user.name', 'Goal Test');
    git(repo, 'config', 'user.email', 'goal@test.local');
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-m', 'base');
    const baseSha = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(registryPath, JSON.stringify({
      [repo]: { checks: ['npm test'], deployment: 'not_required' },
    }));

    const [{ db }, { resetProjections }, { seedUsers }, { getUserIdByEmail }, goalModule, taskModule, workspaceModule, memberModule, notificationModule, coordinatorModule, productionModule, serverModule] = await Promise.all([
      import('../src/db'),
      import('../src/eventStore'),
      import('../src/seed'),
      import('../src/auth'),
      import('../src/goal'),
      import('../src/task'),
      import('../src/workspace'),
      import('../src/member'),
      import('../src/notification'),
      import('./goalCoordinator'),
      import('./production'),
      import('../src/server'),
    ]);

    resetProjections();
    workspaceModule.registerWorkspaceProjections();
    memberModule.registerMemberProjections();
    taskModule.registerTaskProjections();
    notificationModule.registerNotificationProjections();
    goalModule.registerGoalProjections();
    seedUsers(db);

    const owner = getUserIdByEmail('user01@test.local', db)!;
    const member = getUserIdByEmail('user02@test.local', db)!;
    const reviewer = getUserIdByEmail('user03@test.local', db)!;
    const human = getUserIdByEmail('user09@test.local', db)!;
    const mainWorkspaceId = '11a82028-fc50-466a-a723-e002032cd9a6';
    const canonicalWorkspaceId = 'd9da9945-ce5f-400f-806e-1d75e95e313a';
    for (const [workspaceId, name] of [['ws', 'W'], [mainWorkspaceId, 'Main'], [canonicalWorkspaceId, 'Canonical']]) {
      db.prepare('INSERT INTO workspaces_read_model (workspace_id,name,status,created_at) VALUES (?, ?, ?, ?)')
        .run(workspaceId, name, 'active', '2026-10-12T00:00:00.000Z');
    }
    for (const [workspaceId, userId, role] of [
      ['ws', owner, 'Owner'], ['ws', member, 'Member'], ['ws', reviewer, 'Member'], ['ws', human, 'Member'],
      [mainWorkspaceId, owner, 'Owner'], [canonicalWorkspaceId, owner, 'Owner'], [canonicalWorkspaceId, human, 'Owner'],
    ]) {
      db.prepare('INSERT INTO workspace_members_read_model (workspace_id,user_id,role,joined_at) VALUES (?, ?, ?, ?)')
        .run(workspaceId, userId, role, '2026-10-12T00:00:00.000Z');
    }
    db.prepare("INSERT INTO projects_read_model (project_id,workspace_id,name,status,target_repo,created_at,updated_at) VALUES ('p','ws','P','active',?,'t','t')")
      .run(repo);

    const repos = new Map([[repo, { targetRepo: repo, checks: ['npm test'], deployment: 'not_required' as const }]]);
    const goalId = goalModule.createGoal('human', {
      workspaceId: 'ws', projectId: 'p', objective: 'ship', successCriteria: 'merged and verified', ownerAgentId: owner,
    }, db, repos);
    const synthesis = {
      summary: 'one task', decisionRationale: '採納可驗證的最小修改', changeScope: 'result.txt', uncertainties: [],
      taskPlans: [{
        title: 'Implement goal', description: 'change file', assigneeId: member, dependsOn: [], deploymentNotRequired: true,
        acceptanceCriteria: 'git check passes', rollbackCondition: 'revert merge',
      }],
      evidenceRefs: ['README.md'],
    };
    const phaseCalls = new Map<string, number>();
    const newGoalDeps = () => ({
      database: db,
      repoRegistry: repos,
      quotaSnapshot: async () => '{"remaining":100}',
      invokeJson: async ({ phase }: { phase: string }) => {
        phaseCalls.set(phase, (phaseCalls.get(phase) ?? 0) + 1);
        if (phase === 'owner_scoping') return { selections: [
          { agentId: member, reason: 'implementation', assignment: 'review implementation', selectedLoad: 0 },
          { agentId: reviewer, reason: 'verification', assignment: 'review verification', selectedLoad: 0 },
        ] };
        if (phase === 'round_1') return { stance: 'analysis', claim: 'concrete claim', reason: 'evidence-backed reason', evidenceRefs: ['README.md'] };
        if (phase === 'round_2') return { stance: 'agree', claim: 'cross review', reason: 'peer evidence agrees', evidenceRefs: ['README.md'] };
        if (phase === 'owner_synthesis') return synthesis;
        if (phase === 'verifying') return { passed: true, evidenceRefs: ['success-criteria:verified'] };
        if (phase === 'followup') return { action: 'create', objective: 'measure', successCriteria: 'new evidence measured', reason: 'post completion', evidenceRefs: ['merge:new'] };
        throw new Error(`unexpected phase ${phase}`);
      },
    });

    // 每次建立新的 deps，模擬程序在 durable checkpoint 後退出再啟動。
    assert.strictEqual(await coordinatorModule.runGoalCoordinatorOnce(goalId, newGoalDeps()), 'round_1');
    assert.strictEqual(await coordinatorModule.runGoalCoordinatorOnce(goalId, newGoalDeps()), 'round_2');
    assert.strictEqual(await coordinatorModule.runGoalCoordinatorOnce(goalId, newGoalDeps()), 'awaiting_lease');
    assert.strictEqual(await coordinatorModule.runGoalCoordinatorOnce(goalId, newGoalDeps()), 'Executing');
    const task = db.prepare('SELECT task_id FROM tasks_read_model WHERE goal_id = ?').get(goalId) as { task_id: string };
    assert.ok(task);
    assert.strictEqual(count(db, 'SELECT COUNT(*) AS n FROM goal_contributions WHERE goal_id = ?', goalId), 4);
    assert.strictEqual(count(db, 'SELECT COUNT(*) AS n FROM tasks_read_model WHERE goal_id = ?', goalId), 1);

    server = serverModule.createAppServer();
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    let memberCalls = 0;
    let ownerCalls = 0;
    let ciCalls = 0;
    let completionBatchCalls = 0;
    const runProduction = () => productionModule.runOnce({
      live: true,
      baseUrl,
      dbPath: coordinatorDb,
      repoRoot: repo,
      coordinatorToken,
      allowedPrefixes: ['result.txt'],
      isServiceActive: async () => {
        // runOnce 清掉自己的 inherited credential；同 process 的 HTTP fixture 需恢復 server credential。
        process.env.TASK_TRACKER_COORDINATOR_TOKEN = coordinatorToken;
        return true;
      },
      runMemberSession: async (context) => {
        memberCalls++;
        writeFileSync(join(context.worktreePath, 'result.txt'), 'delivered\n');
        return { exitCode: 0, output: { summary: 'implemented', changedPaths: ['result.txt'], verificationCommands: ['npm test'], blocker: null } };
      },
      runOwnerSession: async (context) => {
        ownerCalls++;
        if (ownerCalls === 1) throw new Error('simulated crash after commit checkpoint');
        return { exitCode: 0, decision: { action: 'accept' as const, rationale: `accepted ${context.reviewedHeadSha}`, evidenceCommentIds: [] } };
      },
      runVerificationCommand: async () => ({ exitCode: 0, output: 'fixture verification passed' }),
      runIntegrationCommand: async () => ({ exitCode: 0, output: 'fixture integration passed' }),
      runBranchCi: async () => {
        if (++ciCalls === 1) throw new Error('simulated crash at CI checkpoint');
        return { passed: true, detail: 'fixture CI passed' };
      },
      runTaskSpecificAcceptance: async () => ({ passed: true, detail: 'fixture acceptance passed' }),
      sendDiscordMessage: async () => true,
      newId: () => {
        if (++completionBatchCalls === 1) throw new Error('simulated crash after completion checkpoint');
        return 'goal-e2e-completion-batch';
      },
      traceSink: () => {},
    });

    assert.strictEqual((await runProduction()).exitCode, 1, 'commit 後 crash 應保留 Review checkpoint');
    const committedHead = git(repo, 'rev-parse', `sim/task/${task.task_id}`);
    assert.strictEqual(memberCalls, 1);
    assert.strictEqual((await runProduction()).exitCode, 1, 'CI checkpoint crash 應停在 Review 等待重跑');
    assert.strictEqual(git(repo, 'rev-parse', `sim/task/${task.task_id}`), committedHead, '重跑不可重複建立 task commit');
    assert.strictEqual((await runProduction()).exitCode, 1, 'CI 重跑通過後、完成 checkpoint crash 前 Task 應已 Done');
    assert.strictEqual((await runProduction()).exitCode, 0, 'Done checkpoint 重跑必須是冪等 no-op');
    assert.strictEqual(memberCalls, 1, 'checkpoint 重跑不可再次呼叫 member runner');
    assert.strictEqual(ciCalls, 2, 'CI checkpoint 只允許 crash 一次、成功一次');
    assert.strictEqual(git(repo, 'rev-list', '--count', `${baseSha}..master`), '2', '只有 task commit 與單一 merge commit');
    assert.strictEqual((db.prepare('SELECT status FROM tasks_read_model WHERE task_id = ?').get(task.task_id) as { status: string }).status, 'Done');

    assert.strictEqual(await coordinatorModule.runGoalCoordinatorOnce(goalId, newGoalDeps()), 'done');
    assert.strictEqual(await coordinatorModule.runGoalCoordinatorOnce(goalId, newGoalDeps()), 'followup_created');
    assert.strictEqual(await coordinatorModule.runGoalCoordinatorOnce(goalId, newGoalDeps()), 'Done', 'follow-up checkpoint 重跑不可再建 child Goal');
    assert.strictEqual(count(db, 'SELECT COUNT(*) AS n FROM goal_followups WHERE parent_goal_id = ?', goalId), 1);
    assert.strictEqual(count(db, 'SELECT COUNT(*) AS n FROM goals_read_model WHERE parent_goal_id = ?', goalId), 1);
    assert.strictEqual(count(db, 'SELECT COUNT(*) AS n FROM goal_contributions WHERE goal_id = ?', goalId), 4);
    assert.strictEqual(count(db, 'SELECT COUNT(*) AS n FROM tasks_read_model WHERE goal_id = ?', goalId), 1);
    assert.strictEqual(count(db, "SELECT COUNT(*) AS n FROM goal_heartbeats WHERE goal_id = ? AND phase = 'followup'", goalId), 1);
    assert.strictEqual(phaseCalls.get('owner_synthesis'), 1, '重啟不可重跑 synthesis');
    assert.strictEqual(phaseCalls.get('followup'), 1, '重啟不可重跑 follow-up');
    assert.strictEqual(goalModule.getGoal(goalId, db)?.status, 'Done');
  } finally {
    if (server) await close(server);
    rmSync(root, { recursive: true, force: true });
  }
}

main().then(() => console.log('goal.integration.test.ts OK'));
