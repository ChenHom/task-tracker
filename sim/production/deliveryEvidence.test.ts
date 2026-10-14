import assert from 'node:assert';
import { recordDeployDeliveryEvidence } from './deliveryEvidence';
import type { DeployAcceptanceResult } from './coordinator';

async function main(): Promise<void> {
  const calls: Array<{ taskId: string; kind: string; ref: string; detail: string }> = [];
  const ownerClient = {
    async recordDeliveryEvidence(taskId: string, input: { kind: string; ref: string; detail: string }) {
      calls.push({ taskId, ...input });
    },
  };
  const task = { taskId: 'task-1', goalId: 'goal-1', deployment: 'task-tracker' as const };

  await recordDeployDeliveryEvidence(ownerClient, task, { kind: 'branch_ci_failed', detail: 'npm test exit 1' }, 'sim/task-1', 'sha-a');
  assert.deepStrictEqual(calls, [{
    taskId: 'task-1', kind: 'ci.checked', ref: 'sim/task-1@sha-a', detail: 'failed: npm test exit 1',
  }]);

  calls.length = 0;
  await recordDeployDeliveryEvidence(ownerClient, task, {
    kind: 'deployed', mergeSha: 'merge-b', deployObservedOutOfBand: false,
  }, 'sim/task-1', 'sha-b');
  assert.deepStrictEqual(calls.map(({ kind, ref, detail }) => ({ kind, ref, detail })), [
    { kind: 'ci.checked', ref: 'sim/task-1@sha-b', detail: 'passed: branch CI completed' },
    { kind: 'merge.integrated', ref: 'merge-b', detail: 'merged task branch' },
    { kind: 'deployment.verified', ref: 'merge-b', detail: 'deployment and live readback passed' },
  ]);

  calls.length = 0;
  await recordDeployDeliveryEvidence(ownerClient, { ...task, deployment: 'not_required' }, {
    kind: 'deployed', mergeSha: 'merge-c', deployObservedOutOfBand: false,
  }, 'sim/task-1', 'sha-c');
  assert.deepStrictEqual(calls.map(({ kind }) => kind), ['ci.checked', 'merge.integrated', 'deployment_not_required']);

  calls.length = 0;
  const fatal: DeployAcceptanceResult = {
    kind: 'fatal_blocked', fatal: { taskId: 'task-1', sha: 'sha-fatal', reason: 'recorded failure' },
  };
  await recordDeployDeliveryEvidence(ownerClient, task, fatal, 'sim/task-1', 'sha-fatal');
  assert.deepStrictEqual(calls, []);
}

main().then(() => console.log('production delivery evidence tests passed')).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
