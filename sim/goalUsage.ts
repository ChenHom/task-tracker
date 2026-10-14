import type { AdapterReadiness, UsageEstimate } from './goalAdapters';

export interface GoalRunRecorder {
  quotaSnapshot: () => Promise<string>;
  prepareRun: (input: Record<string, unknown>) => Promise<string>;
  finishRun: (runId: string, input: Record<string, unknown>) => Promise<void>;
}

interface UsageResult {
  exitCode: number;
  sessionId?: string | null;
  actualInputTokens?: number | null;
  actualOutputTokens?: number | null;
  tokenTotal?: number | null;
}

interface PreflightRunContext {
  recorder: GoalRunRecorder;
  goalId: string;
  taskId: string;
  agentId: string;
  phase: string;
  triggerRef: string;
  routes: { primary: { adapter: string; model: string }; fallback?: { adapter: string; model: string } | null };
}

export function createPreflightRunPersister(input: PreflightRunContext) {
  return async (attempt: 'primary' | 'fallback', estimate: UsageEstimate, readiness: AdapterReadiness): Promise<void> => {
    if (readiness.ready) return;
    const route = input.routes[attempt];
    if (!route) return;
    const quotaSnapshotJson = await input.recorder.quotaSnapshot();
    const runId = await input.recorder.prepareRun({
      goalId: input.goalId, taskId: input.taskId, agentId: input.agentId, phase: input.phase,
      adapter: route.adapter, model: route.model, attempt, triggerRef: input.triggerRef,
      estimatedInputTokens: estimate.inputTokens, estimatedOutputTokens: estimate.outputTokens,
      estimateBasis: estimate.basis, estimateConfidence: estimate.confidence, quotaSnapshotJson,
    });
    await input.recorder.finishRun(runId, {
      status: 'failed', actualInputTokens: null, actualOutputTokens: null, tokenTotal: null,
      sessionId: null, outcome: readiness.reason ?? 'preflight failed', errorCategory: 'preflight',
      sideEffectState: 'none',
    });
  };
}

export async function trackGoalRunAttempt<T extends UsageResult>(input: {
  recorder: GoalRunRecorder;
  goalId: string;
  taskId: string;
  agentId: string;
  phase: string;
  adapter: string;
  model: string;
  attempt: 'primary' | 'fallback';
  triggerRef: string;
  prompt: string;
  estimatedOutputTokens: number;
  invoke: () => Promise<T>;
}): Promise<T> {
  const quotaSnapshotJson = await input.recorder.quotaSnapshot();
  const runId = await input.recorder.prepareRun({
    goalId: input.goalId, taskId: input.taskId, agentId: input.agentId, phase: input.phase,
    adapter: input.adapter, model: input.model, attempt: input.attempt, triggerRef: input.triggerRef,
    estimatedInputTokens: Math.ceil(input.prompt.length / 4), estimatedOutputTokens: input.estimatedOutputTokens,
    estimateBasis: 'bounded_context_chars', estimateConfidence: 'medium', quotaSnapshotJson,
  });
  try {
    const result = await input.invoke();
    await input.recorder.finishRun(runId, {
      status: result.exitCode === 0 ? 'succeeded' : 'failed',
      actualInputTokens: result.actualInputTokens ?? null,
      actualOutputTokens: result.actualOutputTokens ?? null,
      tokenTotal: result.tokenTotal ?? null,
      sessionId: result.sessionId ?? null,
      outcome: `exit_${result.exitCode}`,
      errorCategory: result.exitCode === 0 ? null : 'process',
      sideEffectState: 'none',
    });
    return result;
  } catch (error) {
    await input.recorder.finishRun(runId, {
      status: 'failed', actualInputTokens: null, actualOutputTokens: null, tokenTotal: null,
      outcome: null, errorCategory: 'process', sideEffectState: 'none',
    });
    throw error;
  }
}
