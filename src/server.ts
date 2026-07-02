import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { db } from './db';
import { resolveSafePath } from './staticPath';

const PUBLIC_DIR = join(__dirname, '../public');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = createServer(async (req, res) => {
  if (req.url === '/api/health') {
    const row = db.prepare('SELECT 1 AS ok').get() as { ok: number };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', db: row.ok === 1 }));
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
