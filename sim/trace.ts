// sim 車隊結構化 trace。設計與掛載點見 docs/sim-trace.md。
// 寫入端依事件收不同參數（TraceArgs），落盤是單一扁平形狀（TraceRecord）。
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkPhase } from './production/types';

export type Outcome = 'ok' | 'fail' | 'skip' | 'refused';
export type EvidenceKind = 'tsc' | 'test' | 'readback' | 'git' | 'log';
export interface Evidence { kind: EvidenceKind; ref: string }

// 每個事件收哪些參數。這張表即 docs/sim-trace.md〈事件語意〉的程式碼形式；
// 新增事件只需在此加一行，下方沒有任何函式本體要改。
type TraceArgs = {
  // 生命週期
  'run.started': { detail: string };
  'run.ended': { outcome: Outcome; detail: string };
  'session.started': { detail: string };
  'session.ended': { outcome: Outcome; evidence: Evidence | null; detail: string };
  // 工作推進
  'task.phase_changed': { from: WorkPhase | null; to: WorkPhase; detail: string };
  'task.attempted': { outcome: Outcome; reason: string; detail: string };
  'action.started': { reason: string; detail: string };
  'action.ended': { outcome: Outcome; reason: string; detail: string };
  // 證據產生
  'ci.checked': { outcome: Outcome; reason: string; evidence: Evidence; detail: string };
  'commit.recorded': { outcome: Outcome; evidence: Evidence | null; detail: string };
  'merge.integrated': { evidence: Evidence; detail: string };
  // 交付
  'completion.confirmed': { evidence: Evidence; detail: string };
  'notify.sent': { outcome: Outcome; detail: string };
  // 阻塞
  'gate.skipped': { reason: string; detail: string };
};

export type TraceEvent = keyof TraceArgs;
export type Tracer = <E extends TraceEvent>(event: E, args: TraceArgs[E]) => void;
export type TraceSink = (record: TraceRecord) => void;

export interface TraceBase {
  run_id: string;
  session_id: string | null;
  task_id: string | null;
  actor: string;
  model: string | null;
  round: number | null;
}

// 落盤形狀：扁平、每行欄位相同。TraceArgs 沒給的欄位補 null。
export interface TraceRecord extends TraceBase {
  ts: string;
  event: TraceEvent;
  outcome: Outcome | null;   // 「開始」類事件為 null——尚未有結果，補 'ok' 在語意上是錯的
  reason: string | null;
  evidence: Evidence | null;
  from: WorkPhase | null;
  to: WorkPhase | null;
  detail: string;
}

const DETAIL_MAX = 300;
const TRACE_DIR = join(__dirname, '../sim-logs/trace');

// TraceArgs 各分支的聯集上界。泛型 args 無法直接取欄位，於此收斂成一種可讀形狀。
type AnyArgs = { detail: string } & Partial<{
  outcome: Outcome;
  reason: string;
  evidence: Evidence | null;
  from: WorkPhase | null;
  to: WorkPhase;
}>;

function buildTraceRecord<E extends TraceEvent>(base: TraceBase, event: E, args: TraceArgs[E], now: Date): TraceRecord {
  const a = args as AnyArgs;
  return {
    ts: now.toISOString(),
    event,
    ...base,
    outcome: a.outcome ?? null,
    reason: a.reason ?? null,
    evidence: a.evidence ?? null,
    from: a.from ?? null,
    to: a.to ?? null,
    detail: a.detail.slice(0, DETAIL_MAX),
  };
}

// 人話那行。單一函式，無 switch——事件增減不必動它。
export function formatTraceRecord(r: TraceRecord): string {
  const bits = [
    r.task_id,
    r.actor,
    r.to ? `${r.from ?? '∅'}→${r.to}` : null,
    r.outcome,
    r.reason,
    r.evidence ? `${r.evidence.kind}:${r.evidence.ref}` : null,
  ].filter((b): b is string => Boolean(b));
  return `${r.event}${bits.length ? ` [${bits.join(' ')}]` : ''} ${r.detail}`;
}

// fileName 省略時按日切檔（coordinator tick 與 sweep 巡檢）；手動跑的一場 sim 傳 `${run_id}.jsonl`。
export function createFileSink(fileName?: string): TraceSink {
  return (r) => {
    mkdirSync(TRACE_DIR, { recursive: true });
    appendFileSync(join(TRACE_DIR, fileName ?? `${r.ts.slice(0, 10)}.jsonl`), `${JSON.stringify(r)}\n`);
    console.log(formatTraceRecord(r));
  };
}

// partial application 即 child logger：session 起始時帶著補上的 session_id 再呼叫一次。
export function createTracer(base: TraceBase, sink: TraceSink = createFileSink(), now: () => Date = () => new Date()): Tracer {
  return (event, args) => sink(buildTraceRecord(base, event, args, now()));
}
