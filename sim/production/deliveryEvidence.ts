import type { TaskSnapshot } from './policy';
import type { DeployAcceptanceResult } from './coordinator';

interface DeliveryEvidenceClient {
  recordDeliveryEvidence(taskId: string, input: { kind: string; ref: string; detail: string }): Promise<void>;
}

type DeliveryTask = Pick<TaskSnapshot, 'taskId' | 'goalId' | 'deployment'>;

let fallbackAttempt = 0;

export async function recordDeployDeliveryEvidence(
  ownerClient: DeliveryEvidenceClient,
  task: DeliveryTask,
  deployResult: DeployAcceptanceResult,
  branch: string,
  headSha: string,
): Promise<void> {
  if (!task.goalId || deployResult.kind === 'fatal_blocked') return;
  const ciRef = `${branch}@${headSha || `attempt-${++fallbackAttempt}`}`;
  await ownerClient.recordDeliveryEvidence(task.taskId, {
    kind: 'ci.checked', ref: ciRef,
    detail: deployResult.kind === 'branch_ci_failed'
      ? `failed: ${deployResult.detail}`
      : 'passed: branch CI completed',
  });
  if (deployResult.kind !== 'deployed') return;
  await ownerClient.recordDeliveryEvidence(task.taskId, {
    kind: 'merge.integrated', ref: deployResult.mergeSha, detail: 'merged task branch',
  });
  await ownerClient.recordDeliveryEvidence(task.taskId, {
    kind: task.deployment === 'not_required' ? 'deployment_not_required' : 'deployment.verified',
    ref: task.deployment === 'not_required' ? 'registered-policy' : deployResult.mergeSha,
    detail: task.deployment === 'not_required'
      ? 'Project registry explicitly skips deployment'
      : 'deployment and live readback passed',
  });
}
