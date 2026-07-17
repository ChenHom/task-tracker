import assert from 'node:assert';
import { clientIp } from './clientIp';
import { handle, taskPatchRole } from './server';

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

assert.strictEqual(taskPatchRole({ description: 'updated' }), 'Commenter');
assert.strictEqual(taskPatchRole({ title: 'renamed' }), 'Member');
assert.strictEqual(taskPatchRole({ status: 'Doing' }), 'Member');
assert.strictEqual(taskPatchRole({ description: 'x', title: 'y' }), 'Member');
assert.strictEqual(taskPatchRole({}), 'Member');

// /api/health 需回報部署中的 git rev，供部署 readback 與 owner live 驗收比對
void (async () => {
  let body = '';
  const req = { url: '/api/health', method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writeHead: () => {}, end: (chunk?: unknown) => { body = String(chunk ?? ''); } };
  await handle(req as never, res as never);
  const health = JSON.parse(body);
  assert.match(String(health.rev), /^[0-9a-f]{7,40}$/, 'health 必須帶 git rev');
  console.log('server.test.ts OK');
})().catch((e) => { console.error(e); process.exit(1); });
