import assert from 'node:assert';
import { executeWithSingleFallback } from './goalAdapters';
import { createPreflightRunPersister, trackGoalRunAttempt } from './goalUsage';

async function main(): Promise<void> {
  const calls: string[] = [];
  const prepared: Array<Record<string, unknown>> = [];
  const finished: Array<Record<string, unknown>> = [];
  const recorder = {
    quotaSnapshot: async () => { calls.push('quota'); return '{"claude":{"remaining":42}}'; },
    prepareRun: async (input: Record<string, unknown>) => {
      calls.push('prepare'); prepared.push(input); return 'run-1';
    },
    finishRun: async (_runId: string, input: Record<string, unknown>) => {
      calls.push('finish'); finished.push(input);
    },
  };
  const result = await trackGoalRunAttempt({
    recorder,
    goalId: 'goal-1', taskId: 'task-1', agentId: 'agent-1', phase: 'implementation',
    adapter: 'codex', model: 'gpt-test', attempt: 'primary', triggerRef: 'tick-1',
    prompt: '12345678', estimatedOutputTokens: 500,
    invoke: async () => {
      calls.push('invoke');
      return { exitCode: 0, sessionId: 'session-17', tokenTotal: 17, actualInputTokens: 11, actualOutputTokens: 6 };
    },
  });
  assert.strictEqual(result.exitCode, 0);
  assert.deepStrictEqual(calls, ['quota', 'prepare', 'invoke', 'finish'], 'Run 必須在模型啟動前保存 quota 與估算');
  assert.deepStrictEqual(prepared, [{
    goalId: 'goal-1', taskId: 'task-1', agentId: 'agent-1', phase: 'implementation',
    adapter: 'codex', model: 'gpt-test', attempt: 'primary', triggerRef: 'tick-1',
    estimatedInputTokens: 2, estimatedOutputTokens: 500,
    estimateBasis: 'bounded_context_chars', estimateConfidence: 'medium',
    quotaSnapshotJson: '{"claude":{"remaining":42}}',
  }]);
  assert.deepStrictEqual(finished, [{
    status: 'succeeded', actualInputTokens: 11, actualOutputTokens: 6, tokenTotal: 17,
    sessionId: 'session-17',
    outcome: 'exit_0', errorCategory: null, sideEffectState: 'none',
  }]);

  await assert.rejects(() => trackGoalRunAttempt({
    recorder: { ...recorder, prepareRun: async () => 'run-2' },
    goalId: 'goal-1', taskId: 'task-1', agentId: 'agent-1', phase: 'implementation',
    adapter: 'codex', model: 'gpt-test', attempt: 'fallback', triggerRef: 'tick-1',
    prompt: 'x', estimatedOutputTokens: 500,
    invoke: async () => { throw new Error('runner failed'); },
  }), /runner failed/);
  assert.strictEqual(finished.at(-1)?.status, 'failed', 'runner throw 也必須完成 Run');

  const preflightPrepared: Array<Record<string, unknown>> = [];
  const preflightFinished: Array<Record<string, unknown>> = [];
  let runCalled = false;
  const preflightRecorder = {
    quotaSnapshot: async () => '{"cachedAt":"t"}',
    prepareRun: async (input: Record<string, unknown>) => {
      preflightPrepared.push(input);
      return 'preflight-run';
    },
    finishRun: async (_runId: string, input: Record<string, unknown>) => {
      preflightFinished.push(input);
    },
  };
  const preflightResult = await executeWithSingleFallback(
    { prompt: 'check', cwd: '/missing', model: 'gpt-test' },
    {
      name: 'codex',
      preflight: async () => ({ ready: false, reason: 'cli missing' }),
      estimate: () => ({ inputTokens: 2, outputTokens: 500, basis: 'test', confidence: 'high' }),
      run: async () => {
        runCalled = true;
        throw new Error('run 不應被呼叫');
      },
    },
    null,
    createPreflightRunPersister({
      recorder: preflightRecorder,
      goalId: 'goal-1', taskId: 'task-1', agentId: 'agent-1', phase: 'implementation',
      triggerRef: 'tick-preflight',
      routes: { primary: { adapter: 'codex', model: 'gpt-test' } },
    }),
  );
  assert.strictEqual(preflightResult.errorCategory, 'preflight');
  assert.strictEqual(runCalled, false, 'preflight 失敗不可啟動 AI runner');
  assert.strictEqual(preflightPrepared.length, 1);
  assert.strictEqual(preflightPrepared[0].attempt, 'primary');
  assert.strictEqual(preflightFinished.length, 1);
  assert.strictEqual(preflightFinished[0].errorCategory, 'preflight');
  assert.strictEqual(preflightFinished[0].outcome, 'cli missing');
}

main().then(() => console.log('goalUsage.test.ts OK'));
