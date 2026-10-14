import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MemberSessionResult, OwnerDecision, OwnerSessionRunnerContext } from './agent';
import { recordMemberSessionAttempt, shouldResumeFromHumanBlocked } from './coordinator';
import {
  CANONICAL_WORKSPACE_ID,
  CUTOVER_TASKS,
  MAIN_WORKSPACE_ID,
  taskEvidenceFingerprint,
  type CommentSnapshot,
  type CoordinatorSnapshot,
  type TaskEvidence,
  type TaskSnapshot,
} from './policy';
import type { TaskRun } from './types';
import { runOnce } from '../production';

const taskId = 'human-blocked-fingerprint-task';
const run: TaskRun = {
  taskId,
  workspaceId: 'workspace-1',
  phase: 'human_blocked',
  workerId: null,
  branch: null,
  baseSha: null,
  headSha: null,
  evidenceFingerprint: 'before-notice',
  noProgressCount: 3,
  ownerIntervened: true,
  leaseUntil: null,
  updatedAt: '2026-10-14T00:00:00.000Z',
};
const attempt: MemberSessionResult = {
  outcome: 'no_change',
  exitCode: 0,
  output: { summary: '', changedPaths: [], verificationCommands: [], blocker: 'still blocked' },
  evidence: {
    commitSha: null,
    commitChangedPaths: [],
    verificationPassed: false,
    verificationRanCommands: [],
    reviewTransitionConfirmed: false,
    reviewStatus: null,
    summaryCommentId: null,
    blockerRepeated: true,
    rejectedReason: 'still blocked',
  },
  evidenceChanged: false,
};
const evidenceAfterNotice: TaskEvidence = {
  taskId,
  status: 'Doing',
  assigneeId: 'member-1',
  dueAt: null,
  commentCount: 1,
  lastCommentId: 'human-blocked-notice-1',
  lastCommentAt: '2026-10-14T00:01:00.000Z',
};

const transition = recordMemberSessionAttempt(run, attempt, evidenceAfterNotice);
assert.strictEqual(transition.run.phase, 'human_blocked');
assert.strictEqual(
  transition.run.evidenceFingerprint,
  taskEvidenceFingerprint(evidenceAfterNotice),
  '每一次以 human_blocked 結束的 attempt 都必須更新 fingerprint',
);
assert.strictEqual(
  shouldResumeFromHumanBlocked(transition.run, evidenceAfterNotice),
  false,
  'human_blocked 通知已納入 fingerprint 後，通知本身不得讓下一輪恢復',
);

const evidenceAfterHumanComment = {
  ...evidenceAfterNotice,
  commentCount: 2,
  lastCommentId: 'human-comment-1',
  lastCommentAt: '2026-10-14T00:02:00.000Z',
};
assert.strictEqual(
  shouldResumeFromHumanBlocked(transition.run, evidenceAfterHumanComment),
  true,
  '人類真的留言後才應恢復',
);

async function testOwnerDispatchNonDispatchDecisionsDoNotMutateTask(): Promise<void> {
  for (const decisionAction of ['intervene', 'classify', 'conclude-discussion', 'no-decision'] as const) {
    const stateDir = mkdtempSync(join(tmpdir(), `task-tracker-owner-dispatch-${decisionAction}-`));
    const taskId = `owner-dispatch-${decisionAction}`;
    const actualComment = `human context for ${decisionAction}`;
    const genericTask: TaskSnapshot = {
      taskId,
      workspaceId: CANONICAL_WORKSPACE_ID,
      title: 'owner dispatch fixture',
      status: 'Todo',
      assigneeId: null,
      dueAt: null,
      updatedAt: '2026-10-14T00:00:00.000Z',
      version: 1,
    };
    const settledTasks: TaskSnapshot[] = [
      CUTOVER_TASKS.mainDiscussion,
      CUTOVER_TASKS.activeReview.taskId,
      CUTOVER_TASKS.queuedReview.taskId,
      CUTOVER_TASKS.completedPrerequisite.taskId,
      CUTOVER_TASKS.deferredAssignment.taskId,
    ].map((settledTaskId) => ({
      ...genericTask,
      taskId: settledTaskId,
      title: `settled ${settledTaskId}`,
      status: 'Done' as const,
    }));
    const tasks = new Map([...settledTasks, genericTask].map((task) => [task.taskId, task]));
    const comments = new Map<string, CommentSnapshot[]>([[taskId, [{
      commentId: 'human-comment-1',
      taskId,
      userId: 'human-1',
      content: actualComment,
      createdAt: '2026-10-14T00:00:01.000Z',
    }]]]);
    const patches: Array<{ field: string; value: unknown }> = [];
    const ownerContexts: OwnerSessionRunnerContext[] = [];

    const ownerClient = {
      async listWorkspaces() { return []; },
      async listProjects() { return []; },
      async listWorkspaceTasks(workspaceId: string) {
        return workspaceId === CANONICAL_WORKSPACE_ID ? [...tasks.values()] : [];
      },
      async listMembers() {
        return [
          { userId: 'owner-1', role: 'Owner', email: 'user01@test.local', name: 'Owner' },
          { userId: 'member-1', role: 'Member', email: 'member@test.local', name: 'Member' },
          { userId: 'user09-1', role: 'Member', email: 'user09@test.local', name: 'User 09' },
        ];
      },
      async listAgents() { return []; },
      async listComments(id: string) { return comments.get(id) ?? []; },
      async getAuditTrail() { return []; },
      async whoAmI() { return { id: 'owner-1', email: 'user01@test.local', name: 'Owner' }; },
      async health() { return { status: 'ok', db: true, rev: 'test-rev' }; },
      async getTask(id: string) { return tasks.get(id)!; },
      async patchTaskField(id: string, field: 'status' | 'assignee', value: unknown) {
        patches.push({ field, value });
        const task = tasks.get(id)!;
        const updated = field === 'status'
          ? { ...task, status: value as TaskSnapshot['status'] }
          : { ...task, assigneeId: value as string | null };
        tasks.set(id, updated);
        return updated;
      },
      async postCommentOnce(id: string, content: string) {
        const list = comments.get(id) ?? [];
        list.push({ commentId: `notice-${decisionAction}`, taskId: id, userId: 'owner-1', content, createdAt: '2026-10-14T00:00:02.000Z' });
        comments.set(id, list);
        return `notice-${decisionAction}`;
      },
    };
    const user09Client = { async listNotifications() { return []; } };
    const snapshot: CoordinatorSnapshot = {
      tasks: [...tasks.values()],
      taskRuns: {},
      taskEvidence: {},
      prerequisiteEvidence: null,
      userIdsByEmail: {
        'user01@test.local': 'owner-1',
        'member@test.local': 'member-1',
        'user09@test.local': 'user09-1',
      },
      agentIds: [],
    };
    const decision: OwnerDecision | null = decisionAction === 'no-decision' ? null : {
        action: decisionAction,
        rationale: `${decisionAction} rationale`,
        evidenceCommentIds: ['human-comment-1'],
        ...(decisionAction === 'classify' ? { classification: 'maintenance' as const } : {}),
        ...(decisionAction === 'conclude-discussion' ? { outcome: 'no_consensus' as const } : {}),
      };

    const run = () => runOnce({
        live: true,
        dbPath: join(stateDir, 'coordinator.db'),
        traceSink: () => undefined,
        performDiscovery: async () => ({ ok: true, ownerClient, user09Client, healthRev: 'test-rev' }) as never,
        gatherSnapshot: async () => snapshot,
        runOwnerSession: async (context) => {
          ownerContexts.push(context);
          return { exitCode: 0, decision } as never;
        },
        runMemberSession: async () => ({
          exitCode: 0,
          output: { summary: '', changedPaths: [], verificationCommands: [], blocker: null },
        }),
        sendDiscordMessage: async () => true,
      });

    try {
      const first = await run();
      assert.strictEqual(first.exitCode, 0, `${decisionAction} 不應觸發 assignment/worktree 錯誤`);
      assert.strictEqual(ownerContexts.length, 1, `${decisionAction} 第一輪必須呼叫 Owner`);

      const second = await run();
      assert.strictEqual(second.exitCode, 0);
      assert.strictEqual(ownerContexts.length, 1, `${decisionAction} 相同證據的第二輪不得再次呼叫 Owner`);

      comments.get(taskId)!.push({
        commentId: 'human-comment-2',
        taskId,
        userId: 'human-1',
        content: 'new human evidence',
        createdAt: '2026-10-14T00:00:03.000Z',
      });
      const third = await run();
      assert.strictEqual(third.exitCode, 0);
      assert.strictEqual(ownerContexts.length, 2, `${decisionAction} 新增留言後必須再次呼叫 Owner`);

      assert.deepStrictEqual(patches, [], `${decisionAction} 不得指派或移到 Doing`);
      assert.deepStrictEqual(ownerContexts[0]?.comments, [actualComment], 'owner_dispatch prompt 必須帶入 task 的實際留言');
      if (decision) {
        assert.match(comments.get(taskId)?.[1]?.content ?? '', new RegExp(`${decisionAction} rationale`), `${decisionAction} 應留下 rationale 留言`);
        const notices = (comments.get(taskId) ?? []).filter((comment) => comment.content.startsWith('【OWNER派工】'));
        assert.strictEqual(notices.length, 2, `${decisionAction} 新證據後的第二次 Owner 決策必須留下第二則留言`);
      }
      assert.strictEqual(tasks.get(taskId)?.status, 'Todo');
      assert.strictEqual(tasks.get(taskId)?.assigneeId, null);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }
}

void testOwnerDispatchNonDispatchDecisionsDoNotMutateTask().then(() => {
  console.log('production/coordinator.test.ts OK');
});
