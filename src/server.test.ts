import assert from 'node:assert';
import { clientIp } from './clientIp';

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

console.log('server.test.ts OK');
