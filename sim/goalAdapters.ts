import { buildRunnerInvocation, type ModelRoute } from './run';

export interface AdapterInput { prompt: string; cwd: string; model: string }
export interface AdapterReadiness { ready: boolean; reason?: string }
export interface UsageEstimate { inputTokens: number; outputTokens: number; basis: string; confidence: string }
export interface AgentRunResult {
  status: 'succeeded' | 'failed' | 'uncertain';
  output: string; sessionId: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens?: number | null; cost: number | null } | null;
  exitStatus: number | null;
  errorCategory: string | null;
  sideEffectState: 'none' | 'changed' | 'unknown';
}
export interface AgentAdapter {
  name: string;
  preflight(input: AdapterInput): Promise<AdapterReadiness>;
  estimate(input: AdapterInput): UsageEstimate;
  run(input: AdapterInput): Promise<AgentRunResult>;
}

export function buildAdapterInvocation(runner: ModelRoute['runner'], input: AdapterInput): { command: string; args: string[]; cwd: string } {
  return { ...buildRunnerInvocation({ runner, model: input.model }, input.prompt, {
    cwd: input.cwd, logFile: '/dev/null', captureLastMessage: false,
  }), cwd: input.cwd };
}

export function classifyAdapterResult(input: { exitCode: number; stdout: string; stderr: string }): Pick<AgentRunResult, 'status' | 'errorCategory' | 'sideEffectState' | 'exitStatus'> {
  const combined = `${input.stdout}\n${input.stderr}`;
  if (input.exitCode === 0 && !input.stdout.trim() && /no output produced/iu.test(input.stderr)) {
    return { status: 'failed', errorCategory: 'permission', sideEffectState: 'none', exitStatus: input.exitCode };
  }
  if (input.exitCode === 0) {
    return { status: 'succeeded', errorCategory: null, sideEffectState: 'changed', exitStatus: input.exitCode };
  }
  if (/timeout|timed out|逾時/iu.test(combined)) return { status: 'uncertain', errorCategory: 'timeout', sideEffectState: 'unknown', exitStatus: input.exitCode };
  if (/quota|rate.?limit|resource exhausted|usage limit/iu.test(combined)) {
    return { status: 'failed', errorCategory: 'quota', sideEffectState: 'none', exitStatus: input.exitCode };
  }
  if (/permission|forbidden|access denied|not permitted/iu.test(combined)) {
    return { status: 'failed', errorCategory: 'permission', sideEffectState: 'none', exitStatus: input.exitCode };
  }
  return { status: 'failed', errorCategory: 'runner', sideEffectState: 'unknown', exitStatus: input.exitCode };
}

async function attempt(
  label: 'primary' | 'fallback', input: AdapterInput, adapter: AgentAdapter,
  persist: (attempt: 'primary' | 'fallback', estimate: UsageEstimate, readiness: AdapterReadiness) => Promise<void>,
): Promise<AgentRunResult> {
  const readiness = await adapter.preflight(input);
  const estimate = adapter.estimate(input);
  await persist(label, estimate, readiness);
  if (!readiness.ready) return { status: 'failed', output: '', sessionId: null, usage: null, exitStatus: null, errorCategory: 'preflight', sideEffectState: 'none' };
  return adapter.run(input);
}

export async function executeWithSingleFallback(
  input: AdapterInput, primary: AgentAdapter, fallback: AgentAdapter | null,
  persist: (attempt: 'primary' | 'fallback', estimate: UsageEstimate, readiness: AdapterReadiness) => Promise<void>,
): Promise<AgentRunResult & { attempt: 'primary' | 'fallback' }> {
  const first = await attempt('primary', input, primary, persist);
  if (first.status === 'succeeded' || first.sideEffectState !== 'none' || !fallback) return { ...first, attempt: 'primary' };
  if (first.errorCategory === 'permission' && primary.name === fallback.name) return { ...first, attempt: 'primary' };
  const second = await attempt('fallback', input, fallback, persist);
  return { ...second, attempt: 'fallback' };
}
