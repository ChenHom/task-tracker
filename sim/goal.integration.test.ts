import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getUserIdByEmail } from '../src/auth';
import { resetProjections } from '../src/eventStore';
import { getGoal, registerGoalProjections } from '../src/goal';
import {
  createFollowupGoal,
} from '../src/goalOrchestrator';
import { registerGoalWorktree } from '../src/project';
import { recordDeliveryEvidence } from '../src/deliveryEvidence';
import { runMigrations } from '../src/schema';
import { seedUsers } from '../src/seed';
import { registerTaskProjections } from '../src/task';
import { commitTaskChanges, ensureTaskWorktree, mergeTaskIntoMaster } from './production/git';
import { runGoalCoordinatorOnce } from './goalCoordinator';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function main(): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), 'goal-e2e-'));
  try {
    git(repo, 'init', '-b', 'master'); git(repo, 'config', 'user.name', 'Goal Test'); git(repo, 'config', 'user.email', 'goal@test.local');
    writeFileSync(join(repo, 'README.md'), 'base\n'); git(repo, 'add', 'README.md'); git(repo, 'commit', '-m', 'base');
    const baseSha = git(repo, 'rev-parse', 'HEAD');
    const db = new DatabaseSync(':memory:'); runMigrations(db); resetProjections(); registerGoalProjections(); registerTaskProjections(); seedUsers(db);
    const owner = getUserIdByEmail('user01@test.local', db)!;
    const a2 = getUserIdByEmail('user02@test.local', db)!;
    const a3 = getUserIdByEmail('user03@test.local', db)!;
    db.prepare("INSERT INTO workspaces_read_model VALUES ('ws','W','active','t',NULL)").run();
    for (const id of [owner, a2, a3]) db.prepare("INSERT INTO workspace_members_read_model VALUES ('ws', ?, 'Member', 't')").run(id);
    db.prepare("INSERT INTO projects_read_model (project_id,workspace_id,name,status,target_repo,created_at,updated_at) VALUES ('p','ws','P','active',?,'t','t')").run(repo);
    const { createGoal } = await import('../src/goal');
    const goalId = createGoal('human', { workspaceId: 'ws', projectId: 'p', objective: 'ship', successCriteria: 'merged and verified', ownerAgentId: owner }, db);
    const synthesis = { summary: 'one task', taskPlans: [{ title: 'Implement goal', description: 'change file', assigneeId: a2, acceptanceCriteria: 'git check passes', rollbackCondition: 'revert merge' }], evidenceRefs: ['README.md'] };
    const deps = {
      database: db,
      quotaSnapshot: async () => '{"remaining":100}',
      invokeJson: async ({ phase }: { phase: string }) => {
        if (phase === 'owner_scoping') return { selections: [
          { agentId: a2, reason: 'implementation', assignment: 'review implementation', selectedLoad: 0 },
          { agentId: a3, reason: 'verification', assignment: 'review verification', selectedLoad: 0 },
        ] };
        if (phase === 'round_1') return { stance: 'analysis', claim: 'concrete claim', reason: 'evidence-backed reason', evidenceRefs: ['README.md'] };
        if (phase === 'round_2') return { stance: 'agree', claim: 'cross review', reason: 'peer evidence agrees', evidenceRefs: ['README.md'] };
        if (phase === 'owner_synthesis') return synthesis;
        if (phase === 'verifying') return { passed: true, evidenceRefs: ['success-criteria:verified'] };
        if (phase === 'followup') return { action: 'create', objective: 'measure', successCriteria: 'new evidence measured', reason: 'post completion', evidenceRefs: ['merge:new'] };
        throw new Error(`unexpected phase ${phase}`);
      },
    };
    assert.strictEqual(await runGoalCoordinatorOnce(goalId, deps), 'round_1');
    assert.strictEqual(await runGoalCoordinatorOnce(goalId, deps), 'round_2');
    assert.strictEqual(await runGoalCoordinatorOnce(goalId, deps), 'awaiting_lease');
    assert.strictEqual(await runGoalCoordinatorOnce(goalId, deps), 'Executing');
    const [taskId] = db.prepare('SELECT task_id FROM tasks_read_model WHERE goal_id = ?').all(goalId) as unknown as Array<{ task_id: string }>;
    assert.ok(taskId);

    const worktree = await ensureTaskWorktree(repo, taskId.task_id, baseSha);
    registerGoalWorktree(goalId, repo, worktree.path, db);
    writeFileSync(join(worktree.path, 'result.txt'), 'delivered\n');
    const head = await commitTaskChanges(worktree.path, taskId.task_id, 'Implement goal', ['result.txt']);
    execFileSync('git', ['diff', '--check', `${baseSha}..${head}`], { cwd: repo });
    const merge = await mergeTaskIntoMaster(repo, worktree.branch, taskId.task_id);
    assert.strictEqual(git(repo, 'rev-list', '--count', `${baseSha}..master`), '2', '只有 task commit 與單一 merge commit');
    db.prepare("UPDATE goal_worktrees SET dirty = 0, unmerged = 0 WHERE goal_id = ?").run(goalId);
    db.prepare("UPDATE tasks_read_model SET status = 'Done' WHERE task_id = ?").run(taskId.task_id);
    recordDeliveryEvidence(taskId.task_id, { kind: 'ci.checked', ref: worktree.branch }, db);
    recordDeliveryEvidence(taskId.task_id, { kind: 'merge.integrated', ref: merge }, db);
    recordDeliveryEvidence(taskId.task_id, { kind: 'deployment_not_required', ref: 'fixture-policy' }, db);
    assert.strictEqual(await runGoalCoordinatorOnce(goalId, deps), 'done');
    assert.strictEqual(await runGoalCoordinatorOnce(goalId, deps), 'followup_created');
    const child = (db.prepare('SELECT child_goal_id FROM goal_followups WHERE parent_goal_id = ?').get(goalId) as { child_goal_id: string }).child_goal_id;
    assert.strictEqual(createFollowupGoal(owner, goalId, { objective: 'measure again', successCriteria: 'new evidence measured', reason: 'retry', evidenceRefs: ['merge:new'] }, db), child);
    assert.strictEqual((db.prepare('SELECT COUNT(*) AS n FROM goal_contributions WHERE goal_id = ?').get(goalId) as { n: number }).n, 4);
    assert.strictEqual((db.prepare('SELECT COUNT(*) AS n FROM tasks_read_model WHERE goal_id = ?').get(goalId) as { n: number }).n, 1);
    assert.strictEqual((db.prepare("SELECT COUNT(*) AS n FROM goal_heartbeats WHERE goal_id = ? AND phase = 'followup'").get(goalId) as { n: number }).n, 1);
    assert.strictEqual(getGoal(goalId, db)?.status, 'Done');
    db.close();
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

main().then(() => console.log('goal.integration.test.ts OK'));
