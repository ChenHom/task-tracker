import assert from 'node:assert';
import {
  buildAdapterInvocation, classifyAdapterResult, executeWithSingleFallback,
  type AgentAdapter, type AdapterInput,
} from './goalAdapters';

const input: AdapterInput = { prompt: 'do work', cwd: '/tmp/work', model: 'model-1' };
assert.deepStrictEqual(buildAdapterInvocation('agy', input), {
  command: 'agy', args: ['--model', 'model-1', '--mode', 'accept-edits', '--print', 'do work'],
});
assert.strictEqual(classifyAdapterResult({ exitCode: 0, stdout: '', stderr: 'no output produced' }).errorCategory, 'permission');
assert.ok(!buildAdapterInvocation('agy', input).args.includes('--dangerously-skip-permissions'));

const calls: string[] = [];
const adapter = (name: string, result: Awaited<ReturnType<AgentAdapter['run']>>): AgentAdapter => ({
  name,
  async preflight() { calls.push(`${name}:preflight`); return { ready: true }; },
  estimate() { calls.push(`${name}:estimate`); return { inputTokens: 10, outputTokens: 5, basis: 'fixture', confidence: 'high' }; },
  async run() { calls.push(`${name}:run`); return result; },
});

async function main(): Promise<void> {
  const primary = adapter('primary', { status: 'failed', output: '', sessionId: null, usage: null, errorCategory: 'startup', sideEffectState: 'none' });
  const fallback = adapter('fallback', { status: 'succeeded', output: 'ok', sessionId: 's', usage: null, errorCategory: null, sideEffectState: 'none' });
  const result = await executeWithSingleFallback(input, primary, fallback, async (attempt, estimate) => { calls.push(`persist:${attempt}:${estimate.inputTokens}`); });
  assert.strictEqual(result.attempt, 'fallback');
  assert.deepStrictEqual(calls, ['primary:preflight', 'primary:estimate', 'persist:primary:10', 'primary:run', 'fallback:preflight', 'fallback:estimate', 'persist:fallback:10', 'fallback:run']);

  calls.length = 0;
  const uncertain = adapter('uncertain', { status: 'uncertain', output: '', sessionId: null, usage: null, errorCategory: 'timeout', sideEffectState: 'unknown' });
  const stopped = await executeWithSingleFallback(input, uncertain, fallback, async () => {});
  assert.strictEqual(stopped.attempt, 'primary');
  assert.deepStrictEqual(calls, ['uncertain:preflight', 'uncertain:estimate', 'uncertain:run'], '可能有副作用時不可 fallback');
}

main().then(() => console.log('goalAdapters.test.ts OK'));
