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

// 階段 4 的 fixture：run.ts 刪掉的每一行 console.log，改由 formatTraceRecord 產生。
// 人話（detail）逐字保留，前綴由 event + 上下文取代。這組斷言把格式鎖住——改動
// formatTraceRecord 會在這裡當場失敗，而不是等到有人去讀 cron log 才發現變了樣。
{
  const fixture = (over: Partial<TraceRecord>): TraceRecord => ({
    ts: '2026-08-19T03:04:05.000Z', event: 'run.started', run_id: 'sweep-2026-08-19-10-00-team',
    session_id: null, task_id: null, actor: 'sim', model: null, round: null,
    outcome: null, reason: null, evidence: null, from: null, to: null, detail: '', ...over,
  });
  const cases: Array<[string, TraceRecord]> = [
    // 舊：[阿凱-r1] 開始（codex/gpt-5.6-terra）
    ['session.started [阿凱-r1] codex/gpt-5.6-terra retry=0',
      fixture({ event: 'session.started', actor: '阿凱-r1', detail: 'codex/gpt-5.6-terra retry=0' })],
    // 舊：[阿凱-r1] 結束（逾時 12 分被中止） — 最後兩行
    ['session.ended [阿凱-r1 fail log:sim-logs/a.log] timeout（逾時 12 分被中止） — 最後兩行',
      fixture({ event: 'session.ended', actor: '阿凱-r1', outcome: 'fail', evidence: { kind: 'log', ref: 'sim-logs/a.log' }, detail: 'timeout（逾時 12 分被中止） — 最後兩行' })],
    // 舊：[代commit] sim/member-x 拒絕未允許檔案：api.json
    ['commit.recorded [阿凱 refused] sim/member-x 拒絕未允許檔案：api.json',
      fixture({ event: 'commit.recorded', actor: '阿凱', outcome: 'refused', detail: 'sim/member-x 拒絕未允許檔案：api.json' })],
    // 舊：[代commit] sim/member-x r1 → 8a2fc56
    ['commit.recorded [阿凱 ok git:8a2fc56] sim/member-x r1 → 8a2fc56',
      fixture({ event: 'commit.recorded', actor: '阿凱', outcome: 'ok', evidence: { kind: 'git', ref: '8a2fc56' }, detail: 'sim/member-x r1 → 8a2fc56' })],
    // 舊：[CI預跑] sim/member-x: tsc PASS / test FAIL（2 commit）——拆成兩筆，各自帶得到輸出位置
    ['ci.checked [阿凱 ok branch_ci tsc:packets/x-tsc.txt] sim/member-x tsc pass（2 commit）',
      fixture({ event: 'ci.checked', actor: '阿凱', outcome: 'ok', reason: 'branch_ci', evidence: { kind: 'tsc', ref: 'packets/x-tsc.txt' }, detail: 'sim/member-x tsc pass（2 commit）' })],
    // 舊：[阿凱-r1] notification gate 未完成，略過一般 session
    ['gate.skipped [阿凱-r1 notification_gate] 阿凱-r1 notification gate 未過，略過一般 session',
      fixture({ event: 'gate.skipped', actor: '阿凱-r1', reason: 'notification_gate', detail: '阿凱-r1 notification gate 未過，略過一般 session' })],
  ];
  for (const [expected, record] of cases) {
    assert.strictEqual(formatTraceRecord(record), expected);
  }
}

console.log('sim/trace.test.ts 通過');
