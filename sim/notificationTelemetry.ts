import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type NotificationTelemetryOutcome = 'succeeded' | 'failed' | 'refused';
export type NotificationTelemetryErrorCategory = 'none' | 'network' | 'timeout' | 'quota' | 'permission' | 'process';
export type NotificationTelemetryEvaluationCode = 'login_succeeded' | 'login_failed' | 'preflight_ready' | 'preflight_failed' | 'discussion_succeeded' | 'discussion_failed' | 'permission_refused';

export interface NotificationTelemetryEvent {
  run_id: string;
  deployment_revision: string;
  workflow_version: string;
  configuration_version: string;
  agent: 'claude' | 'codex' | 'agy';
  model: string;
  tool_type: 'auth.login' | 'agent.preflight' | 'agent.discussion';
  tool_sequence: number;
  started_at: string;
  ended_at: string;
  outcome: NotificationTelemetryOutcome;
  error_category: NotificationTelemetryErrorCategory;
  retry: number;
  token_total: number | null;
  latency_ms: number;
  evaluation_code: NotificationTelemetryEvaluationCode;
}

export type NotificationTelemetryRecord = Omit<NotificationTelemetryEvent, 'run_id' | 'tool_sequence'>;

export interface NotificationTelemetryRecorder {
  record(event: NotificationTelemetryRecord): NotificationTelemetryEvent;
}

interface NotificationTelemetryAggregate {
  date: string;
  workflow_version: string;
  error_category: NotificationTelemetryErrorCategory;
  run_count: number;
  token_total: number | null;
  latency_ms: number;
}

const EVENT_KEYS = new Set<keyof NotificationTelemetryEvent>([
  'run_id', 'deployment_revision', 'workflow_version', 'configuration_version', 'agent', 'model', 'tool_type', 'tool_sequence',
  'started_at', 'ended_at', 'outcome', 'error_category', 'retry', 'token_total', 'latency_ms', 'evaluation_code',
]);
const AGGREGATE_KEYS = new Set<keyof NotificationTelemetryAggregate>([
  'date', 'workflow_version', 'error_category', 'run_count', 'token_total', 'latency_ms',
]);
const AGENTS = new Set<NotificationTelemetryEvent['agent']>(['claude', 'codex', 'agy']);
const TOOL_TYPES = new Set<NotificationTelemetryEvent['tool_type']>(['auth.login', 'agent.preflight', 'agent.discussion']);
const OUTCOMES = new Set<NotificationTelemetryOutcome>(['succeeded', 'failed', 'refused']);
const ERROR_CATEGORIES = new Set<NotificationTelemetryErrorCategory>(['none', 'network', 'timeout', 'quota', 'permission', 'process']);
const EVALUATION_CODES = new Set<NotificationTelemetryEvaluationCode>(['login_succeeded', 'login_failed', 'preflight_ready', 'preflight_failed', 'discussion_succeeded', 'discussion_failed', 'permission_refused']);
const RUN_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
const AGGREGATE_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`不允許的 telemetry 欄位: ${label}.${key}`);
  }
}

function assertString(value: unknown, label: string, pattern?: RegExp): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || (pattern && !pattern.test(value))) {
    throw new Error(`telemetry ${label} 格式不合法`);
  }
}

function assertInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`telemetry ${label} 必須是非負整數`);
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (Number.isNaN(Date.parse(value))) throw new Error(`telemetry ${label} 必須是 ISO 時間`);
}

function validateEvent(value: unknown): NotificationTelemetryEvent {
  if (!isRecord(value)) throw new Error('telemetry event 必須是物件');
  assertOnlyKeys(value, EVENT_KEYS, 'event');
  if (Object.keys(value).length !== EVENT_KEYS.size) throw new Error('telemetry event 缺少必要欄位');
  assertString(value.run_id, 'run_id', /^[A-Za-z0-9_-]+$/);
  assertString(value.deployment_revision, 'deployment_revision', /^[A-Za-z0-9._-]+$/);
  assertString(value.workflow_version, 'workflow_version');
  assertString(value.configuration_version, 'configuration_version');
  if (!AGENTS.has(value.agent as NotificationTelemetryEvent['agent'])) throw new Error('telemetry agent 不合法');
  assertString(value.model, 'model');
  if (!TOOL_TYPES.has(value.tool_type as NotificationTelemetryEvent['tool_type'])) throw new Error('telemetry tool_type 不合法');
  assertInteger(value.tool_sequence, 'tool_sequence');
  assertTimestamp(value.started_at, 'started_at');
  assertTimestamp(value.ended_at, 'ended_at');
  if (Date.parse(value.ended_at) < Date.parse(value.started_at)) throw new Error('telemetry ended_at 不可早於 started_at');
  if (!OUTCOMES.has(value.outcome as NotificationTelemetryOutcome)) throw new Error('telemetry outcome 不合法');
  if (!ERROR_CATEGORIES.has(value.error_category as NotificationTelemetryErrorCategory)) throw new Error('telemetry error_category 不合法');
  assertInteger(value.retry, 'retry');
  if (value.token_total !== null) assertInteger(value.token_total, 'token_total');
  assertInteger(value.latency_ms, 'latency_ms');
  if (!EVALUATION_CODES.has(value.evaluation_code as NotificationTelemetryEvaluationCode)) throw new Error('telemetry evaluation_code 不合法');
  return value as unknown as NotificationTelemetryEvent;
}

function validateAggregate(value: unknown): NotificationTelemetryAggregate | null {
  if (!isRecord(value)) return null;
  try {
    assertOnlyKeys(value, AGGREGATE_KEYS, 'aggregate');
    if (Object.keys(value).length !== AGGREGATE_KEYS.size) return null;
    assertString(value.date, 'aggregate.date', /^\d{4}-\d{2}-\d{2}$/);
    assertString(value.workflow_version, 'aggregate.workflow_version');
    if (!ERROR_CATEGORIES.has(value.error_category as NotificationTelemetryErrorCategory)) return null;
    assertInteger(value.run_count, 'aggregate.run_count');
    if (value.token_total !== null) assertInteger(value.token_total, 'aggregate.token_total');
    assertInteger(value.latency_ms, 'aggregate.latency_ms');
    return value as unknown as NotificationTelemetryAggregate;
  } catch {
    return null;
  }
}

function readAggregates(path: string): NotificationTelemetryAggregate[] {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(value)) return [];
    return value.map(validateAggregate).filter((entry): entry is NotificationTelemetryAggregate => entry !== null);
  } catch {
    return [];
  }
}

function updateAggregate(root: string, event: NotificationTelemetryEvent): void {
  const date = event.ended_at.slice(0, 10);
  const dir = join(root, 'aggregates');
  const path = join(dir, `${date}.json`);
  mkdirSync(dir, { recursive: true });
  const entries = readAggregates(path);
  const entry = entries.find((candidate) => candidate.workflow_version === event.workflow_version
    && candidate.error_category === event.error_category);
  if (entry) {
    entry.run_count++;
    entry.latency_ms += event.latency_ms;
    entry.token_total = entry.token_total === null || event.token_total === null ? null : entry.token_total + event.token_total;
  } else {
    entries.push({
      date,
      workflow_version: event.workflow_version,
      error_category: event.error_category,
      run_count: 1,
      token_total: event.token_total,
      latency_ms: event.latency_ms,
    });
  }
  writeFileSync(path, JSON.stringify(entries));
}

export function emitNotificationTelemetry(root: string, value: unknown): NotificationTelemetryEvent {
  const event = validateEvent(value);
  const runDir = join(root, 'runs');
  mkdirSync(runDir, { recursive: true });
  appendFileSync(join(runDir, `${event.run_id}.jsonl`), `${JSON.stringify(event)}\n`);
  updateAggregate(root, event);
  return event;
}

export function createNotificationTelemetryRecorder(root: string, runId: string, now = new Date()): NotificationTelemetryRecorder {
  assertString(runId, 'run_id', /^[A-Za-z0-9_-]+$/);
  pruneNotificationTelemetry(root, now);
  let toolSequence = 0;
  return {
    record(event) {
      return emitNotificationTelemetry(root, { ...event, run_id: runId, tool_sequence: ++toolSequence });
    },
  };
}

function pruneDirectory(dir: string, retentionMs: number, now: Date): number {
  if (!existsSync(dir)) return 0;
  let deleted = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || now.getTime() - stat.mtimeMs <= retentionMs) continue;
    unlinkSync(path);
    deleted++;
  }
  return deleted;
}

export function pruneNotificationTelemetry(root: string, now = new Date()): { runsDeleted: number; aggregatesDeleted: number } {
  return {
    runsDeleted: pruneDirectory(join(root, 'runs'), RUN_RETENTION_MS, now),
    aggregatesDeleted: pruneDirectory(join(root, 'aggregates'), AGGREGATE_RETENTION_MS, now),
  };
}
