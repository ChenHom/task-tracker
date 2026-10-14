import assert from 'node:assert';
import {
  buildAdapterInvocation, classifyAdapterResult, executeWithSingleFallback,
  type AgentAdapter, type AdapterInput,
} from './goalAdapters';
import { productionMemberAdapter } from './production';

const input: AdapterInput = { prompt: 'do work', cwd: '/tmp/work', model: 'model-1' };
assert.deepStrictEqual(buildAdapterInvocation('agy', input), {
  command: 'agy', args: ['--model', 'model-1', '--mode', 'accept-edits', '--print', 'do work'], cwd: '/tmp/work',
});
assert.deepStrictEqual(buildAdapterInvocation('claude', input), {
  command: 'claude', args: ['-p', 'do work', '--model', 'model-1', '--allowedTools', ''], cwd: '/tmp/work',
});
assert.ok(buildAdapterInvocation('codex', input).args.join(' ').includes('-C /tmp/work'), 'Codex command 必須帶 capability cwd');
assert.strictEqual(classifyAdapterResult({ exitCode: 0, stdout: '', stderr: 'no output produced' }).errorCategory, 'permission');
assert.deepStrictEqual(classifyAdapterResult({ exitCode: 124, stdout: '', stderr: 'timeout' }), {
  status: 'uncertain', errorCategory: 'timeout', sideEffectState: 'unknown', exitStatus: 124,
});
assert.deepStrictEqual(classifyAdapterResult({ exitCode: 1, stdout: '', stderr: 'quota exceeded' }), {
  status: 'failed', errorCategory: 'quota', sideEffectState: 'none', exitStatus: 1,
});
assert.strictEqual(classifyAdapterResult({ exitCode: 1, stdout: '', stderr: 'permission denied' }).errorCategory, 'permission');
for (const text of ['permission denied', '403 forbidden', 'quota', 'rate limit', 'timeout']) {
  assert.strictEqual(
    classifyAdapterResult({ exitCode: 0, stdout: text, stderr: '' }).status,
    'succeeded',
    `exit 0 輸出含 ${text} 仍應成功`,
  );
}
for (const [text, category] of [
  ['permission denied', 'permission'],
  ['403 forbidden', 'permission'],
  ['quota', 'quota'],
  ['rate limit', 'quota'],
  ['timeout', 'timeout'],
] as const) {
  assert.strictEqual(
    classifyAdapterResult({ exitCode: 1, stdout: text, stderr: '' }).errorCategory,
    category,
    `exit 1 輸出含 ${text} 應分類為 ${category}`,
  );
}
assert.deepStrictEqual(classifyAdapterResult({ exitCode: 0, stdout: '', stderr: 'no output produced' }), {
  status: 'failed', errorCategory: 'permission', sideEffectState: 'none', exitStatus: 0,
});
assert.ok(!buildAdapterInvocation('agy', input).args.includes('--dangerously-skip-permissions'));

const calls: string[] = [];
const adapter = (name: string, result: Awaited<ReturnType<AgentAdapter['run']>>): AgentAdapter => ({
  name,
  async preflight() { calls.push(`${name}:preflight`); return { ready: true }; },
  estimate() { calls.push(`${name}:estimate`); return { inputTokens: 10, outputTokens: 5, basis: 'fixture', confidence: 'high' }; },
  async run() { calls.push(`${name}:run`); return result; },
});

async function main(): Promise<void> {
  const primary = adapter('primary', { status: 'failed', output: '', sessionId: null, usage: null, exitStatus: 1, errorCategory: 'startup', sideEffectState: 'none' });
  const fallback = adapter('fallback', { status: 'succeeded', output: 'ok', sessionId: 's', usage: null, exitStatus: 0, errorCategory: null, sideEffectState: 'none' });
  const result = await executeWithSingleFallback(input, primary, fallback, async (attempt, estimate) => { calls.push(`persist:${attempt}:${estimate.inputTokens}`); });
  assert.strictEqual(result.attempt, 'fallback');
  assert.deepStrictEqual(calls, ['primary:preflight', 'primary:estimate', 'persist:primary:10', 'primary:run', 'fallback:preflight', 'fallback:estimate', 'persist:fallback:10', 'fallback:run']);

  calls.length = 0;
  const uncertain = adapter('uncertain', { status: 'uncertain', output: '', sessionId: null, usage: null, exitStatus: 124, errorCategory: 'timeout', sideEffectState: 'unknown' });
  const stopped = await executeWithSingleFallback(input, uncertain, fallback, async () => {});
  assert.strictEqual(stopped.attempt, 'primary');
  assert.deepStrictEqual(calls, ['uncertain:preflight', 'uncertain:estimate', 'uncertain:run'], '可能有副作用時不可 fallback');

  calls.length = 0;
  const agyDenied = adapter('agy', { status: 'failed', output: '', sessionId: null, usage: null, exitStatus: 0, errorCategory: 'permission', sideEffectState: 'none' });
  const sameAgy = adapter('agy', { status: 'succeeded', output: 'wrong', sessionId: 's2', usage: null, exitStatus: 0, errorCategory: null, sideEffectState: 'none' });
  const denied = await executeWithSingleFallback(input, agyDenied, sameAgy, async () => {});
  assert.strictEqual(denied.attempt, 'primary', 'AGY permission failure 不得換另一個 AGY model 重試');
  assert.deepStrictEqual(calls, ['agy:preflight', 'agy:estimate', 'agy:run']);

  calls.length = 0;
  const successfulReport = adapter('codex', {
    ...classifyAdapterResult({ exitCode: 0, stdout: '新增 requirePermission 檢查，403 forbidden', stderr: '' }),
    output: '新增 requirePermission 檢查，403 forbidden', sessionId: 's3', usage: null,
  });
  const unusedFallback = adapter('claude', { status: 'succeeded', output: 'wrong', sessionId: 's4', usage: null, exitStatus: 0, errorCategory: null, sideEffectState: 'none' });
  const kept = await executeWithSingleFallback(input, successfulReport, unusedFallback, async () => {});
  assert.strictEqual(kept.attempt, 'primary');
  assert.deepStrictEqual(calls, ['codex:preflight', 'codex:estimate', 'codex:run']);

  const productionAdapter = productionMemberAdapter(
    { runner: 'codex', model: 'm' },
    async () => ({
      exitCode: 1,
      stderr: 'permission denied',
      output: { summary: 'quota snapshot', changedPaths: [], verificationCommands: [], blocker: null },
    }),
    {
      taskId: 't', acceptanceCriteria: 'a', comments: [], allowedPrefixes: [],
      verificationCommandAllowlist: [], worktreePath: '/tmp',
    },
    () => 'unchanged',
    false,
  );
  const classifiedProductionResult = await productionAdapter.run(input);
  assert.strictEqual(classifiedProductionResult.errorCategory, 'permission', 'production adapter 應依 runner stderr 分類');
}

main().then(() => console.log('goalAdapters.test.ts OK'));
