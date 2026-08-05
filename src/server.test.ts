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

  // ── 授權矩陣 HTTP 負向測試（task 6708f91b）────────────────────────
  // comment 隔離 fixture + task/member/attachment 代表案例；domain-level 規則已在
  // comment.test.ts / task.test.ts / member.test.ts / attachment.test.ts 覆蓋，這裡只驗證
  // requirePermission 與 ownership 檢查真的接在 HTTP 路由上，不重複 domain unit test。
  const wsA = 'authz-ws-a';
  const wsB = 'authz-ws-b';
  db.prepare('INSERT INTO workspaces_read_model (workspace_id, name, status, created_at) VALUES (?, ?, ?, ?)')
    .run(wsA, 'Authz A', 'active', '2026-08-05T00:00:00.000Z');
  db.prepare('INSERT INTO workspaces_read_model (workspace_id, name, status, created_at) VALUES (?, ?, ?, ?)')
    .run(wsB, 'Authz B', 'active', '2026-08-05T00:00:00.000Z');

  const mkUser = (id: string, email: string) =>
    db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run(id, email, email, 'hash');
  const grant = (workspaceId: string, userId: string, role: string) =>
    db.prepare('INSERT INTO workspace_members_read_model (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .run(workspaceId, userId, role, '2026-08-05T00:00:00.000Z');

  mkUser('authz-viewer', 'authz-viewer@test.local');
  mkUser('authz-commenter-a', 'authz-commenter-a@test.local');
  mkUser('authz-commenter-b', 'authz-commenter-b@test.local');
  mkUser('authz-member', 'authz-member@test.local');
  mkUser('authz-outsider', 'authz-outsider@test.local'); // 只在 wsB，用來測跨 workspace
  grant(wsA, 'authz-viewer', 'Viewer');
  grant(wsA, 'authz-commenter-a', 'Commenter');
  grant(wsA, 'authz-commenter-b', 'Commenter');
  grant(wsA, 'authz-member', 'Member');
  grant(wsB, 'authz-outsider', 'Member');

  const authzTaskId = 'authz-task-1';
  db.prepare('INSERT INTO tasks_read_model (task_id, workspace_id, title, status, priority, version) VALUES (?, ?, ?, ?, ?, ?)')
    .run(authzTaskId, wsA, 'Authz task', 'Todo', 'Medium', 1);

  const sessionFor = (userId: string) => `session=${createSession(userId)}`;
  const authzCookie = {
    viewer: sessionFor('authz-viewer'),
    commenterA: sessionFor('authz-commenter-a'),
    commenterB: sessionFor('authz-commenter-b'),
    member: sessionFor('authz-member'),
    outsider: sessionFor('authz-outsider'),
  };

  // 泛用 JSON HTTP 呼叫：GET/DELETE 不帶 body 也能安全建構（handler 不會讀取）。
  const call = async (
    method: string,
    url: string,
    opts: { cookie?: string; body?: unknown } = {},
  ): Promise<{ status: number; json: unknown }> => {
    let status = 0;
    let raw = '';
    const headers: Record<string, string> = opts.cookie ? { cookie: opts.cookie } : {};
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(opts.body ?? {}))]), {
      url, method, headers, socket: { remoteAddress: '127.0.0.1' },
    });
    const response = { writeHead: (code: number) => { status = code; }, end: (chunk?: unknown) => { raw = String(chunk ?? ''); } };
    await handle(request as never, response as never);
    return { status, json: raw ? JSON.parse(raw) : null };
  };
  // attachment 上傳走 raw bytes（非 JSON），需獨立的 helper。
  const uploadAttachment = async (cookie: string | undefined, taskId: string, filename: string, contentType: string, data: Buffer) => {
    let status = 0;
    let raw = '';
    const headers: Record<string, string> = { 'content-type': contentType, 'x-filename': encodeURIComponent(filename) };
    if (cookie) headers.cookie = cookie;
    const request = Object.assign(Readable.from([data]), {
      url: `/api/tasks/${taskId}/attachments`, method: 'POST', headers, socket: { remoteAddress: '127.0.0.1' },
    });
    const response = { writeHead: (code: number) => { status = code; }, end: (chunk?: unknown) => { raw = String(chunk ?? ''); } };
    await handle(request as never, response as never);
    return { status, json: raw ? JSON.parse(raw) : null };
  };

  // -- comment：匿名 401 --
  assert.strictEqual((await call('GET', `/api/tasks/${authzTaskId}/comments`)).status, 401, '匿名 GET comments 應 401');
  assert.strictEqual((await call('POST', `/api/tasks/${authzTaskId}/comments`, { body: { content: 'x' } })).status, 401, '匿名 POST comment 應 401');

  // -- comment：Viewer POST 403（角色不足）--
  assert.strictEqual(
    (await call('POST', `/api/tasks/${authzTaskId}/comments`, { cookie: authzCookie.viewer, body: { content: 'x' } })).status,
    403,
    'Viewer POST comment 應 403',
  );

  // -- comment：Commenter 自建與自改成功 --
  const created = await call('POST', `/api/tasks/${authzTaskId}/comments`, { cookie: authzCookie.commenterA, body: { content: '第一則留言' } });
  assert.strictEqual(created.status, 201, 'Commenter 建立留言應成功');
  const authzCommentId = (created.json as { id: string }).id;
  assert.strictEqual(
    (await call('PATCH', `/api/comments/${authzCommentId}`, { cookie: authzCookie.commenterA, body: { content: '編輯後' } })).status,
    200,
    'Commenter 編輯自己的留言應成功',
  );

  // -- comment：同 workspace 他人留言 PATCH 403 --
  assert.strictEqual(
    (await call('PATCH', `/api/comments/${authzCommentId}`, { cookie: authzCookie.commenterB, body: { content: '想改別人的' } })).status,
    403,
    '同 workspace 非作者 PATCH 應 403',
  );

  // -- comment：跨 workspace 讀寫 403 --
  assert.strictEqual((await call('GET', `/api/tasks/${authzTaskId}/comments`, { cookie: authzCookie.outsider })).status, 403, '跨 workspace 讀 comments 應 403');
  assert.strictEqual(
    (await call('POST', `/api/tasks/${authzTaskId}/comments`, { cookie: authzCookie.outsider, body: { content: 'x' } })).status,
    403,
    '跨 workspace 寫 comments 應 403',
  );

  // -- comment：空白／過長 content 400 --
  assert.strictEqual((await call('POST', `/api/tasks/${authzTaskId}/comments`, { cookie: authzCookie.commenterA, body: { content: '   ' } })).status, 400, '空白 content 應 400');
  assert.strictEqual(
    (await call('POST', `/api/tasks/${authzTaskId}/comments`, { cookie: authzCookie.commenterA, body: { content: 'x'.repeat(5001) } })).status,
    400,
    '過長 content 應 400',
  );

  // -- comment：DELETE 一律 405 --
  assert.strictEqual((await call('DELETE', `/api/comments/${authzCommentId}`, { cookie: authzCookie.commenterA })).status, 405, 'comment DELETE 應 405');

  // -- comment：輸出欄位不超出既有契約 --
  const commentList = await call('GET', `/api/tasks/${authzTaskId}/comments`, { cookie: authzCookie.commenterA });
  assert.strictEqual(commentList.status, 200);
  const allowedCommentFields = ['comment_id', 'task_id', 'user_id', 'content', 'created_at'].sort();
  for (const row of commentList.json as Record<string, unknown>[]) {
    assert.deepStrictEqual(Object.keys(row).sort(), allowedCommentFields, 'comment 輸出欄位不可超出既有契約');
  }

  // -- task：角色不足（Viewer PATCH）與跨 workspace（outsider GET）403 --
  assert.strictEqual(
    (await call('PATCH', `/api/tasks/${authzTaskId}`, { cookie: authzCookie.viewer, body: { title: 'x' } })).status,
    403,
    'Viewer PATCH task 應 403',
  );
  assert.strictEqual((await call('GET', `/api/tasks/${authzTaskId}`, { cookie: authzCookie.outsider })).status, 403, '跨 workspace GET task 應 403');
  // -- task：Commenter 修改非自己建立 task 的描述，屬 domain 層禁止動作（400，而非角色 403）--
  assert.strictEqual(
    (await call('PATCH', `/api/tasks/${authzTaskId}`, { cookie: authzCookie.commenterA, body: { description: '想改的描述' } })).status,
    400,
    'Commenter 改非自己建立 task 的描述應 400',
  );

  // -- member：角色不足（Viewer 邀請）與跨 workspace（outsider 讀列表）403 --
  assert.strictEqual(
    (await call('POST', `/api/workspaces/${wsA}/members`, { cookie: authzCookie.viewer, body: { email: 'authz-member@test.local', role: 'Member' } })).status,
    403,
    'Viewer 邀請成員應 403',
  );
  assert.strictEqual((await call('GET', `/api/workspaces/${wsA}/members`, { cookie: authzCookie.outsider })).status, 403, '跨 workspace 讀成員列表應 403');
  // -- member：輸出欄位不含 password_hash 等內部欄位 --
  const memberList = await call('GET', `/api/workspaces/${wsA}/members`, { cookie: authzCookie.member });
  assert.strictEqual(memberList.status, 200);
  const allowedMemberFields = ['user_id', 'role', 'joined_at', 'email', 'name'].sort();
  for (const row of memberList.json as Record<string, unknown>[]) {
    assert.deepStrictEqual(Object.keys(row).sort(), allowedMemberFields, 'member 輸出欄位不可含 password_hash 等內部欄位');
  }

  // -- attachment：角色不足（Viewer 上傳）403；Member 上傳成功後跨 workspace 讀 403 --
  assert.strictEqual(
    (await uploadAttachment(authzCookie.viewer, authzTaskId, 'x.txt', 'text/plain', Buffer.from('x'))).status,
    403,
    'Viewer 上傳附件應 403',
  );
  const uploaded = await uploadAttachment(authzCookie.member, authzTaskId, 'note.txt', 'text/plain', Buffer.from('hello'));
  assert.strictEqual(uploaded.status, 201, 'Member 上傳附件應成功');
  const authzAttachmentId = (uploaded.json as { id: string }).id;
  assert.strictEqual((await call('GET', `/api/attachments/${authzAttachmentId}`, { cookie: authzCookie.outsider })).status, 403, '跨 workspace 讀附件應 403');
  // -- attachment：輸出欄位 allowlist，不可外洩磁碟儲存名 stored_name --
  const attachmentList = await call('GET', `/api/tasks/${authzTaskId}/attachments`, { cookie: authzCookie.member });
  assert.strictEqual(attachmentList.status, 200);
  const allowedAttachmentFields = ['attachment_id', 'task_id', 'original_name', 'mime_type', 'size'].sort();
  for (const row of attachmentList.json as Record<string, unknown>[]) {
    assert.deepStrictEqual(Object.keys(row).sort(), allowedAttachmentFields, 'attachment 輸出欄位不可外洩 stored_name');
  }

  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  console.log('server.test.ts OK');
})().catch((e) => { console.error(e); process.exit(1); });
