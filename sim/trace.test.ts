import assert from 'node:assert';
import { createTracer, formatTraceRecord, type TraceBase, type TraceRecord } from './trace';

const base: TraceBase = {
  run_id: 'tick-1', session_id: null, task_id: 't1', actor: 'coordinator', model: null, round: null,
};
const at = new Date('2026-08-19T03:04:05.000Z');
function capture(): { records: TraceRecord[]; trace: ReturnType<typeof createTracer> } {
  const records: TraceRecord[] = [];
  return { records, trace: createTracer(base, (r) => records.push(r), () => at) };
}

// 未給的欄位一律補 null，落盤形狀固定
{
  const { records, trace } = capture();
  trace('run.started', { detail: '第 1 輪開始' });
  const r = records[0];
  assert.strictEqual(r.ts, '2026-08-19T03:04:05.000Z');
  assert.strictEqual(r.event, 'run.started');
  assert.strictEqual(r.run_id, 'tick-1');
  assert.strictEqual(r.outcome, null, '「開始」類事件的 outcome 必須是 null，不得補 ok');
  for (const k of ['reason', 'evidence', 'from', 'to'] as const) assert.strictEqual(r[k], null, `${k} 應補 null`);
  assert.deepStrictEqual(Object.keys(r).sort(), Object.keys(JSON.parse(JSON.stringify(r))).sort());
}

// 事件專屬欄位如實落盤
{
  const { records, trace } = capture();
  trace('task.phase_changed', { from: 'doing', to: 'review', detail: '交出 PR' });
  trace('ci.checked', { outcome: 'fail', reason: 'branch_ci', evidence: { kind: 'test', ref: 'a.log' }, detail: '3 失敗' });
  assert.strictEqual(records[0].from, 'doing');
  assert.strictEqual(records[0].to, 'review');
  assert.strictEqual(records[1].outcome, 'fail');
  assert.deepStrictEqual(records[1].evidence, { kind: 'test', ref: 'a.log' });
  assert.strictEqual(records[1].from, null, 'from/to 只有 task.phase_changed 用得到');
}

// detail 截斷在 300 字元
{
  const { records, trace } = capture();
  trace('run.started', { detail: 'x'.repeat(500) });
  assert.strictEqual(records[0].detail.length, 300);
}

// formatTraceRecord：無 switch，欄位有值才出現
{
  const { records, trace } = capture();
  trace('run.started', { detail: '開始' });
  trace('task.phase_changed', { from: null, to: 'doing', detail: '首次指派' });
  trace('merge.integrated', { evidence: { kind: 'git', ref: 'abc123' }, detail: '併入 master' });
  assert.strictEqual(formatTraceRecord(records[0]), 'run.started [t1 coordinator] 開始');
  assert.strictEqual(formatTraceRecord(records[1]), 'task.phase_changed [t1 coordinator ∅→doing] 首次指派');
  assert.strictEqual(formatTraceRecord(records[2]), 'merge.integrated [t1 coordinator git:abc123] 併入 master');
}

console.log('sim/trace.test.ts 通過');
