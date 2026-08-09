import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createNotificationTelemetryRecorder,
  emitNotificationTelemetry,
  pruneNotificationTelemetry,
  type NotificationTelemetryEvent,
} from './notificationTelemetry';

const root = mkdtempSync(join(tmpdir(), 'notification-telemetry-'));
const base = {
  run_id: 'sweep-2026-08-01-team',
  deployment_revision: 'deployed-abc123',
  workflow_version: 'legacy-team-sweep-v1',
  configuration_version: 'notification-gate-v1',
  agent: 'codex',
  model: 'gpt-test',
  tool_type: 'agent.preflight',
  tool_sequence: 2,
  started_at: '2026-08-01T00:00:00.000Z',
  ended_at: '2026-08-01T00:00:01.000Z',
  outcome: 'succeeded',
  error_category: 'none',
  retry: 0,
  token_total: 24,
  latency_ms: 1_000,
  evaluation_code: 'preflight_ready',
} as unknown as NotificationTelemetryEvent;

const expectedEventKeys = [
  'agent', 'configuration_version', 'deployment_revision', 'ended_at', 'error_category', 'evaluation_code', 'latency_ms', 'model',
  'outcome', 'retry', 'run_id', 'started_at', 'token_total', 'tool_sequence', 'tool_type', 'workflow_version',
].sort();

const recorder = createNotificationTelemetryRecorder(root, 'sweep-2026-08-01-recorder');
const recorderEvent = recorder.record({
  deployment_revision: (base as unknown as { deployment_revision: string }).deployment_revision,
  workflow_version: base.workflow_version,
  configuration_version: base.configuration_version,
  agent: base.agent,
  model: base.model,
  tool_type: base.tool_type,
  started_at: base.started_at,
  ended_at: base.ended_at,
  outcome: base.outcome,
  error_category: base.error_category,
  retry: base.retry,
  token_total: base.token_total,
  latency_ms: base.latency_ms,
  evaluation_code: base.evaluation_code,
} as never);
assert.strictEqual(recorderEvent.run_id, 'sweep-2026-08-01-recorder');
assert.strictEqual(recorderEvent.tool_sequence, 1, 'recorder 必須在每個 run 內自動產生連續 tool sequence');

const recorded = [
  emitNotificationTelemetry(root, base),
  emitNotificationTelemetry(root, {
    ...base,
    tool_sequence: 3,
    outcome: 'failed',
    error_category: 'network',
    retry: 1,
    token_total: null,
    evaluation_code: 'preflight_failed',
  }),
  emitNotificationTelemetry(root, {
    ...base,
    tool_type: 'auth.login',
    tool_sequence: 1,
    outcome: 'refused',
    error_category: 'permission',
    token_total: null,
    evaluation_code: 'permission_refused',
  }),
  emitNotificationTelemetry(root, {
    ...base,
    tool_type: 'agent.discussion',
    evaluation_code: 'discussion_succeeded',
  }),
];
for (const event of recorded) assert.deepStrictEqual(Object.keys(event).sort(), expectedEventKeys, 'emit 只能落允許欄位');

for (const forbidden of ['prompt', 'tool_args', 'tool_result', 'cookie', 'authorization'] as const) {
  assert.throws(
    () => emitNotificationTelemetry(root, { ...base, [forbidden]: 'secret' } as unknown as NotificationTelemetryEvent),
    /不允許的 telemetry 欄位/,
    `${forbidden} 必須在寫檔前 fail closed`,
  );
}

const runEvents = readFileSync(join(root, 'runs', `${base.run_id}.jsonl`), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
assert.strictEqual(runEvents.length, 4, '成功、錯誤、retry、權限拒絕與 discussion 都要各自留一筆 allowlisted event');
assert.ok(runEvents.some((event) => event.retry === 1 && event.error_category === 'network'));
assert.ok(runEvents.some((event) => event.outcome === 'refused' && event.error_category === 'permission'));
assert.ok(runEvents.some((event) => event.tool_type === 'agent.discussion' && event.evaluation_code === 'discussion_succeeded'));
assert.ok(!JSON.stringify(runEvents).includes('secret'), '敏感值不得寫入 telemetry');

const aggregates = JSON.parse(readFileSync(join(root, 'aggregates', '2026-08-01.json'), 'utf8'));
assert.strictEqual(aggregates.length, 3, '彙總需按 workflow 與 error category 分桶');
for (const summary of aggregates) {
  assert.deepStrictEqual(
    Object.keys(summary).sort(),
    ['date', 'error_category', 'latency_ms', 'run_count', 'token_total', 'workflow_version'],
    '90 天彙總不得保留 run、agent、model 或任何正文',
  );
}

const retentionRoot = mkdtempSync(join(tmpdir(), 'notification-telemetry-retention-'));
mkdirSync(join(retentionRoot, 'runs'), { recursive: true });
mkdirSync(join(retentionRoot, 'aggregates'), { recursive: true });
const expiredRun = join(retentionRoot, 'runs', 'expired.jsonl');
const keptRun = join(retentionRoot, 'runs', 'kept.jsonl');
const fifteenDayRun = join(retentionRoot, 'runs', 'fifteen-day.jsonl');
const expiredAggregate = join(retentionRoot, 'aggregates', 'expired.json');
const keptAggregate = join(retentionRoot, 'aggregates', 'kept.json');
const fifteenDayAggregate = join(retentionRoot, 'aggregates', 'fifteen-day.json');
for (const path of [expiredRun, keptRun, fifteenDayRun, expiredAggregate, keptAggregate, fifteenDayAggregate]) writeFileSync(path, '[]');
const old = new Date('2026-04-01T00:00:00.000Z');
const recent = new Date('2026-07-31T00:00:00.000Z');
const fifteenDaysAgo = new Date('2026-07-17T00:00:00.000Z');
for (const path of [expiredRun, expiredAggregate]) utimesSync(path, old, old);
for (const path of [keptRun, keptAggregate]) utimesSync(path, recent, recent);
for (const path of [fifteenDayRun, fifteenDayAggregate]) utimesSync(path, fifteenDaysAgo, fifteenDaysAgo);
assert.deepStrictEqual(
  pruneNotificationTelemetry(retentionRoot, new Date('2026-08-01T00:00:00.000Z')),
  { runsDeleted: 2, aggregatesDeleted: 1 },
);
assert.ok(!existsSync(expiredRun) && !existsSync(expiredAggregate), 'run 細節 14 天、彙總 90 天後要刪除');
assert.ok(existsSync(keptRun) && existsSync(keptAggregate), '保留期內資料不得提早刪除');
assert.ok(!existsSync(fifteenDayRun) && existsSync(fifteenDayAggregate), '15 天時只刪 run 細節，aggregate 必須保留到 90 天');

console.log('notification telemetry tests passed');
