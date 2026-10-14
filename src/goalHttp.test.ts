import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dataDir = mkdtempSync(join(tmpdir(), 'task-tracker-goal-http-test-'));
process.env.TASK_TRACKER_DATA_DIR = dataDir;
process.env.TASK_TRACKER_REPO_REGISTRY_PATH = join(dataDir, 'repos.json');
writeFileSync(process.env.TASK_TRACKER_REPO_REGISTRY_PATH, '{}');

void (async () => {
  try {
    const { handle } = await import('./server');
    const { db } = await import('./db');
    const { createSession } = await import('./auth');
    const { appendEvent } = await import('./eventStore');
    const { archiveProject, createProject } = await import('./project');
    const { createTask, getTask, registerTaskProjections } = await import('./task');
    const { registerNotificationProjections } = await import('./notification');
    const {
      acquireRepoLease,
      blockGoal,
      createGoal,
      getGoal,
      registerGoalProjections,
      setDiscussionPhase,
      startDiscussion,
      startExecution,
    } = await import('./goal');

    registerGoalProjections();
    registerTaskProjections();
    registerNotificationProjections();

    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES ('owner', 'owner@test.local', 'Owner', 'hash')").run();
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES ('human-member', 'human-member@test.local', 'Human Member', 'hash')").run();
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES ('owner-agent-user', 'owner-agent@test.local', 'Owner Agent', 'hash')").run();
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES ('member-agent-user', 'member-agent@test.local', 'Member Agent', 'hash')").run();
    db.prepare("INSERT INTO workspaces_read_model (workspace_id, name, status, created_at) VALUES ('ws', 'Workspace', 'active', 't')").run();
    db.prepare("INSERT INTO workspace_members_read_model (workspace_id, user_id, role, joined_at) VALUES ('ws', 'owner', 'Owner', 't')").run();
    db.prepare("INSERT INTO workspace_members_read_model (workspace_id, user_id, role, joined_at) VALUES ('ws', 'human-member', 'Member', 't')").run();
    db.prepare("INSERT INTO workspace_members_read_model (workspace_id, user_id, role, joined_at) VALUES ('ws', 'member-agent-user', 'Member', 't')").run();
    db.prepare(`INSERT INTO agents
      (agent_id, user_id, email, name, role, skill_profile_json, primary_adapter, primary_model, status, created_at, updated_at)
      VALUES ('owner-agent', 'owner-agent-user', 'owner-agent@test.local', 'Owner Agent', 'owner', '{}', 'claude', 'model', 'active', 't', 't')`).run();
    db.prepare(`INSERT INTO agents
      (agent_id, user_id, email, name, role, skill_profile_json, primary_adapter, primary_model, status, created_at, updated_at)
      VALUES ('member-agent', 'member-agent-user', 'member-agent@test.local', 'Member Agent', 'member', '{}', 'codex', 'model', 'active', 't', 't')`).run();
    const projectId = createProject('ws', { name: 'Archived Project' });
    archiveProject(projectId);

    const request = async (method: string, url: string, userId: string, body?: object) => {
      let status = 0;
      let responseBody = '';
      const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
        url,
        method,
        headers: { cookie: `session=${createSession(userId)}` },
        socket: { remoteAddress: '127.0.0.1' },
      });
      const res = {
        writeHead: (code: number) => { status = code; },
        end: (chunk?: unknown) => { responseBody = String(chunk ?? ''); },
      };
      await handle(req as never, res as never);
      return { status, responseBody };
    };

    const projectsResponse = await request('GET', '/api/workspaces/ws/projects', 'owner');
    assert.strictEqual(projectsResponse.status, 200);
    const archived = (JSON.parse(projectsResponse.responseBody) as Array<{ project_id: string; status: string }>)
      .find((project) => project.project_id === projectId);
    assert.strictEqual(archived?.status, 'archived', 'GET projects 應包含已封存 Project');

    const goalProjectId = createProject('ws', { name: 'Goal Project', targetRepo: '/srv/app' }, db, new Map([
      ['/srv/app', { targetRepo: '/srv/app', checks: ['npm test'], deployment: 'not_required' as const }],
    ]));
    const goalId = createGoal('owner', {
      workspaceId: 'ws',
      projectId: goalProjectId,
      source: 'human',
      objective: 'Protect human Goal lifecycle actions',
      successCriteria: 'Only human accounts can pause, resume, or cancel',
      ownerAgentId: 'owner-agent',
    }, db, new Map([
      ['/srv/app', { targetRepo: '/srv/app', checks: ['npm test'], deployment: 'not_required' }],
    ]));
    startDiscussion('owner-agent-user', goalId);
    setDiscussionPhase('owner-agent-user', goalId, 'round_1');
    setDiscussionPhase('owner-agent-user', goalId, 'awaiting_lease');
    acquireRepoLease('owner-agent-user', goalId);
    startExecution('owner-agent-user', goalId);

    const goalTaskId = 'goal-task';
    appendEvent('Task', goalTaskId, 0, 'task.created', {
      workspaceId: 'ws', projectId: goalProjectId, goalId,
      title: 'Goal Task', description: '', status: 'Todo', priority: 'Medium', assigneeId: 'member-agent-user', dueAt: null,
    }, { actor_id: 'owner-agent-user' }, db);
    const regularTaskId = createTask('owner', 'ws', { title: 'Regular Task' });
    const regularDeleteTaskId = createTask('owner', 'ws', { title: 'Regular Task to delete' });

    const agentGoalDelete = await request('DELETE', `/api/tasks/${goalTaskId}`, 'member-agent-user');
    assert.strictEqual(agentGoalDelete.status, 400, 'Agent 刪除 Goal Task 應回 400');
    assert.strictEqual(getTask(goalTaskId)?.goal_id, goalId, 'Agent 刪除失敗後 Goal Task 仍存在');

    const humanGoalDelete = await request('DELETE', `/api/tasks/${goalTaskId}`, 'human-member');
    assert.strictEqual(humanGoalDelete.status, 400, '人類刪除 Goal Task 應回 400');
    assert.strictEqual(getTask(goalTaskId)?.goal_id, goalId, '人類刪除失敗後 Goal Task 仍存在');

    const regularDelete = await request('DELETE', `/api/tasks/${regularDeleteTaskId}`, 'human-member');
    assert.strictEqual(regularDelete.status, 200, '非 Goal Task 的 DELETE 行為不變');
    assert.strictEqual(getTask(regularDeleteTaskId), null, '非 Goal Task 仍可刪除');

    const agentGoalArchive = await request('POST', `/api/tasks/${goalTaskId}/archive`, 'member-agent-user');
    assert.strictEqual(agentGoalArchive.status, 403, 'Agent 封存 Goal Task 應回 403');
    assert.strictEqual(getTask(goalTaskId)?.status, 'Todo', 'Agent 封存不得改變 Goal Task 狀態');

    const agentRegularArchive = await request('POST', `/api/tasks/${regularTaskId}/archive`, 'member-agent-user');
    assert.strictEqual(agentRegularArchive.status, 200, 'Agent 仍可封存非 Goal Task');
    assert.strictEqual(getTask(regularTaskId)?.status, 'Archived');

    const humanGoalArchive = await request('POST', `/api/tasks/${goalTaskId}/archive`, 'human-member');
    assert.strictEqual(humanGoalArchive.status, 200, '人類 Member 可封存 Goal Task');
    assert.strictEqual(getTask(goalTaskId)?.status, 'Archived');

    const agentPause = await request('POST', `/api/goals/${goalId}/pause`, 'member-agent-user');
    assert.strictEqual(agentPause.status, 403, 'Agent pause 應回 403');
    assert.strictEqual(getGoal(goalId)?.status, 'Executing', 'Agent pause 不得改變 Goal 狀態');
    assert.strictEqual(getGoal(goalId)?.pause_requested, 0, 'Agent pause 不得排定暫停');

    const humanPause = await request('POST', `/api/goals/${goalId}/pause`, 'human-member');
    assert.ok(humanPause.status === 200 || humanPause.status === 202, '人類 pause 應成功');
    assert.strictEqual(getGoal(goalId)?.status, 'Paused');

    const agentResume = await request('POST', `/api/goals/${goalId}/resume`, 'member-agent-user');
    assert.strictEqual(agentResume.status, 403, 'Agent resume 應回 403');
    assert.strictEqual(getGoal(goalId)?.status, 'Paused', 'Agent resume 不得改變 Goal 狀態');
    const agentCancel = await request('POST', `/api/goals/${goalId}/cancel`, 'member-agent-user');
    assert.strictEqual(agentCancel.status, 403, 'Agent cancel 應回 403');
    assert.strictEqual(getGoal(goalId)?.status, 'Paused', 'Agent cancel 不得改變 Goal 狀態');

    const humanResume = await request('POST', `/api/goals/${goalId}/resume`, 'human-member');
    assert.strictEqual(humanResume.status, 200, '人類 resume 應成功');
    blockGoal('owner-agent-user', goalId, 'implementation blocked', db);
    const notificationsResponse = await request('GET', '/api/notifications', 'owner');
    assert.strictEqual(notificationsResponse.status, 200);
    assert.deepStrictEqual((JSON.parse(notificationsResponse.responseBody) as Array<Record<string, unknown>>).map((notification) => ({
      source_task_id: notification.source_task_id,
      source_goal_id: notification.source_goal_id,
    })), [{ source_task_id: '', source_goal_id: goalId }], '通知 API 應回傳無 Task 的 Goal 來源');
    const blockedPatch = await request('PATCH', `/api/goals/${goalId}`, 'human-member', { successCriteria: 'bypass blocked recovery' });
    assert.strictEqual(blockedPatch.status, 400, '持 lease 的 Blocked Goal 不得直接修改成功條件');
    assert.strictEqual(getGoal(goalId)?.status, 'Blocked', '失敗的 PATCH 不得解除 Blocked');
    console.log('goalHttp.test.ts OK');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('goalHttp.test.ts FAILED:', error);
  process.exit(1);
});
