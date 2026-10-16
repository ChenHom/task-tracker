import type { DatabaseSync } from 'node:sqlite';

// ponytail: idempotent CREATE TABLE IF NOT EXISTS, run at startup.
// 換成正式 migration 工具，等 schema 開始需要「改欄位/回滾」再說。
export function runMigrations(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON;'); // 每個連線都要開，否則 FK / CASCADE 無效
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL CHECK (trim(name) <> ''),
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    -- 登入嘗試紀錄（成功/失敗都記）。email 記「嘗試的」值，可能對不到任何 user。
    -- user_id 用 SET NULL：user 被刪也保留審計軌跡。
    CREATE TABLE IF NOT EXISTS login_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      email      TEXT NOT NULL,
      user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
      success    INTEGER NOT NULL,
      ip         TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 單一 event store（Workspace / Member / Task 全進這張）。
    -- UNIQUE(aggregate_id, aggregate_version)：樂觀鎖的 DB 層防線，同一版本只能寫一次。
    CREATE TABLE IF NOT EXISTS event_store (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      aggregate_type    TEXT NOT NULL,
      aggregate_id      TEXT NOT NULL,
      aggregate_version INTEGER NOT NULL,
      event_type        TEXT NOT NULL,
      payload_json      TEXT NOT NULL,
      metadata_json     TEXT NOT NULL,
      occurred_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (aggregate_id, aggregate_version)
    );

    -- Read model：由 workspace.* 事件投影而來，查詢只讀這張、不碰 event_store。
    CREATE TABLE IF NOT EXISTS workspaces_read_model (
      workspace_id TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      status       TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT
    );

    -- 權限來源：所有角色檢查都查這張。只放「已 joined」的成員（invited 未接受不進來）。
    CREATE TABLE IF NOT EXISTS workspace_members_read_model (
      workspace_id TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      role         TEXT NOT NULL,
      joined_at    TEXT NOT NULL,
      PRIMARY KEY (workspace_id, user_id)
    );

    -- Task read model：由 task.* 事件投影。version 供樂觀鎖 / UI 顯示。deleted 事件直接移除該列。
    CREATE TABLE IF NOT EXISTS tasks_read_model (
      task_id     TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id  TEXT,
      goal_id     TEXT,
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL,
      priority    TEXT NOT NULL,
      assignee_id TEXT,
      due_at      TEXT,
      done_at     TEXT,
      version     INTEGER NOT NULL,
      updated_at  TEXT,
      deployment_not_required INTEGER NOT NULL DEFAULT 0
    );

    -- Project：DESIGN 指定不走 ES，這張就是主表（傳統 CRUD 直接讀寫，無 event_store / projection）。
    CREATE TABLE IF NOT EXISTS projects_read_model (
      project_id   TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name         TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'active',
      target_repo  TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS goals_read_model (
      goal_id               TEXT PRIMARY KEY,
      workspace_id          TEXT NOT NULL,
      project_id            TEXT NOT NULL,
      parent_goal_id        TEXT,
      source                TEXT NOT NULL,
      objective             TEXT NOT NULL,
      success_criteria      TEXT NOT NULL,
      data_scope            TEXT NOT NULL DEFAULT '',
      status                TEXT NOT NULL,
      discussion_phase      TEXT,
      revision              INTEGER NOT NULL,
      created_by            TEXT NOT NULL,
      owner_agent_id        TEXT NOT NULL,
      paused_from_status    TEXT,
      paused_from_phase     TEXT,
      blocked_from_status   TEXT,
      blocked_from_phase    TEXT,
      pause_requested       INTEGER NOT NULL DEFAULT 0,
      evidence_refs_json    TEXT NOT NULL DEFAULT '[]',
      version               INTEGER NOT NULL,
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS goals_workspace_idx ON goals_read_model (workspace_id, created_at, goal_id);
    CREATE INDEX IF NOT EXISTS goals_project_idx ON goals_read_model (project_id, created_at, goal_id);
    CREATE UNIQUE INDEX IF NOT EXISTS goals_one_active_autonomous_per_workspace
      ON goals_read_model (workspace_id)
      WHERE source <> 'human' AND status NOT IN ('Done', 'Cancelled');

    CREATE TABLE IF NOT EXISTS repo_leases (
      target_repo TEXT PRIMARY KEY,
      goal_id     TEXT NOT NULL UNIQUE,
      acquired_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS goal_worktrees (
      worktree_path TEXT PRIMARY KEY,
      goal_id       TEXT NOT NULL,
      target_repo   TEXT NOT NULL,
      dirty         INTEGER NOT NULL DEFAULT 0,
      unmerged      INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      agent_id              TEXT PRIMARY KEY,
      user_id               TEXT NOT NULL UNIQUE,
      email                 TEXT NOT NULL UNIQUE,
      name                  TEXT NOT NULL,
      role                  TEXT NOT NULL,
      skill_profile_json    TEXT NOT NULL,
      repo_access_json      TEXT NOT NULL DEFAULT '["*"]',
      primary_adapter       TEXT NOT NULL,
      primary_model         TEXT NOT NULL,
      effort                TEXT,
      fallback_adapter      TEXT,
      fallback_model        TEXT,
      status                TEXT NOT NULL,
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS goal_heartbeats (
      heartbeat_id TEXT PRIMARY KEY,
      scope_id     TEXT NOT NULL,
      goal_id      TEXT,
      phase        TEXT NOT NULL,
      agent_id     TEXT NOT NULL,
      revision     INTEGER NOT NULL,
      trigger_ref  TEXT NOT NULL,
      status       TEXT NOT NULL,
      last_processed_seq INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      UNIQUE (scope_id, phase, agent_id, revision, trigger_ref)
    );

    CREATE TABLE IF NOT EXISTS goal_runs (
      run_id                   TEXT PRIMARY KEY,
      heartbeat_id             TEXT NOT NULL,
      goal_id                  TEXT,
      task_id                  TEXT,
      agent_id                 TEXT NOT NULL,
      phase                    TEXT NOT NULL,
      adapter                  TEXT NOT NULL,
      model                    TEXT NOT NULL,
      attempt                  TEXT NOT NULL,
      estimated_input_tokens   INTEGER NOT NULL,
      estimated_output_tokens  INTEGER NOT NULL,
      estimate_basis           TEXT NOT NULL,
      estimate_confidence      TEXT NOT NULL,
      quota_snapshot_json      TEXT NOT NULL,
      source_refs_json         TEXT NOT NULL DEFAULT '[]',
      session_id               TEXT,
      actual_input_tokens      INTEGER,
      actual_output_tokens     INTEGER,
      actual_total_tokens      INTEGER,
      actual_cost              REAL,
      status                   TEXT NOT NULL,
      outcome                  TEXT,
      error_category           TEXT,
      evidence_ref             TEXT,
      side_effect_state        TEXT,
      started_at               TEXT,
      ended_at                 TEXT,
      created_at               TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS goal_runs_goal_idx ON goal_runs (goal_id, created_at, run_id);
    CREATE UNIQUE INDEX IF NOT EXISTS goal_runs_one_attempt ON goal_runs (heartbeat_id, attempt);

    CREATE TABLE IF NOT EXISTS goal_participations (
      participation_id TEXT PRIMARY KEY,
      goal_id           TEXT NOT NULL,
      revision          INTEGER NOT NULL,
      agent_id          TEXT NOT NULL,
      reason            TEXT NOT NULL,
      assignment        TEXT NOT NULL,
      selected_load     INTEGER NOT NULL,
      created_at        TEXT NOT NULL,
      UNIQUE (goal_id, revision, agent_id)
    );

    CREATE TABLE IF NOT EXISTS goal_contributions (
      contribution_id TEXT PRIMARY KEY,
      goal_id         TEXT NOT NULL,
      revision        INTEGER NOT NULL,
      round           TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      stance          TEXT NOT NULL,
      claim           TEXT NOT NULL,
      reason          TEXT NOT NULL,
      evidence_json   TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      UNIQUE (goal_id, revision, round, agent_id)
    );

    CREATE TABLE IF NOT EXISTS goal_rounds (
      goal_id    TEXT NOT NULL,
      revision   INTEGER NOT NULL,
      round      TEXT NOT NULL,
      status     TEXT NOT NULL,
      reason     TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (goal_id, revision, round)
    );

    CREATE TABLE IF NOT EXISTS goal_reconciliations (
      goal_id    TEXT NOT NULL,
      revision   INTEGER NOT NULL,
      reason     TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (goal_id, revision)
    );

    CREATE TABLE IF NOT EXISTS goal_syntheses (
      goal_id       TEXT NOT NULL,
      revision      INTEGER NOT NULL,
      summary       TEXT NOT NULL,
      task_plans_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      decision_rationale TEXT NOT NULL DEFAULT '',
      change_scope TEXT NOT NULL DEFAULT '',
      uncertainties_json TEXT NOT NULL DEFAULT '[]',
      archive_task_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at    TEXT NOT NULL,
      PRIMARY KEY (goal_id, revision)
    );

    CREATE TABLE IF NOT EXISTS goal_verifications (
      goal_id       TEXT NOT NULL,
      revision      INTEGER NOT NULL,
      passed        INTEGER NOT NULL,
      evidence_json TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      PRIMARY KEY (goal_id, revision)
    );

    CREATE TABLE IF NOT EXISTS goal_followups (
      parent_goal_id      TEXT NOT NULL,
      success_criteria    TEXT NOT NULL,
      evidence_fingerprint TEXT NOT NULL,
      child_goal_id       TEXT NOT NULL,
      created_at          TEXT NOT NULL,
      UNIQUE (parent_goal_id, success_criteria, evidence_fingerprint)
    );

    CREATE TABLE IF NOT EXISTS goal_followup_candidates (
      candidate_id         TEXT PRIMARY KEY,
      parent_goal_id       TEXT NOT NULL,
      workspace_id         TEXT NOT NULL,
      project_id           TEXT NOT NULL,
      objective            TEXT NOT NULL,
      success_criteria     TEXT NOT NULL,
      reason               TEXT NOT NULL,
      evidence_json        TEXT NOT NULL,
      evidence_fingerprint TEXT NOT NULL,
      created_at           TEXT NOT NULL,
      UNIQUE (workspace_id, project_id, success_criteria, evidence_fingerprint)
    );

    CREATE TABLE IF NOT EXISTS goal_preemptions (
      human_goal_id      TEXT NOT NULL,
      autonomous_goal_id TEXT NOT NULL,
      kind               TEXT NOT NULL,
      created_at         TEXT NOT NULL,
      resumed_at         TEXT,
      PRIMARY KEY (human_goal_id, autonomous_goal_id)
    );

    CREATE TABLE IF NOT EXISTS goal_patrol_evidence (
      workspace_id TEXT PRIMARY KEY,
      fingerprint  TEXT NOT NULL,
      checked_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS goal_patrol_checks (
      heartbeat_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      fingerprint  TEXT NOT NULL,
      skip_reason  TEXT,
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_delivery_evidence (
      task_id     TEXT NOT NULL,
      kind        TEXT NOT NULL,
      ref         TEXT NOT NULL,
      detail      TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      UNIQUE (task_id, kind, ref)
    );

    CREATE TABLE IF NOT EXISTS goal_stage_outputs (
      heartbeat_id TEXT PRIMARY KEY,
      output_json  TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );

    -- Comment：任務留言，同樣傳統 CRUD（不走 ES）。權限經 task → workspace 查；user_id 為留言作者。
    CREATE TABLE IF NOT EXISTS comments (
      comment_id TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ''
    );

    -- Notification：comment mention 的收信夾。由 notification.* 事件投影而來。
    CREATE TABLE IF NOT EXISTS notifications_read_model (
      notification_id  TEXT PRIMARY KEY,
      recipient_id     TEXT NOT NULL,
      source_task_id   TEXT NOT NULL,
      source_goal_id   TEXT,
      source_comment_id TEXT NOT NULL,
      snippet          TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      read_at          TEXT
    );

    -- Attachment：metadata 進 DB，實體檔在 data/attachments/。original_name 只供顯示（不信任、不當路徑）；
    -- stored_name 是伺服器生成的 uuid，才是磁碟上的真檔名。
    CREATE TABLE IF NOT EXISTS attachments (
      attachment_id TEXT PRIMARY KEY,
      task_id       TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_name   TEXT NOT NULL,
      mime_type     TEXT NOT NULL,
      size          INTEGER NOT NULL
    );

    -- 忘記密碼：token 本身不落地存明碼，只存 SHA-256 hex digest（token 是高熵隨機值，
    -- 用快速雜湊即可做等值查找；跟 password_hash 用 scrypt 是不同考量，見 auth.ts 註解）。
    -- used_at 為 NULL 代表尚未使用；一次性使用，用過就標記，不可重放。
    CREATE TABLE IF NOT EXISTS password_resets (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at    TEXT
    );
  `);

  try {
    db.prepare('ALTER TABLE tasks_read_model ADD COLUMN updated_at TEXT').run();
  } catch {
    // 忽略如果欄位已存在
  }

  try {
    db.prepare('ALTER TABLE tasks_read_model ADD COLUMN done_at TEXT').run();
  } catch {
    // 忽略如果欄位已存在
  }

  try {
    db.prepare('ALTER TABLE tasks_read_model ADD COLUMN goal_id TEXT').run();
  } catch {
    // 忽略如果欄位已存在
  }

  try {
    db.prepare('ALTER TABLE goals_read_model ADD COLUMN pause_requested INTEGER NOT NULL DEFAULT 0').run();
  } catch {
    // 冪等 migration：欄位已存在時略過。
  }

  try {
    db.prepare('ALTER TABLE goal_heartbeats ADD COLUMN last_processed_seq INTEGER NOT NULL DEFAULT 0').run();
  } catch {
    // 冪等 migration：欄位已存在時略過。
  }

  // 舊資料從 event store 回填真正進入 Done 的時間，不用 updated_at（後續欄位修改會改它）。
  db.prepare(
    `UPDATE tasks_read_model
       SET done_at = (
         SELECT occurred_at FROM event_store
          WHERE aggregate_id = tasks_read_model.task_id
            AND (
              (event_type = 'task.status_changed' AND json_extract(payload_json, '$.status') = 'Done')
              OR event_type = 'task.main_discussion_concluded'
            )
          ORDER BY aggregate_version DESC LIMIT 1
       )
     WHERE status = 'Done' AND done_at IS NULL`,
  ).run();

  try {
    db.prepare("ALTER TABLE comments ADD COLUMN created_at TEXT NOT NULL DEFAULT ''").run();
  } catch {
    // 忽略如果欄位已存在
  }

  try {
    db.prepare("ALTER TABLE users ADD COLUMN name TEXT NOT NULL DEFAULT '未命名'").run();
  } catch {
    // 忽略如果欄位已存在
  }

  try {
    db.prepare('ALTER TABLE workspaces_read_model ADD COLUMN updated_at TEXT').run();
  } catch {
    // 忽略如果欄位已存在
  }

  try {
    db.prepare('ALTER TABLE notifications_read_model ADD COLUMN read_at TEXT').run();
  } catch {
    // 忽略如果欄位已存在
  }

  try {
    db.prepare('ALTER TABLE notifications_read_model ADD COLUMN source_goal_id TEXT').run();
  } catch {
    // 冪等 migration：欄位已存在時略過。
  }

  try {
    db.prepare("ALTER TABLE goals_read_model ADD COLUMN data_scope TEXT NOT NULL DEFAULT ''").run();
  } catch {
    // 冪等 migration：欄位已存在時略過。
  }

  try {
    db.prepare('ALTER TABLE goal_runs ADD COLUMN actual_total_tokens INTEGER').run();
  } catch {
    // 冪等 migration：欄位已存在時略過。
  }

  try {
    db.prepare(`ALTER TABLE agents ADD COLUMN repo_access_json TEXT NOT NULL DEFAULT '["*"]'`).run();
  } catch {
    // 冪等 migration：欄位已存在時略過。
  }

  try {
    db.prepare('ALTER TABLE agents ADD COLUMN effort TEXT').run();
  } catch {
    // 冪等 migration：欄位已存在時略過。
  }

  try {
    db.prepare("ALTER TABLE goal_runs ADD COLUMN source_refs_json TEXT NOT NULL DEFAULT '[]'").run();
  } catch {
    // 冪等 migration：欄位已存在時略過。
  }
  for (const sql of [
    'ALTER TABLE goal_runs ADD COLUMN session_id TEXT',
    'ALTER TABLE tasks_read_model ADD COLUMN deployment_not_required INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE goal_syntheses ADD COLUMN decision_rationale TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE goal_syntheses ADD COLUMN change_scope TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE goal_syntheses ADD COLUMN uncertainties_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE goal_syntheses ADD COLUMN archive_task_ids_json TEXT NOT NULL DEFAULT '[]'",
  ]) {
    try { db.prepare(sql).run(); } catch { /* 冪等 migration */ }
  }

  for (const sql of [
    "ALTER TABLE projects_read_model ADD COLUMN description TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE projects_read_model ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
    'ALTER TABLE projects_read_model ADD COLUMN target_repo TEXT',
    'ALTER TABLE projects_read_model ADD COLUMN created_at TEXT',
    'ALTER TABLE projects_read_model ADD COLUMN updated_at TEXT',
  ]) {
    try {
      db.prepare(sql).run();
    } catch {
      // 冪等 migration：欄位已存在時略過。
    }
  }
  db.prepare(
    `UPDATE projects_read_model
        SET description = COALESCE(description, ''),
            status = COALESCE(status, 'active'),
            created_at = COALESCE(created_at, datetime('now')),
            updated_at = COALESCE(updated_at, created_at, datetime('now'))`,
  ).run();

  // 主討論等待窗口已移除（討論不再有期限閘門），既有資料庫留著的舊表直接丟棄。
  db.exec('DROP TABLE IF EXISTS main_discussion_windows');
}
