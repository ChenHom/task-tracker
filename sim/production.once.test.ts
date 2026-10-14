import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runOnce, type DiscoveryOk, type GatherSnapshotDeps } from './production';
import {
  CANONICAL_WORKSPACE_ID,
  CUTOVER_TASKS,
  MAIN_WORKSPACE_ID,
  type CoordinatorSnapshot,
  type TaskSnapshot,
} from './production/policy';

const boardTask = (taskId: string, status: TaskSnapshot['status'], assigneeId: string | null = null): TaskSnapshot => ({
  taskId,
  workspaceId: MAIN_WORKSPACE_ID,
  title: taskId,
  status,
  assigneeId,
  dueAt: null,
  updatedAt: '2026-10-14T00:00:00.000Z',
  version: 1,
});

const cutoverTasks = (prerequisiteStatus: TaskSnapshot['status']): TaskSnapshot[] => [
  boardTask(CUTOVER_TASKS.mainDiscussion, 'Archived'),
  boardTask(CUTOVER_TASKS.activeReview.taskId, 'Archived', 'user06'),
  boardTask(CUTOVER_TASKS.queuedReview.taskId, 'Archived'),
  boardTask(CUTOVER_TASKS.completedPrerequisite.taskId, prerequisiteStatus),
  boardTask(CUTOVER_TASKS.deferredAssignment.taskId, 'Archived'),
];

const snapshot = (tasks: TaskSnapshot[]): CoordinatorSnapshot => ({
  tasks,
  taskRuns: {},
  taskEvidence: {},
  prerequisiteEvidence: null,
  userIdsByEmail: { 'user05@test.local': 'user05', 'user06@test.local': 'user06' },
  agentIds: [],
  warnings: [],
});

const unusedClient = {} as DiscoveryOk['ownerClient'];
const performDiscovery = async (): Promise<DiscoveryOk> => ({
  ok: true,
  ownerClient: unusedClient,
  user09Client: unusedClient,
  healthRev: 'test-rev',
});

async function runWithSnapshot(dbPath: string, value: CoordinatorSnapshot) {
  return runOnce({
    live: false,
    dbPath,
    repoRoot: '/not-used',
    now: () => new Date('2026-10-14T00:00:00.000Z'),
    traceSink: () => {},
    performDiscovery,
    gatherSnapshot: async (_deps: GatherSnapshotDeps) => value,
  });
}

async function testSettledCutoverReportUsesGenericActions(): Promise<void> {
  const dbDir = mkdtempSync(join(tmpdir(), 'production-once-settled-'));
  try {
    const result = await runWithSnapshot(join(dbDir, 'coordinator.db'), snapshot([
      ...cutoverTasks('Archived'),
      { ...boardTask('current-review', 'Review', 'reviewer'), workspaceId: CANONICAL_WORKSPACE_ID },
      { ...boardTask('current-todo', 'Todo'), workspaceId: CANONICAL_WORKSPACE_ID },
    ]));
    const output = result.lines.join('\n');

    assert.strictEqual(result.exitCode, 0, `cutover 已結案時應 ready，實際輸出：\n${output}`);
    for (const staleMessage of [
      'CutoverPrerequisiteMissing',
      '等待任務1前置條件通過',
      '尚待任務 9 reconciliation',
      '等待 938 Done 後交給 user05',
      'user06／active',
    ]) {
      assert.doesNotMatch(output, new RegExp(staleMessage), `cutover 已結案時不得再輸出：${staleMessage}`);
    }
    assert.match(output, /owner_review current-/, 'planned actions 應保留一般 owner_review');
    assert.match(output, /owner_dispatch current-/, 'planned actions 應保留一般 owner_dispatch');
  } finally {
    rmSync(dbDir, { recursive: true, force: true });
  }
}

async function testUnsettledCutoverStillReportsMissingEvidence(): Promise<void> {
  const dbDir = mkdtempSync(join(tmpdir(), 'production-once-unsettled-'));
  try {
    const result = await runWithSnapshot(
      join(dbDir, 'coordinator.db'),
      snapshot(cutoverTasks('Todo')),
    );
    assert.strictEqual(result.exitCode, 2);
    assert.match(result.lines.join('\n'), /CutoverPrerequisiteMissing/);
  } finally {
    rmSync(dbDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testSettledCutoverReportUsesGenericActions();
  await testUnsettledCutoverStillReportsMissingEvidence();
}

main()
  .then(() => console.log('production.once.test.ts OK'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
