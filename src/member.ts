import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { db } from './db';
import { appendEvent, loadEvents, registerProjection, CommandError, type StoredEvent } from './eventStore';
import { buildMetadata as meta } from './requestContext';
import { currentUserId } from './auth';

// ── 角色階層：Owner > Admin > Member > Viewer ──────────────────────
export const ROLE_RANK = { Viewer: 0, Member: 1, Admin: 2, Owner: 3 } as const;
export type Role = keyof typeof ROLE_RANK;

function validateRole(role: unknown): Role {
  if (typeof role !== 'string' || !(role in ROLE_RANK)) throw new CommandError(`role 不合法：${String(role)}`);
  return role as Role;
}

// member aggregate 的 id = workspace_uuid:user_uuid（uuid 不含冒號，放心拆解）。
function mid(workspaceId: string, userId: string): string {
  return `${workspaceId}:${userId}`;
}

// ── Aggregate ──────────────────────────────────────────────────────
type MemberStatus = 'none' | 'invited' | 'active' | 'removed';
interface MemberState {
  status: MemberStatus;
  role: Role | null;
}
const INITIAL: MemberState = { status: 'none', role: null };

function reduce(state: MemberState, e: StoredEvent): MemberState {
  const p = e.payload as { role?: Role };
  switch (e.event_type) {
    case 'member.invited':
      return { status: 'invited', role: p.role ?? null };
    case 'member.joined':
      return { ...state, status: 'active' };
    case 'member.role_changed':
      return { ...state, role: p.role ?? state.role };
    case 'member.removed':
      return { ...state, status: 'removed' };
    default:
      return state;
  }
}

function load(workspaceId: string, userId: string, database: DatabaseSync): { state: MemberState; version: number } {
  const events = loadEvents(mid(workspaceId, userId), database);
  const state = events.reduce(reduce, INITIAL);
  const version = events.length ? events[events.length - 1].aggregate_version : 0;
  return { state, version };
}

// ── Command handlers（RBAC middleware 擋一般權限；下面是「權限升級」等業務規則，
// 屬於 domain invariant，跟 workspace.ts 的狀態機驗證一樣要放在 command 裡，不能只靠 HTTP 層）──
export function inviteMember(actorId: string, workspaceId: string, userId: string, role: unknown, database = db): void {
  const r = validateRole(role);
  // 只有 Owner 能任命 Owner；workspace 剛建立、還沒有任何 active 成員時例外（seedOwner bootstrap，
  // 此時查不到任何 Owner 可比對，這條路徑無法從 HTTP 觸發——requirePermission 對 0 成員的 workspace
  // 一定回 403，能走到這裡的只有 seedOwner 的直接呼叫）。
  if (r === 'Owner' && countActiveMembers(workspaceId, database) > 0 && getMemberRole(workspaceId, actorId, database) !== 'Owner') {
    throw new CommandError('只有 Owner 能任命 Owner');
  }
  const { state, version } = load(workspaceId, userId, database);
  if (state.status !== 'none') throw new CommandError('該使用者已被邀請或已是成員');
  appendEvent('Member', mid(workspaceId, userId), version, 'member.invited', { workspaceId, userId, role: r }, meta(actorId), database);
}

export function joinWorkspace(actorId: string, workspaceId: string, database = db): void {
  const { state, version } = load(workspaceId, actorId, database);
  if (state.status !== 'invited') throw new CommandError('沒有待接受的邀請');
  appendEvent('Member', mid(workspaceId, actorId), version, 'member.joined', { workspaceId, userId: actorId, role: state.role }, meta(actorId), database);
}

export function changeMemberRole(actorId: string, workspaceId: string, userId: string, role: unknown, database = db): void {
  const r = validateRole(role);
  const { state, version } = load(workspaceId, userId, database);
  if (state.status !== 'active') throw new CommandError('對象不是使用中的成員');
  const actorRole = getMemberRole(workspaceId, actorId, database);
  // 權限升級：只有 Owner 能任命 Owner。
  if (r === 'Owner' && actorRole !== 'Owner') throw new CommandError('只有 Owner 能任命 Owner');
  // 對象目前就是 Owner：Admin 不能動 Owner 的角色（不論改成什麼）。
  if (state.role === 'Owner' && actorRole !== 'Owner') throw new CommandError('只有 Owner 能變更 Owner 的角色');
  // Owner 自我降級：只有在自己是唯一 active 成員時才能卸任，否則會出現「有其他成員但沒有 Owner」。
  if (actorId === userId && state.role === 'Owner' && r !== 'Owner' && countActiveMembers(workspaceId, database) !== 1) {
    throw new CommandError('workspace 還有其他成員，Owner 需先移交或移除其他成員才能卸任');
  }
  appendEvent('Member', mid(workspaceId, userId), version, 'member.role_changed', { workspaceId, userId, role: r }, meta(actorId), database);
}

export function removeMember(actorId: string, workspaceId: string, userId: string, database = db): void {
  const { state, version } = load(workspaceId, userId, database);
  if (state.status !== 'invited' && state.status !== 'active') throw new CommandError('對象不是成員');
  if (state.role === 'Owner') {
    // 對象目前是 Owner：Admin 不能移除 Owner。
    if (getMemberRole(workspaceId, actorId, database) !== 'Owner') throw new CommandError('只有 Owner 能移除 Owner');
    // Owner 自我移除：同自我降級規則，只有唯一 active 成員時才能離開。
    if (actorId === userId && countActiveMembers(workspaceId, database) !== 1) {
      throw new CommandError('workspace 還有其他成員，Owner 需先移交或移除其他成員才能離開');
    }
  }
  appendEvent('Member', mid(workspaceId, userId), version, 'member.removed', { workspaceId, userId }, meta(actorId), database);
}

// workspace 建立時 bootstrap owner。繞過權限（此時還沒有任何成員可查）。
export function seedOwner(workspaceId: string, userId: string, database = db): void {
  // ponytail: 跨 aggregate 無 saga——workspace.created 與 owner 加入是兩批 append，非原子。
  // 建立流程失敗率低；要嚴謹得上 process manager，等有需求再說。
  inviteMember(userId, workspaceId, userId, 'Owner', database);
  joinWorkspace(userId, workspaceId, database);
}

// ── Projection → workspace_members_read_model ──────────────────────
// invited 不投影（未 joined 無權限）；joined 才進 read model。
export function registerMemberProjections(): void {
  registerProjection('member.joined', (e, database) => {
    const p = e.payload as { workspaceId: string; userId: string; role: Role };
    database
      .prepare('INSERT INTO workspace_members_read_model (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .run(p.workspaceId, p.userId, p.role, e.occurred_at);
  });
  registerProjection('member.role_changed', (e, database) => {
    const p = e.payload as { workspaceId: string; userId: string; role: Role };
    database
      .prepare('UPDATE workspace_members_read_model SET role = ? WHERE workspace_id = ? AND user_id = ?')
      .run(p.role, p.workspaceId, p.userId);
  });
  registerProjection('member.removed', (e, database) => {
    const p = e.payload as { workspaceId: string; userId: string };
    database
      .prepare('DELETE FROM workspace_members_read_model WHERE workspace_id = ? AND user_id = ?')
      .run(p.workspaceId, p.userId);
  });
}

// ── 查詢：成員列表 + 計數（workspace.ts 的關站守門也依賴 countActiveMembers）──
export interface MemberRow {
  user_id: string;
  role: Role;
  joined_at: string;
  email: string;
  name: string;
}
export function listMembers(workspaceId: string, database = db): MemberRow[] {
  return database
    .prepare(
      `SELECT m.user_id, m.role, m.joined_at, u.email, u.name
         FROM workspace_members_read_model m
         JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ?
        ORDER BY m.joined_at`,
    )
    .all(workspaceId) as unknown as MemberRow[];
}

// active 成員數（read model 只放已 joined 的成員）。workspace archive/delete 與 Owner
// 自我卸任/離開都靠這個數字判斷「是不是只剩自己」。
export function countActiveMembers(workspaceId: string, database = db): number {
  const row = database
    .prepare('SELECT count(*) AS c FROM workspace_members_read_model WHERE workspace_id = ?')
    .get(workspaceId) as { c: number };
  return row.c;
}

// ── 權限查詢 + middleware ──────────────────────────────────────────
export function getMemberRole(workspaceId: string, userId: string, database = db): Role | null {
  const row = database
    .prepare('SELECT role FROM workspace_members_read_model WHERE workspace_id = ? AND user_id = ?')
    .get(workspaceId, userId) as { role: Role } | undefined;
  return row?.role ?? null;
}

export function hasPermission(role: Role, minRole: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

// 未登入 → 401；非該 workspace 成員或角色不足 → 403。回 userId 代表通過。
// 跨 workspace 一定被擋：查的是「你在這個 workspace 的角色」，別的 workspace 不算數。
export function requirePermission(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceId: string,
  minRole: Role,
  database = db,
): string | null {
  const userId = currentUserId(req, database);
  if (!userId) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '未登入' }));
    return null;
  }
  const role = getMemberRole(workspaceId, userId, database);
  if (!role || !hasPermission(role, minRole)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '權限不足' }));
    return null;
  }
  return userId;
}
