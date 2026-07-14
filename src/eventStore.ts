import type { DatabaseSync } from 'node:sqlite';
import { db } from './db';

// 樂觀鎖衝突：expectedVersion 對不上 aggregate 現況。ES 的核心並發偵測。
export class ConcurrencyError extends Error {
  constructor(aggregateId: string, expected: number, actual: number) {
    super(`版本衝突：aggregate ${aggregateId} 期望 v${expected}，實際 v${actual}`);
    this.name = 'ConcurrencyError';
  }
}

// 業務規則違反（狀態機不允許的轉換、輸入驗證失敗）。對應 HTTP 400。
// 放這裡讓 workspace / member 等 aggregate 共用，避免彼此循環 import。
export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}

// 業務衝突（資源已處於某狀態，無法進行操作）。對應 HTTP 409。
export class ConflictError extends CommandError {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export interface StoredEvent {
  id: number;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  event_type: string;
  payload: unknown;
  metadata: unknown;
  occurred_at: string;
}

// ── Projection 註冊表：一個 event_type 對一個 handler ──────────────
type Projection = (event: StoredEvent, database: DatabaseSync) => void;
const projections = new Map<string, Projection>();

export function registerProjection(eventType: string, handler: Projection): void {
  if (projections.has(eventType)) throw new Error(`event_type「${eventType}」已註冊 projection`);
  projections.set(eventType, handler);
}

// 測試用：清空註冊表，避免跨測試污染這個 module 級單例。
export function resetProjections(): void {
  projections.clear();
}

function currentVersion(aggregateId: string, database: DatabaseSync): number {
  const row = database
    .prepare('SELECT MAX(aggregate_version) AS v FROM event_store WHERE aggregate_id = ?')
    .get(aggregateId) as { v: number | null };
  return row.v ?? 0; // 沒有事件 → 版本 0
}

function appendEventRecord(
  aggregateType: string,
  aggregateId: string,
  expectedVersion: number,
  eventType: string,
  payload: unknown,
  metadata: unknown,
  database: DatabaseSync,
): StoredEvent {
  const actual = currentVersion(aggregateId, database);
  if (actual !== expectedVersion) throw new ConcurrencyError(aggregateId, expectedVersion, actual);

  const version = expectedVersion + 1;
  const occurredAt = new Date().toISOString();
  const info = database
    .prepare(
      `INSERT INTO event_store
         (aggregate_type, aggregate_id, aggregate_version, event_type, payload_json, metadata_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(aggregateType, aggregateId, version, eventType, JSON.stringify(payload), JSON.stringify(metadata), occurredAt);

  const event: StoredEvent = {
    id: Number(info.lastInsertRowid),
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    aggregate_version: version,
    event_type: eventType,
    payload,
    metadata,
    occurred_at: occurredAt,
  };

  projections.get(eventType)?.(event, database);
  return event;
}

export function appendEventInTransaction(
  aggregateType: string,
  aggregateId: string,
  expectedVersion: number,
  eventType: string,
  payload: unknown,
  metadata: unknown = {},
  database = db,
): StoredEvent {
  if (!database.isTransaction) throw new Error('appendEventInTransaction requires an active transaction');
  return appendEventRecord(aggregateType, aggregateId, expectedVersion, eventType, payload, metadata, database);
}

// append 一個事件並同步跑它的 projection。expectedVersion 對不上就丟 ConcurrencyError。
export function appendEvent(
  aggregateType: string,
  aggregateId: string,
  expectedVersion: number,
  eventType: string,
  payload: unknown,
  metadata: unknown = {},
  database = db,
): StoredEvent {
  // ponytail: BEGIN IMMEDIATE 早拿 write lock，把「檢查版本 → 寫入 → projection」框成原子區塊。
  // 單 process 同步 API 其實不會真並發，但這是樂觀鎖的正解，也擋多 process 開同一個 db 檔。
  // 不可巢狀呼叫（SQLite 不支援巢狀 BEGIN）——目前 command handler 都是單層，需要時再上 savepoint。
  database.exec('BEGIN IMMEDIATE');
  try {
    const event = appendEventRecord(aggregateType, aggregateId, expectedVersion, eventType, payload, metadata, database);
    database.exec('COMMIT');
    return event;
  } catch (e) {
    database.exec('ROLLBACK');
    throw e;
  }
}

// 讀出某 aggregate 的完整事件流（依版本排序），payload / metadata 已 parse。
export function loadEvents(aggregateId: string, database = db): StoredEvent[] {
  const rows = database
    .prepare('SELECT * FROM event_store WHERE aggregate_id = ? ORDER BY aggregate_version')
    .all(aggregateId) as Array<{
    id: number;
    aggregate_type: string;
    aggregate_id: string;
    aggregate_version: number;
    event_type: string;
    payload_json: string;
    metadata_json: string;
    occurred_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    aggregate_type: r.aggregate_type,
    aggregate_id: r.aggregate_id,
    aggregate_version: r.aggregate_version,
    event_type: r.event_type,
    payload: JSON.parse(r.payload_json),
    metadata: JSON.parse(r.metadata_json),
    occurred_at: r.occurred_at,
  }));
}

// 事件流 → 現狀：reduce 掉整條流。Phase 3 的 aggregate 直接餵自己的 reducer。
export function rebuild<S>(
  aggregateId: string,
  reducer: (state: S, event: StoredEvent) => S,
  initial: S,
  database = db,
): S {
  return loadEvents(aggregateId, database).reduce(reducer, initial);
}
