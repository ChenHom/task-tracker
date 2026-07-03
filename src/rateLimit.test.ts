import assert from 'node:assert';
import { createRateLimiter } from './rateLimit';

const rl = createRateLimiter(1000, 3); // 窗口 1000ms、上限 3

// ── 額度內放行、達上限擋 ──
assert.ok(rl.check('a', 0), '第 1 次應放行');
rl.fail('a', 0);
rl.fail('a', 0);
rl.fail('a', 0); // count = 3
assert.ok(!rl.check('a', 0), '達上限應擋');

// ── 不同 key 各自獨立 ──
assert.ok(rl.check('b', 0), '另一 key 不受 a 影響');

// ── 窗口過期後重置 ──
assert.ok(rl.check('a', 1001), '過了窗口應重新放行');

// ── reset 立即清零 ──
rl.fail('b', 0);
rl.fail('b', 0);
rl.fail('b', 0);
assert.ok(!rl.check('b', 0), 'b 達上限');
rl.reset('b');
assert.ok(rl.check('b', 0), 'reset 後放行');

console.log('rateLimit.test.ts OK');
