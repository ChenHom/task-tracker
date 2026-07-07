import assert from 'node:assert';
import { resolveSafePath } from './staticPath';

const PUBLIC = '/app/public';

assert.strictEqual(resolveSafePath(PUBLIC, '/'), '/app/public/index.html');
assert.strictEqual(resolveSafePath(PUBLIC, '/app.js'), '/app/public/app.js');
assert.strictEqual(resolveSafePath(PUBLIC, '/../server.ts'), null);
assert.strictEqual(resolveSafePath(PUBLIC, '/..%2f..%2fetc%2fpasswd'), null);
// 未覆蓋變形：多重 ../../ 疊加
assert.strictEqual(resolveSafePath(PUBLIC, '/../../etc/passwd'), null);
// 未覆蓋變形：雙斜線開頭的穿越
assert.strictEqual(resolveSafePath(PUBLIC, '///../etc/passwd'), null);

console.log('staticPath.test.ts OK');
