// 正式環境 sim 協調器共用型別。純型別宣告，無 runtime 邏輯、不 import node:sqlite。
// 見 state.ts 取得對應的 SQLite persistence 與具型別存取函式。

export type WorkPhase =
  | 'queued'
  | 'assigned'
  | 'doing'
  | 'review'
  | 'integrating'
  | 'deployed'
  | 'done'
  | 'human_blocked';

export type ActionOutcome =
  | 'progressed'
  | 'no_change'
  | 'retryable_failure'
  | 'human_blocked';

// task_runs 一列：coordinator 對單一 task 的內部執行 checkpoint。
// workerId 只代表 coordinator 當次執行者，不是看板 assignee；看板 status／assignee／version
// 一律留在 API TaskSnapshot 與 cutover manifest，不得混入這裡。
export interface TaskRun {
  taskId: string;
  workspaceId: string;
  phase: WorkPhase;
  workerId: string | null;
  branch: string | null;
  baseSha: string | null;
  headSha: string | null;
  evidenceFingerprint: string;
  noProgressCount: number;
  ownerIntervened: boolean;
  leaseUntil: string | null;
  updatedAt: string;
}

// action_log 一列：deterministic action_key 防止同一 mutation 重送。
export type ActionStatus = 'pending' | 'completed' | 'failed';

export interface ActionLogEntry {
  actionKey: string;
  taskId: string;
  kind: string;
  status: ActionStatus;
  resultJson: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

// ci_runs 一列：以 base_sha + head_sha + commands_hash 為 key，只 cache 成功結果
// （沒有 passed 欄位——能被查到就代表當時成功過）。
export interface CiRunRecord {
  baseSha: string;
  headSha: string;
  commandsHash: string;
  output: string | null;
  recordedAt: string;
}

// completion_outbox 一列：completion_id 由呼叫端組成（例如 task_id + ':' + accepted_head_sha）。
//
// 這一列同時承擔兩個獨立階段的紀錄（任務 7 沿用任務 2 既有 schema，只加了
// doneConfirmedAt 這一欄）：
//   1) 存在本身（persist）：completion.ts 在嘗試貼留言之前就必須 enqueue 這一列，
//      作為「已經決定要完成這個 task」的 crash-recoverable 標記。
//   2) doneConfirmedAt：只有在留言／user09 notification／Review->Done PATCH 全部
//      readback 確認之後才會被寫入——`doneConfirmedAt !== null` 才代表這個 task
//      真的可以被排進 Discord batch；status／attemptCount／batchId 三者則純粹描述
//      **Discord 彙整通知**本身的 batch／重試狀態，與這個 task 有沒有真的 Done
//      無關（Discord 失敗永遠不影響已經确定的 Done）。
export type CompletionStatus = 'pending' | 'sent' | 'notify_failed';

export interface CompletionRecord {
  completionId: string;
  taskId: string;
  batchId: string | null;
  attemptCount: number;
  status: CompletionStatus;
  /** 非 null 代表留言／notification／Done PATCH 都已經 readback 確認過，可以排入 Discord batch。 */
  doneConfirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ticks 一列：單次 coordinator tick 的 heartbeat 紀錄。
export interface TickRecord {
  tickId: string;
  startedAt: string;
  endedAt: string | null;
  outcome: string | null;
  discoveredCount: number | null;
  processedCount: number | null;
  skippedCount: number | null;
  errorCount: number | null;
  error: string | null;
}

// coordinator_meta：單列 table，保存 schema version 與 cutover generation。
export interface CoordinatorMeta {
  schemaVersion: number;
  cutoverGeneration: number;
  updatedAt: string;
}
