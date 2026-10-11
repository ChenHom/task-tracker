import { buildRunnerInvocation, type ModelRoute } from './run';

export interface AdapterInput { prompt: string; cwd: string; model: string }
export interface AdapterReadiness { ready: boolean; reason?: string }
export interface UsageEstimate { inputTokens: number; outputTokens: number; basis: string; confidence: string }
export interface AgentRunResult {
  status: 'succeeded' | 'failed' | 'uncertain';
  output: string; sessionId: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null; cost: number | null } | null;
  errorCategory: string | null;
  sideEffectState: 'none' | 'changed' | 'unknown';
}
export interface AgentAdapter {
  name: string;
  preflight(input: AdapterInput): Promise<AdapterReadiness>;
  estimate(input: AdapterInput): UsageEstimate;
  run(input: AdapterInput): Promise<AgentRunResult>;
}

export function buildAdapterInvocation(runner: ModelRoute['runner'], input: AdapterInput): { command: string; args: string[] } {
  return buildRunnerInvocation({ runner, model: input.model }, input.prompt, {
    cwd: input.cwd, logFile: '/dev/null', captureLastMessage: false,
  });
}

export function classifyAdapterResult(input: { exitCode: number; stdout: string; stderr: string }): Pick<AgentRunResult, 'status' | 'errorCategory' | 'sideEffectState'> {
  if (input.exitCode === 0 && !input.stdout.trim() && /no output produced/iu.test(input.stderr)) {
    return { status: 'failed', errorCategory: 'permission', sideEffectState: 'none' };
  }
  return input.exitCode === 0
    ? { status: 'succeeded', errorCategory: null, sideEffectState: 'changed' }
    : { status: 'failed', errorCategory: 'runner', sideEffectState: 'unknown' };
}

async function attempt(
  label: 'primary' | 'fallback', input: AdapterInput, adapter: AgentAdapter,
  persist: (attempt: 'primary' | 'fallback', estimate: UsageEstimate, readiness: AdapterReadiness) => Promise<void>,
): Promise<AgentRunResult> {
  const readiness = await adapter.preflight(input);
  const estimate = adapter.estimate(input);
  await persist(label, estimate, readiness);
  if (!readiness.ready) return { status: 'failed', output: '', sessionId: null, usage: null, errorCategory: 'preflight', sideEffectState: 'none' };
  return adapter.run(input);
}

export async function executeWithSingleFallback(
  input: AdapterInput, primary: AgentAdapter, fallback: AgentAdapter | null,
  persist: (attempt: 'primary' | 'fallback', estimate: UsageEstimate, readiness: AdapterReadiness) => Promise<void>,
): Promise<AgentRunResult & { attempt: 'primary' | 'fallback' }> {
  const first = await attempt('primary', input, primary, persist);
  if (first.status === 'succeeded' || first.sideEffectState !== 'none' || !fallback) return { ...first, attempt: 'primary' };
  const second = await attempt('fallback', input, fallback, persist);
  return { ...second, attempt: 'fallback' };
}
