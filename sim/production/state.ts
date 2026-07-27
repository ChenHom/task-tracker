// 正式環境 sim 協調器的可持久化 SQLite 狀態：schema、lease、checkpoint、action 冪等、
// CI cache、completion outbox 與 tick heartbeat。所有時間欄位皆為 ISO 字串。
import { DatabaseSync } from 'node:sqlite';
import type {
  ActionLogEntry,
  ActionStatus,
  CiRunRecord,
  CompletionRecord,
  CompletionStatus,
  CoordinatorMeta,
  TaskRun,
  TickRecord,
  WorkPhase,
} from './types';

// Lease TTL 固定 45 分鐘，必須嚴格大於 sim/production/git.ts（任務 6）的
// DEPLOY_WAIT_TIMEOUT_MS（35 分鐘）：一個等待部署的 tick 合法可跑超過 35 分鐘，
// 若 lease 先過期，--status 會誤判不健康，過期 lease 也可能被重新 claim，
// 導致兩個 coordinator 同時處理同一 task。這個大小關係由 production.test.ts 直接斷言。
export const LEASE_TTL_MS = 45 * 60 * 1000;

const MAX_COMPLETION_ATTEMPTS = 3;

/**
 * 開啟（或建立）coordinator 的 SQLite state 檔，並在單一 transaction 中確保
 * 所有 schema 表格存在。可安全重複呼叫（CREATE TABLE IF NOT EXISTS）。
 */
export function openCoordinatorState(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_runs (
        task_id              TEXT PRIMARY KEY,
        workspace_id         TEXT NOT NULL,
        phase                TEXT NOT NULL CHECK (phase IN (
                                 'queued', 'assigned', 'doing', 'review',
                                 'integrating', 'deployed', 'done', 'human_blocked'
                               )),
        worker_id            TEXT,
        branch               TEXT,
        base_sha             TEXT,
        head_sha             TEXT,
        evidence_fingerprint TEXT NOT NULL DEFAULT '',
        no_progress_count    INTEGER NOT NULL DEFAULT 0,
        owner_intervened     INTEGER NOT NULL DEFAULT 0,
        lease_until          TEXT,
        updated_at           TEXT NOT NULL
      );

      -- Deterministic action_key 防止同一 mutation 重送；UNIQUE PRIMARY KEY 直接擋重複 insert。
      CREATE TABLE IF NOT EXISTS action_log (
        action_key   TEXT PRIMARY KEY,
        task_id      TEXT NOT NULL,
        kind         TEXT NOT NULL,
        status       TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
        result_json  TEXT,
        error        TEXT,
        started_at   TEXT NOT NULL,
        completed_at TEXT
      );

      -- 只 cache 成功結果：沒有 passed 欄位，能查到就代表當時這組 key 成功過。
      CREATE TABLE IF NOT EXISTS ci_runs (
        base_sha      TEXT NOT NULL,
        head_sha      TEXT NOT NULL,
        commands_hash TEXT NOT NULL,
        output        TEXT,
        recorded_at   TEXT NOT NULL,
        PRIMARY KEY (base_sha, head_sha, commands_hash)
      );

      -- done_confirmed_at（任務 7 新增，nullable）：非 NULL 代表 completion.ts 已經
      -- readback 確認留言／user09 notification／Review->Done PATCH 全部成立，這個
      -- completion 才可以被排進 Discord batch（見 listUnbatchedCompletions）。
      -- status／attempt_count／batch_id 三者只描述 Discord 彙整通知本身的重試狀態，
      -- 與 done_confirmed_at 是否成立無關。
      CREATE TABLE IF NOT EXISTS completion_outbox (
        completion_id     TEXT PRIMARY KEY,
        task_id           TEXT NOT NULL,
        batch_id          TEXT,
        attempt_count     INTEGER NOT NULL DEFAULT 0,
        status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'notify_failed')),
        done_confirmed_at TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ticks (
        tick_id          TEXT PRIMARY KEY,
        started_at       TEXT NOT NULL,
        ended_at         TEXT,
        outcome          TEXT,
        discovered_count INTEGER,
        processed_count  INTEGER,
        skipped_count    INTEGER,
        error_count      INTEGER,
        error            TEXT
      );

      -- 單列 table：schema version 與 cutover generation，供 migrate.ts 的
      -- generation-bound preflight 使用。
      CREATE TABLE IF NOT EXISTS coordinator_meta (
        id                 INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version     INTEGER NOT NULL,
        cutover_generation INTEGER NOT NULL,
        updated_at         TEXT NOT NULL
      );
    `);
    db.prepare(
      `INSERT OR IGNORE INTO coordinator_meta (id, schema_version, cutover_generation, updated_at)
       VALUES (1, 1, 0, ?)`,
    ).run(new Date().toISOString());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return db;
}

// ---------------------------------------------------------------------------
// task_runs：checkpoint upsert + lease claim/release
// ---------------------------------------------------------------------------

interface TaskRunRow {
  task_id: string;
  workspace_id: string;
  phase: string;
  worker_id: string | null;
  branch: string | null;
  base_sha: string | null;
  head_sha: string | null;
  evidence_fingerprint: string;
  no_progress_count: number;
  owner_intervened: number;
  lease_until: string | null;
  updated_at: string;
}

function mapTaskRun(row: TaskRunRow): TaskRun {
  return {
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    phase: row.phase as WorkPhase,
    workerId: row.worker_id,
    branch: row.branch,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    evidenceFingerprint: row.evidence_fingerprint,
    noProgressCount: row.no_progress_count,
    ownerIntervened: row.owner_intervened === 1,
    leaseUntil: row.lease_until,
    updatedAt: row.updated_at,
  };
}

export function getTaskRun(db: DatabaseSync, taskId: string): TaskRun | null {
  const row = db.prepare('SELECT * FROM task_runs WHERE task_id = ?').get(taskId) as TaskRunRow | undefined;
  return row ? mapTaskRun(row) : null;
}

export interface TaskCheckpointInput {
  taskId: string;
  workspaceId: string;
  phase: WorkPhase;
  workerId?: string | null;
  branch?: string | null;
  baseSha?: string | null;
  headSha?: string | null;
  evidenceFingerprint: string;
  noProgressCount?: number;
  ownerIntervened?: boolean;
  leaseUntil?: string | null;
}

/** Insert-or-update 單一 task_run row（by taskId）。呼叫端決定 phase／lease 是否變動。 */
export function upsertTaskCheckpoint(db: DatabaseSync, input: TaskCheckpointInput, now: Date = new Date()): TaskRun {
  const updatedAt = now.toISOString();
  db.prepare(`
    INSERT INTO task_runs (
      task_id, workspace_id, phase, worker_id, branch, base_sha, head_sha,
      evidence_fingerprint, no_progress_count, owner_intervened, lease_until, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (task_id) DO UPDATE SET
      workspace_id         = excluded.workspace_id,
      phase                = excluded.phase,
      worker_id            = excluded.worker_id,
      branch               = excluded.branch,
      base_sha             = excluded.base_sha,
      head_sha             = excluded.head_sha,
      evidence_fingerprint = excluded.evidence_fingerprint,
      no_progress_count    = excluded.no_progress_count,
      owner_intervened     = excluded.owner_intervened,
      lease_until          = excluded.lease_until,
      updated_at           = excluded.updated_at
  `).run(
    input.taskId,
    input.workspaceId,
    input.phase,
    input.workerId ?? null,
    input.branch ?? null,
    input.baseSha ?? null,
    input.headSha ?? null,
    input.evidenceFingerprint,
    input.noProgressCount ?? 0,
    input.ownerIntervened ? 1 : 0,
    input.leaseUntil ?? null,
    updatedAt,
  );
  return getTaskRun(db, input.taskId)!;
}

export interface ClaimLeaseInput {
  taskId: string;
  workerId: string;
  now?: Date;
  leaseMs?: number;
}

/**
 * 嘗試 claim 一個執行 lease。`queued` task 一律拒絕（queued 不取得執行 lease，
 * 只能由固定 release condition 或人工決策轉出 queued 之後才可 claim）。
 * 若已有未過期 lease，回傳 null（正常的 claim 競爭，不是程式錯誤）；
 * 過期後任何 worker 都可重新 claim。
 *
 * Claim 本身是單一 atomic UPDATE：是否可 claim 完全由這條敘述的 WHERE 子句判斷
 * （`phase != 'queued'` 且 lease 已空或已過期），不是先 SELECT 再 UPDATE 的
 * check-then-act，避免兩個 process 在 lease 恰好過期的瞬間都讀到「可 claim」而雙寫。
 * 只有在 UPDATE 影響 0 列時才補一次讀取，且純粹用來分類失敗原因（不存在／queued／
 * lease 仍有效）以決定要拋錯還是回傳 null，不會反過來影響 claim 是否成立。
 */
export function claimLease(db: DatabaseSync, input: ClaimLeaseInput): TaskRun | null {
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? LEASE_TTL_MS;
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();

  const result = db
    .prepare(`
      UPDATE task_runs
      SET worker_id = ?, lease_until = ?, updated_at = ?
      WHERE task_id = ? AND phase != 'queued' AND (lease_until IS NULL OR lease_until <= ?)
    `)
    .run(input.workerId, leaseUntil, nowIso, input.taskId, nowIso);

  if (result.changes === 0) {
    const run = getTaskRun(db, input.taskId);
    if (!run) {
      throw new Error(`claimLease: no task_run checkpoint for ${input.taskId}`);
    }
    if (run.phase === 'queued') {
      throw new Error(`claimLease: task ${input.taskId} is queued and cannot be leased`);
    }
    return null; // lease 仍有效，屬正常 claim 競爭，不是程式錯誤
  }

  return getTaskRun(db, input.taskId);
}

/** 釋放一個 lease；只有目前持有者本人可以釋放。 */
export function releaseLease(db: DatabaseSync, taskId: string, workerId: string, now: Date = new Date()): TaskRun {
  const run = getTaskRun(db, taskId);
  if (!run) {
    throw new Error(`releaseLease: no task_run checkpoint for ${taskId}`);
  }
  if (run.workerId !== workerId) {
    throw new Error(`releaseLease: task ${taskId} lease is not held by ${workerId}`);
  }
  db.prepare('UPDATE task_runs SET lease_until = NULL, updated_at = ? WHERE task_id = ?').run(
    now.toISOString(),
    taskId,
  );
  return getTaskRun(db, taskId)!;
}

// ---------------------------------------------------------------------------
// action_log：begin / complete / fail
// ---------------------------------------------------------------------------

interface ActionLogRow {
  action_key: string;
  task_id: string;
  kind: string;
  status: string;
  result_json: string | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

function mapAction(row: ActionLogRow): ActionLogEntry {
  return {
    actionKey: row.action_key,
    taskId: row.task_id,
    kind: row.kind,
    status: row.status as ActionStatus,
    resultJson: row.result_json,
    error: row.error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export function getAction(db: DatabaseSync, actionKey: string): ActionLogEntry | null {
  const row = db.prepare('SELECT * FROM action_log WHERE action_key = ?').get(actionKey) as
    | ActionLogRow
    | undefined;
  return row ? mapAction(row) : null;
}

export interface BeginActionInput {
  actionKey: string;
  taskId: string;
  kind: string;
}

/**
 * 開始一筆冪等 action。重複的 action_key 會被 PRIMARY KEY 擋下並拋出（UNIQUE constraint）。
 * `queued` task 不呼叫 Owner／member 模型也不建立任何 action：對應的 task_run 若仍是
 * queued，一律拒絕開始新 action。
 */
export function beginAction(db: DatabaseSync, input: BeginActionInput, now: Date = new Date()): ActionLogEntry {
  const run = getTaskRun(db, input.taskId);
  if (run && run.phase === 'queued') {
    throw new Error(`beginAction: task ${input.taskId} is queued and cannot start an action`);
  }
  db.prepare(`
    INSERT INTO action_log (action_key, task_id, kind, status, started_at)
    VALUES (?, ?, ?, 'pending', ?)
  `).run(input.actionKey, input.taskId, input.kind, now.toISOString());
  return getAction(db, input.actionKey)!;
}

export function completeAction(
  db: DatabaseSync,
  actionKey: string,
  resultJson: string | null,
  now: Date = new Date(),
): ActionLogEntry {
  const result = db
    .prepare("UPDATE action_log SET status = 'completed', result_json = ?, completed_at = ? WHERE action_key = ?")
    .run(resultJson, now.toISOString(), actionKey);
  if (result.changes === 0) {
    throw new Error(`completeAction: unknown action_key ${actionKey}`);
  }
  return getAction(db, actionKey)!;
}

export function failAction(
  db: DatabaseSync,
  actionKey: string,
  error: string,
  now: Date = new Date(),
): ActionLogEntry {
  const result = db
    .prepare("UPDATE action_log SET status = 'failed', error = ?, completed_at = ? WHERE action_key = ?")
    .run(error, now.toISOString(), actionKey);
  if (result.changes === 0) {
    throw new Error(`failAction: unknown action_key ${actionKey}`);
  }
  return getAction(db, actionKey)!;
}

// ---------------------------------------------------------------------------
// ci_runs：lookup / store（只 cache 成功結果）
// ---------------------------------------------------------------------------

export interface StoreCiRunInput {
  baseSha: string;
  headSha: string;
  commandsHash: string;
  output?: string | null;
}

export function storeCiRun(db: DatabaseSync, input: StoreCiRunInput, now: Date = new Date()): void {
  db.prepare(`
    INSERT INTO ci_runs (base_sha, head_sha, commands_hash, output, recorded_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (base_sha, head_sha, commands_hash) DO UPDATE SET
      output      = excluded.output,
      recorded_at = excluded.recorded_at
  `).run(input.baseSha, input.headSha, input.commandsHash, input.output ?? null, now.toISOString());
}

export function lookupCiRun(
  db: DatabaseSync,
  baseSha: string,
  headSha: string,
  commandsHash: string,
): CiRunRecord | null {
  const row = db
    .prepare('SELECT * FROM ci_runs WHERE base_sha = ? AND head_sha = ? AND commands_hash = ?')
    .get(baseSha, headSha, commandsHash) as
    | { base_sha: string; head_sha: string; commands_hash: string; output: string | null; recorded_at: string }
    | undefined;
  if (!row) return null;
  return {
    baseSha: row.base_sha,
    headSha: row.head_sha,
    commandsHash: row.commands_hash,
    output: row.output,
    recordedAt: row.recorded_at,
  };
}

// ---------------------------------------------------------------------------
// completion_outbox：enqueue / attempt（attempt 上限 3 次）
// ---------------------------------------------------------------------------

interface CompletionRow {
  completion_id: string;
  task_id: string;
  batch_id: string | null;
  attempt_count: number;
  status: string;
  done_confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapCompletion(row: CompletionRow): CompletionRecord {
  return {
    completionId: row.completion_id,
    taskId: row.task_id,
    batchId: row.batch_id,
    attemptCount: row.attempt_count,
    status: row.status as CompletionStatus,
    doneConfirmedAt: row.done_confirmed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getCompletion(db: DatabaseSync, completionId: string): CompletionRecord | null {
  const row = db.prepare('SELECT * FROM completion_outbox WHERE completion_id = ?').get(completionId) as
    | CompletionRow
    | undefined;
  return row ? mapCompletion(row) : null;
}

export interface EnqueueCompletionInput {
  completionId: string;
  taskId: string;
  batchId?: string | null;
}

/** 冪等 enqueue：同一 completionId 重複呼叫不會重置 attempt_count／status。 */
export function enqueueCompletion(
  db: DatabaseSync,
  input: EnqueueCompletionInput,
  now: Date = new Date(),
): CompletionRecord {
  const nowIso = now.toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO completion_outbox
      (completion_id, task_id, batch_id, attempt_count, status, created_at, updated_at)
    VALUES (?, ?, ?, 0, 'pending', ?, ?)
  `).run(input.completionId, input.taskId, input.batchId ?? null, nowIso, nowIso);
  return getCompletion(db, input.completionId)!;
}

/**
 * 記錄一次 completion 傳送嘗試。最多 3 次：第 3 次仍失敗就轉為 `notify_failed`，
 * 之後任何一次呼叫（無論 outcome）都會被拒絕——已解決的 completion 不得再重試。
 */
export function recordCompletionAttempt(
  db: DatabaseSync,
  completionId: string,
  outcome: 'sent' | 'failed',
  now: Date = new Date(),
): CompletionRecord {
  const existing = getCompletion(db, completionId);
  if (!existing) {
    throw new Error(`recordCompletionAttempt: unknown completion_id ${completionId}`);
  }
  if (existing.status !== 'pending') {
    throw new Error(`recordCompletionAttempt: ${completionId} already resolved as ${existing.status}`);
  }
  const attemptCount = existing.attemptCount + 1;
  const status: CompletionStatus =
    outcome === 'sent' ? 'sent' : attemptCount >= MAX_COMPLETION_ATTEMPTS ? 'notify_failed' : 'pending';
  db.prepare('UPDATE completion_outbox SET attempt_count = ?, status = ?, updated_at = ? WHERE completion_id = ?').run(
    attemptCount,
    status,
    now.toISOString(),
    completionId,
  );
  return getCompletion(db, completionId)!;
}

/**
 * 標記一筆 completion 的留言／user09 notification／Review->Done PATCH 都已經
 * readback 確認（任務 7：completion.ts 唯一會呼叫這個函式的地方）。只影響
 * `doneConfirmedAt`，不動 Discord 重試用的 status／attempt_count／batch_id。
 */
export function markCompletionDone(db: DatabaseSync, completionId: string, now: Date = new Date()): CompletionRecord {
  const nowIso = now.toISOString();
  const result = db
    .prepare('UPDATE completion_outbox SET done_confirmed_at = ?, updated_at = ? WHERE completion_id = ?')
    .run(nowIso, nowIso, completionId);
  if (result.changes === 0) {
    throw new Error(`markCompletionDone: unknown completion_id ${completionId}`);
  }
  return getCompletion(db, completionId)!;
}

// ---------------------------------------------------------------------------
// completion_outbox：Discord batch（任務 7 步驟 4）
// ---------------------------------------------------------------------------

/**
 * 所有「Done 已確認、但還沒被併進任何 Discord batch」的 completion——這正是
 * 「自上次 batch 形成以來新完成的 task」的集合，用來讓 coordinator 在 tick 結束時
 * 把它們合併成單一新 batch_id。
 */
export function listUnbatchedCompletions(db: DatabaseSync): CompletionRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM completion_outbox
       WHERE batch_id IS NULL AND done_confirmed_at IS NOT NULL
       ORDER BY created_at, completion_id`,
    )
    .all() as unknown as CompletionRow[];
  return rows.map(mapCompletion);
}

/**
 * 把一組（目前都還沒有 batch_id 的）completion 併成單一 batch_id。呼叫端必須
 * 保證這組 id 全部來自同一次 `listUnbatchedCompletions()` 讀取——batch 一旦形成
 * 就是穩定、封閉的集合，之後新完成的 task 只會形成下一個新 batch，不會被塞進
 * 這個已經存在的 batch。
 */
export function assignBatch(
  db: DatabaseSync,
  completionIds: readonly string[],
  batchId: string,
  now: Date = new Date(),
): CompletionRecord[] {
  if (completionIds.length === 0) {
    throw new Error('assignBatch: completionIds must be non-empty');
  }
  const nowIso = now.toISOString();
  const stmt = db.prepare(
    'UPDATE completion_outbox SET batch_id = ?, updated_at = ? WHERE completion_id = ? AND batch_id IS NULL',
  );
  for (const id of completionIds) {
    const result = stmt.run(batchId, nowIso, id);
    if (result.changes === 0) {
      throw new Error(`assignBatch: completion ${id} not found, or already belongs to a batch`);
    }
  }
  return completionIds.map((id) => getCompletion(db, id)!);
}

/** 一個 batch 底下的所有 completion（用來組 Discord 彙整訊息的 taskId 清單）。 */
export function getCompletionsByBatch(db: DatabaseSync, batchId: string): CompletionRecord[] {
  const rows = db
    .prepare('SELECT * FROM completion_outbox WHERE batch_id = ? ORDER BY completion_id')
    .all(batchId) as unknown as CompletionRow[];
  return rows.map(mapCompletion);
}

/** 目前仍 `pending`（尚未 sent、也還沒到達 notify_failed）的 batch id，供每個 tick 決定要重試誰。 */
export function listPendingBatchIds(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT batch_id AS batch_id FROM completion_outbox
       WHERE status = 'pending' AND batch_id IS NOT NULL
       ORDER BY batch_id`,
    )
    .all() as { batch_id: string }[];
  return rows.map((row) => row.batch_id);
}

/**
 * 對一整個 batch 記錄一次 Discord 傳送嘗試：batch 底下每一筆 completion 都套用
 * 同一個 outcome（沿用 `recordCompletionAttempt` 既有的 3 次上限／notify_failed
 * 轉換邏輯，不重寫一份），讓同一個 batch 內的 attempt_count／status 永遠一致。
 */
export function recordBatchAttempt(
  db: DatabaseSync,
  batchId: string,
  outcome: 'sent' | 'failed',
  now: Date = new Date(),
): CompletionRecord[] {
  const rows = getCompletionsByBatch(db, batchId);
  if (rows.length === 0) {
    throw new Error(`recordBatchAttempt: no completion_outbox rows for batch ${batchId}`);
  }
  return rows.map((row) => recordCompletionAttempt(db, row.completionId, outcome, now));
}

// ---------------------------------------------------------------------------
// coordinator_meta：schema version／cutover generation（任務 9：
// sim/production/migrate.ts 的 generation-bound preflight 用它判斷 manifest
// 是否仍是「最新一次」——見該檔頭註解。這個 table 從任務 2 就存在（單列、
// INSERT OR IGNORE 預設 cutover_generation=0），這裡只是任務 9 第一次真正需要
// 讀寫它時才補上的存取函式，不重新設計 schema。
// ---------------------------------------------------------------------------

interface CoordinatorMetaRow {
  schema_version: number;
  cutover_generation: number;
  updated_at: string;
}

export function getCoordinatorMeta(db: DatabaseSync): CoordinatorMeta {
  const row = db
    .prepare('SELECT schema_version, cutover_generation, updated_at FROM coordinator_meta WHERE id = 1')
    .get() as CoordinatorMetaRow | undefined;
  if (!row) {
    throw new Error('getCoordinatorMeta: coordinator_meta row missing (db not opened via openCoordinatorState?)');
  }
  return { schemaVersion: row.schema_version, cutoverGeneration: row.cutover_generation, updatedAt: row.updated_at };
}

/** 把 cutover generation 前進到一個新值。呼叫端（migrate.ts）負責保證單調遞增。 */
export function recordCutoverGeneration(db: DatabaseSync, generation: number, now: Date = new Date()): CoordinatorMeta {
  const result = db
    .prepare('UPDATE coordinator_meta SET cutover_generation = ?, updated_at = ? WHERE id = 1')
    .run(generation, now.toISOString());
  if (result.changes === 0) {
    throw new Error('recordCutoverGeneration: coordinator_meta row missing (db not opened via openCoordinatorState?)');
  }
  return getCoordinatorMeta(db);
}

// ---------------------------------------------------------------------------
// ticks：begin / end heartbeat
// ---------------------------------------------------------------------------

interface TickRow {
  tick_id: string;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  discovered_count: number | null;
  processed_count: number | null;
  skipped_count: number | null;
  error_count: number | null;
  error: string | null;
}

function mapTick(row: TickRow): TickRecord {
  return {
    tickId: row.tick_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    outcome: row.outcome,
    discoveredCount: row.discovered_count,
    processedCount: row.processed_count,
    skippedCount: row.skipped_count,
    errorCount: row.error_count,
    error: row.error,
  };
}

export function getTick(db: DatabaseSync, tickId: string): TickRecord | null {
  const row = db.prepare('SELECT * FROM ticks WHERE tick_id = ?').get(tickId) as TickRow | undefined;
  return row ? mapTick(row) : null;
}

export function beginTick(db: DatabaseSync, tickId: string, now: Date = new Date()): TickRecord {
  db.prepare('INSERT INTO ticks (tick_id, started_at) VALUES (?, ?)').run(tickId, now.toISOString());
  return getTick(db, tickId)!;
}

export interface EndTickInput {
  tickId: string;
  outcome: string;
  discoveredCount: number;
  processedCount: number;
  skippedCount: number;
  errorCount: number;
  error?: string | null;
}

export function endTick(db: DatabaseSync, input: EndTickInput, now: Date = new Date()): TickRecord {
  const result = db
    .prepare(`
      UPDATE ticks SET
        ended_at         = ?,
        outcome          = ?,
        discovered_count = ?,
        processed_count  = ?,
        skipped_count    = ?,
        error_count      = ?,
        error            = ?
      WHERE tick_id = ?
    `)
    .run(
      now.toISOString(),
      input.outcome,
      input.discoveredCount,
      input.processedCount,
      input.skippedCount,
      input.errorCount,
      input.error ?? null,
      input.tickId,
    );
  if (result.changes === 0) {
    throw new Error(`endTick: unknown tick_id ${input.tickId}`);
  }
  return getTick(db, input.tickId)!;
}
