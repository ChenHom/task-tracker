import type { DatabaseSync } from 'node:sqlite';
import { db } from './db';
import { getUserIdByEmail } from './auth';
import { CommandError } from './eventStore';
import {
  changeMemberRole,
  getMemberRole,
  inviteMember,
  joinWorkspace,
} from './member';
import {
  MAIN_OWNER_EMAIL,
  MAIN_POLICY_DESCRIPTION,
  MAIN_POLICY_TITLE,
  MAIN_WORKSPACE_ID,
  MAIN_WORKSPACE_NAME,
} from './mainWorkspacePolicy';
import { changeTaskDescription, createTask, listTasks, normalizeMainDiscussion } from './task';
import { getWorkspaceStatus, renameWorkspace } from './workspace';

function mainOwner(database: DatabaseSync): string {
  if (getWorkspaceStatus(MAIN_WORKSPACE_ID, database) !== 'active') {
    throw new CommandError('主工作區不存在或不是 active');
  }
  const ownerId = getUserIdByEmail(MAIN_OWNER_EMAIL, database);
  if (!ownerId || getMemberRole(MAIN_WORKSPACE_ID, ownerId, database) !== 'Owner') {
    throw new CommandError('user01 不存在或不是主工作區 Owner');
  }
  return ownerId;
}

function ensureCommenter(ownerId: string, userId: string, database: DatabaseSync): void {
  const role = getMemberRole(MAIN_WORKSPACE_ID, userId, database);
  if (role === 'Commenter') return;
  if (role) {
    changeMemberRole(ownerId, MAIN_WORKSPACE_ID, userId, 'Commenter', database);
    return;
  }

  try {
    joinWorkspace(userId, MAIN_WORKSPACE_ID, database);
  } catch (error) {
    if (!(error instanceof CommandError)) throw error;
    inviteMember(ownerId, MAIN_WORKSPACE_ID, userId, 'Commenter', database);
    joinWorkspace(userId, MAIN_WORKSPACE_ID, database);
  }
  if (getMemberRole(MAIN_WORKSPACE_ID, userId, database) !== 'Commenter') {
    changeMemberRole(ownerId, MAIN_WORKSPACE_ID, userId, 'Commenter', database);
  }
}

export function syncMainWorkspaceUser(userId: string, database = db): void {
  const ownerId = mainOwner(database);
  if (userId !== ownerId) ensureCommenter(ownerId, userId, database);
}

export function syncMainWorkspace(database = db): void {
  const ownerId = mainOwner(database);
  const workspace = database
    .prepare('SELECT name FROM workspaces_read_model WHERE workspace_id = ?')
    .get(MAIN_WORKSPACE_ID) as { name: string };
  if (workspace.name !== MAIN_WORKSPACE_NAME) {
    renameWorkspace(ownerId, MAIN_WORKSPACE_ID, MAIN_WORKSPACE_NAME, database);
  }

  const users = database.prepare('SELECT id FROM users').all() as unknown as Array<{ id: string }>;
  for (const user of users) {
    if (user.id !== ownerId) ensureCommenter(ownerId, user.id, database);
  }

  const tasks = listTasks(MAIN_WORKSPACE_ID, database);
  for (const task of tasks) {
    if (task.status !== 'Archived' && task.title !== MAIN_POLICY_TITLE) {
      normalizeMainDiscussion(ownerId, task.task_id, database);
    }
  }

  const policy = tasks.find((task) => task.status !== 'Archived' && task.title === MAIN_POLICY_TITLE);
  if (!policy) {
    createTask(
      ownerId,
      MAIN_WORKSPACE_ID,
      { title: MAIN_POLICY_TITLE, description: MAIN_POLICY_DESCRIPTION },
      database,
    );
  } else if (policy.description !== MAIN_POLICY_DESCRIPTION) {
    changeTaskDescription(ownerId, policy.task_id, MAIN_POLICY_DESCRIPTION, database);
  }
}
