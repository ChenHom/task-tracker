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
  // 2026-07-23 至 07-29 期間，owner 照 prompt 貼的徵詢留言會被窗口 validator 回 400，
  // 主討論連續兩週開不出來。窗口移除後，主工作區留言不該再有任何格式閘門。
  const ownerThought = [
    '【OWNER想法】', '現況／問題：HTTP 回歸', '預期價值：確認留言不再被擋',
    '風險與反對理由：測試不足', '現行可替代方案：人工確認', '初步判斷：先驗證 HTTP 路徑',
    '希望成員確認的問題：是否可行',
  ].join('\n');
  assert.strictEqual(await postComment(ownerThought), 201, '完整 OWNER想法應能經 HTTP 建立');
  assert.strictEqual(
    await postComment('@user02 @user03 @user04 @user05 @user06 @user09\n請提供意見。'),
    201,
    '徵詢留言不得再被任何期限 validator 擋下',
  );
  assert.strictEqual(await postComment('【全員回覆：2天】\n殘留的舊 marker'), 201, '舊 marker 只是普通文字，不得回 400');

  // 通知分頁的錯誤路徑必須在 HTTP 層驗：unit test 直接呼叫 listNotificationsPage() 看不出
  // 「header 已送出才想改狀態碼」——writeHead 排在計算之前時，非法頁碼會回 200 並在第二次
  // writeHead 炸掉（ERR_HTTP_HEADERS_SENT），而 unit test 照樣全綠。
  const getNotifications = async (query: string): Promise<{ status: number; body: string }> => {
    let status = 0;
    let body = '';
    let headersSent = false;
    const request = { url: `/api/notifications${query}`, method: 'GET', headers: { cookie }, socket: { remoteAddress: '127.0.0.1' } };
    const response = {
      writeHead: (code: number) => {
        if (headersSent) throw new Error('writeHead 被呼叫第二次：header 已送出（真實 Node 會丟 ERR_HTTP_HEADERS_SENT）');
        headersSent = true;
        status = code;
      },
      end: (chunk?: unknown) => { body = String(chunk ?? ''); },
    };
    await handle(request as never, response as never);
    return { status, body };
  };
  const noParam = await getNotifications('');
  assert.strictEqual(noParam.status, 200, '不帶 page 應維持既有行為');
  assert.ok(Array.isArray(JSON.parse(noParam.body)), '不帶 page 應維持 array 回應，不可變成分頁物件');
  const firstPage = await getNotifications('?page=1');
  assert.strictEqual(firstPage.status, 200);
  assert.deepStrictEqual(
    JSON.parse(firstPage.body),
    { items: [], page: 1, pageSize: 15, totalCount: 0, totalPages: 1, unreadTotal: 0 },
    '0 筆時 page=1 應回空清單且 totalPages 至少為 1',
  );
  for (const [query, label] of [
    ['?page=0', 'page=0'],
    ['?page=-1', 'page=-1'],
    ['?page=abc', 'page 非數字'],
    ['?page=1.5', 'page 小數'],
    ['?page=1&pageSize=0', 'pageSize=0'],
    ['?page=1&pageSize=999', 'pageSize 越界'],
    ['?page=2', 'page 超出總頁數'],
  ] as const) {
    const res400 = await getNotifications(query);
    assert.strictEqual(res400.status, 400, `${label} 應回 400，實際 ${res400.status}`);
    assert.ok(JSON.parse(res400.body).error, `${label} 應帶 error 訊息`);
  }

  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  console.log('server.test.ts OK');
})().catch((e) => { console.error(e); process.exit(1); });
