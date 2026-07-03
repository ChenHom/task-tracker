import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { db } from './db';
import { resolveSafePath } from './staticPath';
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

registerWorkspaceProjections();
registerMemberProjections();
registerTaskProjections();

// 統一把 command 錯誤映射成 HTTP：CommandError → 400，其餘 → 500。
function sendCommandError(res: import('node:http').ServerResponse, e: unknown): void {
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

const server = createServer(async (req, res) => {
  if (req.url === '/api/health') {
    const row = db.prepare('SELECT 1 AS ok').get() as { ok: number };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', db: row.ok === 1 }));
    return;
  }

  if (req.url === '/api/auth/login' && req.method === 'POST') {
    const body = (await readJson(req).catch(() => null)) as { email?: unknown; password?: unknown } | null;
    if (!body || typeof body.email !== 'string' || typeof body.password !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'email 與 password 為必填' }));
      return;
    }
    const userId = attemptLogin(body.email, body.password, clientIp(req), req.headers['user-agent'] ?? null);
    if (!userId) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '帳號或密碼錯誤' })); // 不透露 email 是否存在
      return;
    }
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
});

const PORT = 3000;
server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
