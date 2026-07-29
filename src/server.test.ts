import assert from 'node:assert';
import { clientIp } from './clientIp';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dataDir = mkdtempSync(join(tmpdir(), 'task-tracker-server-test-'));
process.env.TASK_TRACKER_DATA_DIR = dataDir;

const socketIp = '203.0.113.10';

assert.strictEqual(
  clientIp({}, socketIp, false),
  socketIp,
  '未啟用 TRUST_PROXY 時應直接回 socket IP',
);

assert.strictEqual(
  clientIp({ 'x-forwarded-for': '198.51.100.5, 203.0.113.10' }, socketIp, true),
  '198.51.100.5',
  '啟用 TRUST_PROXY 時應取 X-Forwarded-For 最左側 IP',
);

assert.strictEqual(
  clientIp({ 'x-forwarded-for': '   198.51.100.7  ' }, socketIp, true),
  '198.51.100.7',
  'X-Forwarded-For 前後空白應被修整',
);

assert.strictEqual(
  clientIp({}, null, true),
  null,
  '沒有 socket IP 且未提供 X-Forwarded-For 時應回 null',
);

// /api/health 需回報部署中的 git rev，供部署 readback 與 owner live 驗收比對
void (async () => {
  const { handle, taskPatchRole } = await import('./server');
  const { db } = await import('./db');
  const { createSession } = await import('./auth');
  assert.strictEqual(taskPatchRole({ description: 'updated' }), 'Commenter');
  assert.strictEqual(taskPatchRole({ title: 'renamed' }), 'Member');
  assert.strictEqual(taskPatchRole({ status: 'Doing' }), 'Member');
  assert.strictEqual(taskPatchRole({ description: 'x', title: 'y' }), 'Member');
  assert.strictEqual(taskPatchRole({}), 'Member');
  let body = '';
  const req = { url: '/api/health', method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writeHead: () => {}, end: (chunk?: unknown) => { body = String(chunk ?? ''); } };
  await handle(req as never, res as never);
  const health = JSON.parse(body);
  assert.match(String(health.rev), /^[0-9a-f]{7,40}$/, 'health 必須帶 git rev');

  const mainWorkspaceId = '11a82028-fc50-466a-a723-e002032cd9a6';
  db.prepare('INSERT INTO workspaces_read_model (workspace_id, name, status, created_at) VALUES (?, ?, ?, ?)')
    .run(mainWorkspaceId, '主協作工作區', 'active', '2026-07-01T00:00:00.000Z');
  db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
    .run('owner', 'user01@test.local', 'Owner', 'hash');
  db.prepare('INSERT INTO workspace_members_read_model (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .run(mainWorkspaceId, 'owner', 'Owner', '2026-07-01T00:00:00.000Z');
  db.prepare('INSERT INTO tasks_read_model (task_id, workspace_id, title, status, priority, version) VALUES (?, ?, ?, ?, ?, ?)')
    .run('main-discussion', mainWorkspaceId, '[討論] HTTP 回歸', 'Todo', 'Medium', 1);
  const cookie = `session=${createSession('owner')}`;
  const postComment = async (content: string): Promise<number> => {
    let status = 0;
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ content }))]), {
      url: '/api/tasks/main-discussion/comments',
      method: 'POST',
      headers: { cookie },
      socket: { remoteAddress: '127.0.0.1' },
    });
    const response = { writeHead: (code: number) => { status = code; }, end: () => {} };
    await handle(request as never, response as never);
    return status;
  };
  const ownerThought = [
    '【OWNER想法】', '現況／問題：HTTP 回歸', '預期價值：確認通知可開窗',
    '風險與反對理由：測試不足', '現行可替代方案：人工確認', '初步判斷：採兩天窗口',
    '希望成員確認的問題：是否可行',
  ].join('\n');
  assert.strictEqual(await postComment(ownerThought), 201, '完整 OWNER想法應能經 HTTP 建立');
  assert.strictEqual(await postComment('【全員回覆：2天】\n@user02 @user03 @user04 @user05 @user06 @user09'), 201, '2 天通知應能經 HTTP 建立');
  const window = db.prepare('SELECT wait_half_days, opened_at, due_at FROM main_discussion_windows WHERE task_id = ?')
    .get('main-discussion') as { wait_half_days: number; opened_at: string; due_at: string };
  assert.strictEqual(window.wait_half_days, 4, 'HTTP 建立的 2 天通知應保存四個 half-days');
  assert.strictEqual(Date.parse(window.due_at) - Date.parse(window.opened_at), 48 * 60 * 60 * 1000, 'HTTP 建立的期限應為 48 小時');
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  console.log('server.test.ts OK');
})().catch((e) => { console.error(e); process.exit(1); });
