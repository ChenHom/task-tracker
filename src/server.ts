import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from './db';
import { resolveSafePath } from './staticPath';
import { runWithRequestContext } from './requestContext';
import {
  attemptLogin,
  createSession,
  destroySession,
  parseCookies,
  sessionCookie,
  clearSessionCookie,
  requireAuth,
  SESSION_COOKIE,
} from './auth';
import { CommandError } from './eventStore';
import { createWorkspace, renameWorkspace, listWorkspaces, registerWorkspaceProjections } from './workspace';
import { registerMemberProjections, requirePermission } from './member';
import {
  createTask,
  applyTaskPatch,
  archiveTask,
  deleteTask,
  listTasks,
  getTaskWorkspaceId,
  registerTaskProjections,
  type CreateTaskInput,
} from './task';
import { createProject, listProjects, renameProject, deleteProject, getProjectWorkspaceId } from './project';
import { createComment, listComments, updateComment, deleteComment, getCommentContext } from './comment';
import { createAttachment, listAttachments, readAttachment, deleteAttachment, getAttachmentContext } from './attachment';
import { searchWorkspace } from './search';
import { getAggregateWorkspace, getAuditTrail } from './audit';
import { createRateLimiter } from './rateLimit';

// 登入 rate limit：每 IP 15 分鐘最多 10 次失敗（成功清零），擋密碼暴力破解。
const loginLimiter = createRateLimiter(15 * 60 * 1000, 10);

// ponytail: 上傳檔案上限 10MB，超過丟 413。正式環境可改成 nginx / cloudflare 直接擋。
const uploadMaxBytes = 10 * 1024 * 1024; // 10MB

// CSRF：mutating 請求若帶 Origin，必須同源。無 Origin（curl/API client）放行——SameSite=Strict cookie 是主防線。
function isCsrfSafe(req: IncomingMessage): boolean {
  const m = req.method ?? 'GET';
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

registerWorkspaceProjections();
registerMemberProjections();
registerTaskProjections();

// 統一把 command 錯誤映射成 HTTP：CommandError → 400，其餘 → 500。
function sendCommandError(res: ServerResponse, e: unknown): void {
  const status = e instanceof CommandError ? 400 : 500;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: e instanceof CommandError ? e.message : '內部錯誤' }));
}

const PUBLIC_DIR = join(__dirname, '../public');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// ponytail: body 上限 1MB，擋掉超大 payload；真要調大等有需求再說。
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new Error('payload too large');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function clientIp(req: IncomingMessage): string | null {
  // ponytail: 直取 socket；正式環境過 reverse proxy 要改信任 X-Forwarded-For。
  return req.socket.remoteAddress ?? null;
}

// 讀原始位元組（attachment 上傳）。超過上限丟錯 → 413。
// ponytail: 用 raw body + X-Filename header，避開自刻 multipart parser；正式環境改用表單/multipart。
async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) throw new Error('payload too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isCsrfSafe(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'CSRF 檢查失敗（Origin 不符）' }));
    return;
  }

  if (req.url === '/api/health') {
    const row = db.prepare('SELECT 1 AS ok').get() as { ok: number };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', db: row.ok === 1 }));
    return;
  }

  if (req.url === '/api/auth/login' && req.method === 'POST') {
    const ip = clientIp(req) ?? 'unknown';
    if (!loginLimiter.check(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '登入嘗試過於頻繁，請稍後再試' }));
      return;
    }
    const body = (await readJson(req).catch(() => null)) as { email?: unknown; password?: unknown } | null;
    if (!body || typeof body.email !== 'string' || typeof body.password !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'email 與 password 為必填' }));
      return;
    }
    const userId = attemptLogin(body.email, body.password, ip, req.headers['user-agent'] ?? null);
    if (!userId) {
      loginLimiter.fail(ip);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '帳號或密碼錯誤' })); // 不透露 email 是否存在
      return;
    }
    loginLimiter.reset(ip); // 成功清零失敗計數
    // session fixation 防護：廢棄登入前的舊 session，認證後一律用全新 id。
    const oldToken = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (oldToken) destroySession(oldToken);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie(createSession(userId)) });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url === '/api/auth/logout' && req.method === 'POST') {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) destroySession(token);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': clearSessionCookie() });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url === '/api/workspaces') {
    const userId = requireAuth(req, res);
    if (!userId) return; // requireAuth 已寫 401

    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(listWorkspaces(userId)));
      return;
    }
    if (req.method === 'POST') {
      const body = (await readJson(req).catch(() => null)) as { name?: unknown } | null;
      try {
        const id = createWorkspace(userId, body?.name);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id }));
      } catch (e) {
        const status = e instanceof CommandError ? 400 : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e instanceof CommandError ? e.message : '內部錯誤' }));
      }
      return;
    }
  }

  // PATCH /api/workspaces/:id —— 改名，需該 workspace 的 Admin 以上（demo requirePermission）。
  const patchMatch = req.url?.match(/^\/api\/workspaces\/([^/?]+)$/);
  if (patchMatch && req.method === 'PATCH') {
    const workspaceId = patchMatch[1];
    const userId = requirePermission(req, res, workspaceId, 'Admin');
    if (!userId) return; // requirePermission 已寫 401/403
    const body = (await readJson(req).catch(() => null)) as { name?: unknown } | null;
    try {
      renameWorkspace(userId, workspaceId, body?.name);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      const status = e instanceof CommandError ? 400 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e instanceof CommandError ? e.message : '內部錯誤' }));
    }
    return;
  }

  // ── Task API（全部透過 command，read model 只讀）─────────────────
  // 列表 / 建立：scoped 在 workspace 底下，權限查該 workspace。
  const wsTasksMatch = req.url?.match(/^\/api\/workspaces\/([^/?]+)\/tasks$/);
  if (wsTasksMatch) {
    const workspaceId = wsTasksMatch[1];
    if (req.method === 'GET') {
      const userId = requirePermission(req, res, workspaceId, 'Viewer');
      if (!userId) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(listTasks(workspaceId)));
      return;
    }
    if (req.method === 'POST') {
      const userId = requirePermission(req, res, workspaceId, 'Member');
      if (!userId) return;
      const body = (await readJson(req).catch(() => null)) as CreateTaskInput | null;
      try {
        const id = createTask(userId, workspaceId, body ?? {});
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id }));
      } catch (e) {
        sendCommandError(res, e);
      }
      return;
    }
  }

  // 單一 task 操作：先查資源歸屬的 workspace 再驗權限（資源同 workspace 檢查 → 跨 workspace 403/404）。
  const taskMatch = req.url?.match(/^\/api\/tasks\/([^/?]+)$/);
  if (taskMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const taskId = taskMatch[1];
    const workspaceId = getTaskWorkspaceId(taskId);
    if (!workspaceId) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'task 不存在' }));
      return;
    }
    const userId = requirePermission(req, res, workspaceId, 'Member');
    if (!userId) return;
    try {
      if (req.method === 'DELETE') {
        deleteTask(userId, taskId);
      } else {
        const body = (await readJson(req).catch(() => null)) as Record<string, unknown> | null;
        applyTaskPatch(userId, taskId, body ?? {});
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      sendCommandError(res, e);
    }
    return;
  }

  const archiveMatch = req.url?.match(/^\/api\/tasks\/([^/?]+)\/archive$/);
  if (archiveMatch && req.method === 'POST') {
    const taskId = archiveMatch[1];
    const workspaceId = getTaskWorkspaceId(taskId);
    if (!workspaceId) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'task 不存在' }));
      return;
    }
    const userId = requirePermission(req, res, workspaceId, 'Member');
    if (!userId) return;
    try {
      archiveTask(userId, taskId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      sendCommandError(res, e);
    }
    return;
  }

  // ── Project API（傳統 CRUD，不走 ES）───────────────────────────
  const wsProjectsMatch = req.url?.match(/^\/api\/workspaces\/([^/?]+)\/projects$/);
  if (wsProjectsMatch) {
    const workspaceId = wsProjectsMatch[1];
    if (req.method === 'GET') {
      const userId = requirePermission(req, res, workspaceId, 'Viewer');
      if (!userId) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(listProjects(workspaceId)));
      return;
    }
    if (req.method === 'POST') {
      const userId = requirePermission(req, res, workspaceId, 'Member');
      if (!userId) return;
      const body = (await readJson(req).catch(() => null)) as { name?: unknown } | null;
      try {
        const id = createProject(workspaceId, body?.name);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id }));
      } catch (e) {
        sendCommandError(res, e);
      }
      return;
    }
  }

  // 單一 project 操作：先查資源歸屬的 workspace 再驗權限（資源同 workspace 檢查）。
  const projectMatch = req.url?.match(/^\/api\/projects\/([^/?]+)$/);
  if (projectMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const projectId = projectMatch[1];
    const workspaceId = getProjectWorkspaceId(projectId);
    if (!workspaceId) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'project 不存在' }));
      return;
    }
    const userId = requirePermission(req, res, workspaceId, 'Member');
    if (!userId) return;
    try {
      if (req.method === 'DELETE') {
        deleteProject(projectId);
      } else {
        const body = (await readJson(req).catch(() => null)) as { name?: unknown } | null;
        renameProject(projectId, body?.name);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      sendCommandError(res, e);
    }
    return;
  }

  // ── Comment API（傳統 CRUD，不走 ES；權限經 task → workspace）────
  const taskCommentsMatch = req.url?.match(/^\/api\/tasks\/([^/?]+)\/comments$/);
  if (taskCommentsMatch) {
    const taskId = taskCommentsMatch[1];
    const workspaceId = getTaskWorkspaceId(taskId);
    if (!workspaceId) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'task 不存在' }));
      return;
    }
    if (req.method === 'GET') {
      const userId = requirePermission(req, res, workspaceId, 'Viewer');
      if (!userId) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(listComments(taskId)));
      return;
    }
    if (req.method === 'POST') {
      const userId = requirePermission(req, res, workspaceId, 'Member');
      if (!userId) return;
      const body = (await readJson(req).catch(() => null)) as { content?: unknown } | null;
      try {
        const id = createComment(taskId, userId, body?.content);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id }));
      } catch (e) {
        sendCommandError(res, e);
      }
      return;
    }
  }

  // 單一 comment：workspace 角色(Member) + ownership（只能改/刪自己的留言）。
  const commentMatch = req.url?.match(/^\/api\/comments\/([^/?]+)$/);
  if (commentMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const commentId = commentMatch[1];
    const ctx = getCommentContext(commentId);
    if (!ctx) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'comment 不存在' }));
      return;
    }
    const userId = requirePermission(req, res, ctx.workspace_id, 'Member');
    if (!userId) return;
    if (ctx.user_id !== userId) {
      // ponytail: 只允許作者本人。版主刪他人留言（Admin+ moderation）等有需求再加。
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '只能修改自己的留言' }));
      return;
    }
    try {
      if (req.method === 'DELETE') {
        deleteComment(commentId);
      } else {
        const body = (await readJson(req).catch(() => null)) as { content?: unknown } | null;
        updateComment(commentId, body?.content);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      sendCommandError(res, e);
    }
    return;
  }

  // ── Attachment API ──────────────────────────────────────────────
  // 上傳：raw body = 檔案內容；X-Filename header = 原始檔名；Content-Type = 宣告 MIME。
  const taskAttachMatch = req.url?.match(/^\/api\/tasks\/([^/?]+)\/attachments$/);
  if (taskAttachMatch) {
    const taskId = taskAttachMatch[1];
    const workspaceId = getTaskWorkspaceId(taskId);
    if (!workspaceId) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'task 不存在' }));
      return;
    }
    if (req.method === 'GET') {
      const userId = requirePermission(req, res, workspaceId, 'Viewer');
      if (!userId) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(listAttachments(taskId)));
      return;
    }
    if (req.method === 'POST') {
      const userId = requirePermission(req, res, workspaceId, 'Member');
      if (!userId) return;
      let data: Buffer;
      try {
        data = await readBody(req, uploadMaxBytes);
      } catch {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '檔案過大' }));
        return;
      }
      const filenameHeader = req.headers['x-filename'];
      const filename = typeof filenameHeader === 'string' ? decodeURIComponent(filenameHeader) : 'file';
      try {
        const id = createAttachment(taskId, filename, req.headers['content-type'], data);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id }));
      } catch (e) {
        sendCommandError(res, e);
      }
      return;
    }
  }

  // 下載 / 刪除單一 attachment：先查歸屬 workspace 驗權限。
  const attachMatch = req.url?.match(/^\/api\/attachments\/([^/?]+)$/);
  if (attachMatch && (req.method === 'GET' || req.method === 'DELETE')) {
    const attachmentId = attachMatch[1];
    const ctx = getAttachmentContext(attachmentId);
    if (!ctx) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'attachment 不存在' }));
      return;
    }
    if (req.method === 'GET') {
      const userId = requirePermission(req, res, ctx.workspace_id, 'Viewer');
      if (!userId) return;
      try {
        const file = readAttachment(attachmentId);
        if (!file) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'attachment 不存在' }));
          return;
        }
        // 一律 nosniff + attachment：防止上傳內容被瀏覽器當頁面/腳本執行（stored XSS）。
        res.writeHead(200, {
          'Content-Type': file.mime,
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
        });
        res.end(file.data);
      } catch (e) {
        sendCommandError(res, e);
      }
      return;
    }
    // DELETE
    const userId = requirePermission(req, res, ctx.workspace_id, 'Member');
    if (!userId) return;
    try {
      deleteAttachment(attachmentId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      sendCommandError(res, e);
    }
    return;
  }

  // ── Search API：GET /api/search?workspace=:wid&q=... （scoped 在 workspace）──
  if (req.url?.match(/^\/api\/search(\?|$)/) && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const workspaceId = u.searchParams.get('workspace');
    if (!workspaceId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '缺 workspace 參數' }));
      return;
    }
    const userId = requirePermission(req, res, workspaceId, 'Viewer');
    if (!userId) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(searchWorkspace(workspaceId, u.searchParams.get('q'))));
    return;
  }

  // ── Audit API：GET /api/audit?aggregate_id=... → 直接查 event_store（審計來源）──
  // 授權：推導該 aggregate 歸屬的 workspace，需 Admin+（audit 揭露所有操作者行為）；跨 workspace 被擋。
  if (req.url?.match(/^\/api\/audit(\?|$)/) && req.method === 'GET') {
    const aggregateId = new URL(req.url, 'http://localhost').searchParams.get('aggregate_id');
    if (!aggregateId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '缺 aggregate_id 參數' }));
      return;
    }
    const workspaceId = getAggregateWorkspace(aggregateId);
    if (!workspaceId) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'aggregate 不存在' }));
      return;
    }
    const userId = requirePermission(req, res, workspaceId, 'Admin');
    if (!userId) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getAuditTrail(aggregateId)));
    return;
  }

  const filePath = resolveSafePath(PUBLIC_DIR, req.url ?? '/');
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' ,
      'x-content-type-options': 'nosniff'
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// 每個 request 開一個 context：ip / user_agent / request_id 供 command 的 metadata（audit）取用。
const server = createServer((req, res) => {
  const requestId = randomUUID();
  res.setHeader('X-Request-Id', requestId);
  runWithRequestContext(
    { ip: clientIp(req), userAgent: req.headers['user-agent'] ?? null, requestId },
    () => handle(req, res),
  );
});

const PORT = 3000;
server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
