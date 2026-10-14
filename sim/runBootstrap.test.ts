import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dataDir = mkdtempSync(join(tmpdir(), 'task-tracker-run-bootstrap-test-'));
process.env.TASK_TRACKER_DATA_DIR = dataDir;
process.env.TASK_TRACKER_REPO_REGISTRY_PATH = join(dataDir, 'repos.json');
writeFileSync(process.env.TASK_TRACKER_REPO_REGISTRY_PATH, '{}');

void (async () => {
  try {
    const { handle } = await import('../src/server');
    const { db } = await import('../src/db');
    const { createSession } = await import('../src/auth');
    const { registerWorkspaceProjections } = await import('../src/workspace');
    const { registerMemberProjections } = await import('../src/member');
    const { bootstrapWorkspace } = await import('./run');

    registerWorkspaceProjections();
    registerMemberProjections();

    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES ('user01', 'user01@test.local', 'Owner Agent', 'hash')").run();
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES ('user09', 'user09@test.local', 'Human Boss', 'hash')").run();
    db.prepare(`INSERT INTO agents
      (agent_id, user_id, email, name, role, skill_profile_json, primary_adapter, primary_model, status, created_at, updated_at)
      VALUES ('user01', 'user01', 'user01@test.local', 'Owner Agent', 'owner', '{}', 'claude', 'model', 'active', 't', 't')`).run();

    const statuses: number[] = [];
    const request = async (path: string, init: RequestInit = {}, cookie?: string) => {
      let status = 0;
      let responseBody = '';
      const body = typeof init.body === 'string' ? init.body : '';
      const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
        url: path,
        method: init.method ?? 'GET',
        headers: cookie ? { cookie } : {},
        socket: { remoteAddress: '127.0.0.1' },
      });
      const res = {
        writeHead: (code: number) => { status = code; },
        end: (chunk?: unknown) => { responseBody = String(chunk ?? ''); },
      };
      await handle(req as never, res as never);
      statuses.push(status);
      return { status, body: responseBody ? JSON.parse(responseBody) : null };
    };
    const loginActor = async (email: string) => {
      const row = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string } | undefined;
      assert.ok(row, `fixture 缺少 ${email}`);
      return `session=${createSession(row.id)}`;
    };

    const ownerCookie = await loginActor('user01@test.local');
    const directCreate = await request('/api/workspaces', {
      method: 'POST', body: JSON.stringify({ name: 'Owner forbidden' }),
    }, ownerCookie);
    assert.strictEqual(directCreate.status, 403, 'Owner Agent 直接建立 Workspace 仍應回 403');

    statuses.length = 0;
    const result = await bootstrapWorkspace({ title: 'Sim Workspace', request, loginActor });
    assert.ok(!statuses.includes(403), 'bootstrap 過程不得出現 403');
    const roles = db.prepare(
      `SELECT user_id, role FROM workspace_members_read_model
        WHERE workspace_id = ? AND user_id IN ('user01', 'user09') ORDER BY user_id`,
    ).all(result.workspaceId) as unknown as Array<{ user_id: string; role: string }>;
    assert.deepStrictEqual(roles.map(({ user_id, role }) => ({ user_id, role })), [
      { user_id: 'user01', role: 'Owner' },
      { user_id: 'user09', role: 'Owner' },
    ]);
    console.log('runBootstrap.test.ts OK');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('runBootstrap.test.ts FAILED:', error);
  process.exit(1);
});
