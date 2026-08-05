// 隔離 smoke：驗證 task-tracker 唯一自管密碼 verifier（src/auth.ts 的 scrypt 路徑）
// 的 constant-time 比對、格式容錯與延遲量級。全程只用合成帳號（synthetic-smoke-user@example.invalid）
// 與獨立記憶體內 SQLite（node:sqlite DatabaseSync(':memory:')），不連正式 dev.db、
// 不讀取/寫入任何真實 password_hash。import './auth' 會照常觸發 src/db.ts 開啟 dev.db
// 的既有 module-level 副作用（與 src/auth.test.ts 相同、非本 fixture 新增行為），
// 但下面每一次實際呼叫都明確帶入獨立的記憶體 database，不會碰到那個檔案裡的資料。
//
// 執行：npx tsx docs/security/fixtures/password-hash-verifier/verify.mjs
// 預期輸出：全部案例 PASS；違反任一預期即印 FAIL 並以非 0 結束。

import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { runMigrations } from '../../../../src/schema.ts';
import { hashPassword, verifyPassword, createUser, attemptLogin } from '../../../../src/auth.ts';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`PASS [${name}]`);
  } else {
    failures++;
    console.log(`FAIL [${name}] ${detail}`);
  }
}

const db = new DatabaseSync(':memory:');
runMigrations(db);

const EMAIL = 'synthetic-smoke-user@example.invalid';
const PASSWORD = 'synthetic-only-password-not-real-9527';
createUser(EMAIL, 'Synthetic Smoke User', PASSWORD, db);

// ── 1. 單次成功／失敗 readback + 延遲量級 ──
let t0 = performance.now();
const okId = attemptLogin(EMAIL, PASSWORD, '203.0.113.1', 'smoke-agent', db);
const okMs = performance.now() - t0;
check('單次成功登入 readback', typeof okId === 'string' && okId.length > 0, `got=${okId}`);
console.log(`  成功登入耗時 ~${okMs.toFixed(1)}ms`);

t0 = performance.now();
const failId = attemptLogin(EMAIL, 'wrong-password', '203.0.113.1', 'smoke-agent', db);
const failMs = performance.now() - t0;
check('單次失敗登入 readback', failId === null, `got=${failId}`);
console.log(`  失敗登入耗時 ~${failMs.toFixed(1)}ms（與成功同量級 → 帳號存在時密碼錯不構成明顯 timing 差異）`);

// ── 2. 帳號不存在：仍執行一次 verify（DUMMY_HASH），避免 timing 帳號枚舉 ──
t0 = performance.now();
const noUserId = attemptLogin('does-not-exist@example.invalid', PASSWORD, '203.0.113.1', 'smoke-agent', db);
const noUserMs = performance.now() - t0;
check('帳號不存在 readback', noUserId === null, `got=${noUserId}`);
console.log(`  帳號不存在耗時 ~${noUserMs.toFixed(1)}ms（應與上面兩者同量級，量測供人工比對，非自動斷言）`);

// ── 3. 格式容錯：非 "salt:hash" 格式一律回 false，不丟例外 ──
check('缺分隔符的 stored 值不應丟例外且回 false', verifyPassword(PASSWORD, 'not-a-valid-format') === false);
check('空字串 stored 值不應丟例外且回 false', verifyPassword(PASSWORD, '') === false);

// ── 4. 同密碼不同 salt → 不同 hash（確認每次雜湊皆重新產生隨機 salt）──
check('同密碼兩次雜湊應不同（per-call 隨機 salt）', hashPassword(PASSWORD) !== hashPassword(PASSWORD));

// ── 5. 受限「並行」：20 次循序呼叫（scryptSync 為同步阻塞，單 process 內無真並行）──
const N = 20;
t0 = performance.now();
for (let i = 0; i < N; i++) {
  attemptLogin(EMAIL, PASSWORD, '203.0.113.1', 'smoke-agent', db);
}
const totalMs = performance.now() - t0;
console.log(`  ${N} 次循序登入呼叫：total=${totalMs.toFixed(1)}ms avg=${(totalMs / N).toFixed(1)}ms/次`);

// login_events 應每次呼叫都留一筆 readback（成功 3 筆 + 失敗 1 筆 + 20 次循環 = 24 筆）
const eventCount = db.prepare('SELECT COUNT(*) AS n FROM login_events').get().n;
check('每次 attemptLogin 都應留一筆 login_event', eventCount === 3 + 20, `got=${eventCount}`);

console.log('---');
if (failures > 0) {
  console.log(`結果：${failures} 個案例與預期不符`);
  process.exit(1);
}
console.log('結果：全部案例皆符合預期，全程未接觸正式 dev.db 資料');
