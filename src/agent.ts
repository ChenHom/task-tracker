import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { db } from './db';
import { getUserIdByEmail } from './auth';
import { CommandError } from './eventStore';

export type AgentRole = 'owner' | 'member';
export type AgentStatus = 'active' | 'paused' | 'error';
export type AgentAdapterName = 'claude' | 'codex' | 'agy';
// 推理強度只套用在 primary route；null = 用 CLI 預設。
export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

export interface AgentRow {
  agent_id: string;
  user_id: string;
  email: string;
  name: string;
  role: AgentRole;
  skill_profile_json: string;
  repo_access_json: string;
  primary_adapter: AgentAdapterName;
  primary_model: string;
  effort: AgentEffort | null;
  fallback_adapter: AgentAdapterName | null;
  fallback_model: string | null;
  status: AgentStatus;
  created_at: string;
  updated_at: string;
}

interface AgentDefinition {
  email: string;
  name: string;
  role: AgentRole;
  summary: string;
  skills: string[];
  primaryAdapter: AgentAdapterName;
  primaryModel: string;
  fallbackAdapter?: AgentAdapterName;
  fallbackModel?: string;
}

const DEFINITIONS: readonly AgentDefinition[] = [
  {
    email: 'user01@test.local', name: '阿哲', role: 'owner',
    summary: 'Goal scoping, synthesis, review and delivery decisions', skills: ['planning', 'review', 'delivery'],
    primaryAdapter: 'claude', primaryModel: 'claude-sonnet-5-5',
    fallbackAdapter: 'codex', fallbackModel: 'gpt-5.6-sol',
  },
  {
    email: 'user02@test.local', name: '小美', role: 'member',
    summary: 'Small auth and security fixes with focused tests', skills: ['auth', 'security', 'api', 'tests'],
    primaryAdapter: 'codex', primaryModel: 'gpt-5.6-sol',
  },
  {
    email: 'user03@test.local', name: '阿凱', role: 'member',
    summary: 'Cross-file and architectural implementation', skills: ['architecture', 'backend', 'state'],
    primaryAdapter: 'codex', primaryModel: 'gpt-5.6-terra',
  },
  {
    email: 'user04@test.local', name: '婷婷', role: 'member',
    summary: 'File IO and defensive implementation', skills: ['file', 'io', 'backend'],
    primaryAdapter: 'codex', primaryModel: 'gpt-5.6-luna',
  },
  {
    email: 'user05@test.local', name: '大熊', role: 'member',
    summary: 'Small changes with current-state verification', skills: ['verification', 'tests', 'maintenance'],
    primaryAdapter: 'codex', primaryModel: 'gpt-5.6-luna',
  },
  {
    email: 'user06@test.local', name: '小芸', role: 'member',
    summary: 'Frontend interaction, responsive UI and browser verification', skills: ['frontend', 'ui', 'browser', 'responsive'],
    primaryAdapter: 'codex', primaryModel: 'gpt-5.6-sol',
  },
];

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new CommandError(`${field} 不可為空`);
  return value.trim();
}

function adapter(value: unknown, field: string): AgentAdapterName {
  if (value !== 'claude' && value !== 'codex' && value !== 'agy') throw new CommandError(`${field} adapter 不合法`);
  return value;
}

export function syncAgents(database = db): void {
  const insert = database.prepare(
    `INSERT INTO agents
       (agent_id, user_id, email, name, role, skill_profile_json, repo_access_json, primary_adapter, primary_model,
        fallback_adapter, fallback_model, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '["*"]', ?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT(agent_id) DO NOTHING`,
  );
  for (const definition of DEFINITIONS) {
    const userId = getUserIdByEmail(definition.email, database);
    if (!userId) continue;
    const now = new Date().toISOString();
    insert.run(
      userId, userId, definition.email, definition.name, definition.role,
      JSON.stringify({ summary: definition.summary, skills: definition.skills }),
      definition.primaryAdapter, definition.primaryModel,
      definition.fallbackAdapter ?? null, definition.fallbackModel ?? null,
      now, now,
    );
  }
}

export function getAgent(agentId: string, database = db): AgentRow | null {
  return (database.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId) as AgentRow | undefined) ?? null;
}

export function listAgents(database = db): AgentRow[] {
  return database.prepare('SELECT * FROM agents ORDER BY email').all() as unknown as AgentRow[];
}

export function listWorkspaceAgents(workspaceId: string, database = db): AgentRow[] {
  return database.prepare(
    `SELECT agents.* FROM agents
       JOIN workspace_members_read_model members ON members.user_id = agents.user_id
      WHERE members.workspace_id = ?
      ORDER BY agents.email`,
  ).all(workspaceId) as unknown as AgentRow[];
}

export function listWorkspaceAgentSummaries(workspaceId: string, database = db): Array<AgentRow & Record<string, unknown>> {
  void workspaceId;
  return listAgents(database).map((agent) => {
    const usage = database.prepare(
      `SELECT MAX(created_at) AS latest_run_at,
              COALESCE(SUM(actual_input_tokens), 0) AS total_input_tokens,
              COALESCE(SUM(COALESCE(actual_output_tokens, actual_total_tokens)), 0) AS total_output_tokens
         FROM goal_runs WHERE agent_id = ?`,
    ).get(agent.agent_id) as Record<string, unknown>;
    const current = database.prepare(
      `SELECT goal_id, task_id FROM goal_runs
        WHERE agent_id = ? AND status IN ('pending', 'running') ORDER BY rowid DESC LIMIT 1`,
    ).get(agent.agent_id) as { goal_id: string | null; task_id: string | null } | undefined;
    const latestRun = database.prepare(
      `SELECT run_id, phase, adapter, model, attempt, status, error_category, created_at
         FROM goal_runs WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1`,
    ).get(agent.agent_id) as Record<string, unknown> | undefined;
    const latestPreflight = database.prepare(
      `SELECT run_id, phase, adapter, model, status, error_category, created_at
         FROM goal_runs WHERE agent_id = ? AND error_category = 'preflight' ORDER BY rowid DESC LIMIT 1`,
    ).get(agent.agent_id) as Record<string, unknown> | undefined;
    const counts = database.prepare(
      `SELECT COALESCE(SUM(CASE WHEN attempt = 'fallback' THEN 1 ELSE 0 END), 0) AS fallback_count,
              COALESCE(SUM(CASE WHEN actual_input_tokens IS NULL AND actual_output_tokens IS NULL
                                 AND actual_total_tokens IS NULL
                                 AND status IN ('succeeded', 'failed', 'uncertain') THEN 1 ELSE 0 END), 0) AS unknown_usage_count
         FROM goal_runs WHERE agent_id = ?`,
    ).get(agent.agent_id) as Record<string, unknown>;
    return {
      ...agent, ...usage, ...counts,
      current_goal_id: current?.goal_id ?? null, current_task_id: current?.task_id ?? null,
      latest_run: latestRun ?? null, latest_preflight: latestPreflight ?? null,
    };
  });
}

export function eligibleMemberAgents(database = db): AgentRow[] {
  return database.prepare("SELECT * FROM agents WHERE role = 'member' AND status = 'active' ORDER BY email")
    .all() as unknown as AgentRow[];
}

export interface AgentPatch {
  status?: unknown;
  primaryAdapter?: unknown;
  primaryModel?: unknown;
  effort?: unknown;
  fallbackAdapter?: unknown;
  fallbackModel?: unknown;
  repoAccess?: unknown;
}

export function updateAgent(agentId: string, patch: AgentPatch, database = db): void {
  const current = getAgent(agentId, database);
  if (!current) throw new CommandError('agent 不存在');
  const keys = Object.keys(patch);
  if (keys.length === 0 || keys.some((key) => !['status', 'primaryAdapter', 'primaryModel', 'effort', 'fallbackAdapter', 'fallbackModel', 'repoAccess'].includes(key))) {
    throw new CommandError('不支援的 Agent PATCH 欄位');
  }

  let status = current.status;
  let primaryAdapter = current.primary_adapter;
  let primaryModel = current.primary_model;
  let effort = current.effort;
  let fallbackAdapter = current.fallback_adapter;
  let fallbackModel = current.fallback_model;
  let repoAccess = current.repo_access_json;
  if ('repoAccess' in patch) {
    // ponytail: 用 Agent 對 repo 的權限近似工作配比（人頭數），需要依實際工作量配比時再做排程權重
    const list = patch.repoAccess;
    if (!Array.isArray(list) || list.length === 0 || list.some((repo) => typeof repo !== 'string')) {
      throw new CommandError('repoAccess 必須是非空字串陣列');
    }
    repoAccess = JSON.stringify([...new Set((list as string[]).map((repo) => {
      if (repo === '*') return repo;
      if (!isAbsolute(repo) || !existsSync(repo)) throw new CommandError(`repoAccess 路徑不合法：${repo}`);
      return realpathSync(repo);
    }))]);
  }
  if ('status' in patch) {
    if (patch.status !== 'active' && patch.status !== 'paused' && patch.status !== 'error') {
      throw new CommandError('Agent status 不合法');
    }
    status = patch.status;
  }
  const changesPrimary = 'primaryAdapter' in patch || 'primaryModel' in patch;
  if (changesPrimary) {
    if (!('primaryAdapter' in patch) || !('primaryModel' in patch)) {
      throw new CommandError('primary route 必須同時提供 adapter 與 model');
    }
    primaryAdapter = adapter(patch.primaryAdapter, 'primary');
    primaryModel = requiredText(patch.primaryModel, 'primaryModel');
  }
  if ('effort' in patch) {
    if (patch.effort !== null && !AGENT_EFFORTS.includes(patch.effort as AgentEffort)) {
      throw new CommandError(`effort 必須是 ${AGENT_EFFORTS.join('|')} 或 null`);
    }
    effort = patch.effort as AgentEffort | null;
  }
  const changesFallback = 'fallbackAdapter' in patch || 'fallbackModel' in patch;
  if (changesFallback) {
    if (patch.fallbackAdapter == null && patch.fallbackModel == null) {
      fallbackAdapter = null;
      fallbackModel = null;
    } else {
      if (!('fallbackAdapter' in patch) || !('fallbackModel' in patch)) {
        throw new CommandError('fallback route 必須同時提供 adapter 與 model');
      }
      fallbackAdapter = adapter(patch.fallbackAdapter, 'fallback');
      fallbackModel = requiredText(patch.fallbackModel, 'fallbackModel');
    }
  }

  database.prepare(
    `UPDATE agents SET status = ?, primary_adapter = ?, primary_model = ?, effort = ?,
       fallback_adapter = ?, fallback_model = ?, repo_access_json = ?, updated_at = ? WHERE agent_id = ?`,
  ).run(status, primaryAdapter, primaryModel, effort, fallbackAdapter, fallbackModel, repoAccess, new Date().toISOString(), agentId);
}
