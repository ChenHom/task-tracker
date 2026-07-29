/**
 * 真實 AI smoke test。⚠️ 會花錢，因此刻意不進 `npm test`。
 *
 *   npx tsx sim/production/runner.smoke.ts
 *
 * 為什麼要有這支：production coordinator 的 AI 整合點從 2026-07-22 寫好到 07-29
 * 都是壞的（CLI 從未注入 runner），而 328KB 的單元／整合測試全綠——因為它們注入
 * 假 runner，從不真的呼叫 AI。runner.test.ts 同樣只能測純函式。這支是唯一會證明
 * 「prompt 講的話，真的 AI 真的照做」的東西。改過 prompt 或 parser 就跑一次。
 *
 * 零副作用：兩個 session 的 worktree 都是 os.tmpdir() 底下的拋棄式目錄，不碰看板、
 * 不碰這個 repo。
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemberSessionRunner, createOwnerSessionRunner } from './runner';

const REPO_ROOT = join(__dirname, '../..');
const repoStatus = (): string => execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });

async function smokeOwner(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-owner-'));
  writeFileSync(join(dir, 'change.txt'), 'export const answer = 42;\n');
  const headSha = 'deadbeef1234';

  const started = Date.now();
  const result = await createOwnerSessionRunner()({
    taskId: 'smoke-owner-0000',
    acceptanceCriteria: 'change.txt 必須匯出 answer 常數，值為 42。',
    comments: ['已完成，請驗收。'],
    reviewedHeadSha: headSha,
    worktreePath: dir,
  });

  console.log(`[owner] ${Math.round((Date.now() - started) / 1000)}s exit=${result.exitCode} action=${result.decision.action}`);
  console.log(`[owner] rationale: ${result.decision.rationale}`);
  console.log(`[owner] evidenceCommentIds: ${JSON.stringify(result.decision.evidenceCommentIds)}`);

  assert.strictEqual(result.exitCode, 0, 'owner session 應該正常結束');
  // agent.ts 的 runOwnerSession 會擋掉沒有引用 head SHA 的 accept；prompt 必須讓 AI
  // 真的照做，否則每次驗收都會被判定無效。
  if (result.decision.action === 'accept') {
    assert.ok(
      result.decision.rationale.includes(headSha),
      `accept 決策的 rationale 必須引用 head SHA ${headSha}，實際：${result.decision.rationale}`,
    );
  }
}

async function smokeMember(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-member-'));
  writeFileSync(join(dir, 'greet.js'), 'function greet(name) {\n  return "Hello " + nam;\n}\nmodule.exports = { greet };\n');

  const started = Date.now();
  const result = await createMemberSessionRunner()({
    taskId: 'smoke-member-0000',
    acceptanceCriteria: 'greet.js 有一個錯字：變數 nam 應該是 name。修好它。',
    comments: ['請只改這一個錯字，不要改動其他行為。'],
    allowedPrefixes: ['greet.js'],
    verificationCommandAllowlist: ['node -e "console.log(require(\'./greet\').greet(\'x\'))"'],
    worktreePath: dir,
  });

  console.log(`[member] ${Math.round((Date.now() - started) / 1000)}s exit=${result.exitCode} blocker=${result.output.blocker}`);
  console.log(`[member] summary: ${result.output.summary}`);
  console.log(`[member] changedPaths: ${JSON.stringify(result.output.changedPaths)}`);

  assert.strictEqual(result.exitCode, 0, 'member session 應該正常結束');
  assert.strictEqual(result.output.blocker, null, 'member 不該在這麼簡單的題目上卡住');
  // 不信任 runner 自稱，直接讀檔驗證它真的改了東西。
  const content = readFileSync(join(dir, 'greet.js'), 'utf8');
  // 詞邊界：`name` 裡也含有子字串 `nam`，用 includes 檢查會誤判成「沒修好」。
  assert.ok(!/\bnam\b/u.test(content), `錯字未修好：\n${content}`);
  assert.ok(/\bname\b/u.test(content), `變數不見了：\n${content}`);
}

/**
 * production 的 owner_dispatch 路徑（sim/production.ts:1021-1027）傳的是空的
 * worktreePath、空 comments、空 reviewedHeadSha，acceptanceCriteria 只有 task 標題。
 * 上面兩個 case 都傳真的 tmpdir，所以完全沒有涵蓋到這個形狀——2026-07-29 的沙箱缺陷
 * 就是這樣漏掉的：cwd:'' 會 fallback 到 repo root。這個 case 專門鎖住它。
 */
async function smokeDispatchShape(): Promise<void> {
  const before = repoStatus();

  const started = Date.now();
  const result = await createOwnerSessionRunner()({
    taskId: 'smoke-dispatch-000',
    acceptanceCriteria: '[討論] 通知列表要有分頁',
    comments: [],
    reviewedHeadSha: '',
    worktreePath: '',
  });

  console.log(`[dispatch] ${Math.round((Date.now() - started) / 1000)}s exit=${result.exitCode} action=${result.decision.action}`);
  console.log(`[dispatch] rationale: ${result.decision.rationale}`);

  assert.strictEqual(result.exitCode, 0, '沒有 worktree 的 owner session 也要能正常結束');
  assert.ok(result.decision.rationale.length > 0, 'dispatch 路徑唯一會被使用的輸出就是 rationale');
  // 「沒有汙染 repo」唯一可獨立驗證的信號。
  assert.strictEqual(
    repoStatus(),
    before,
    'owner session 不得改動 repo working tree——cwd 必須落在拋棄式目錄，不是 repo root',
  );
}

(async () => {
  await smokeOwner();
  await smokeMember();
  await smokeDispatchShape();
  console.log('sim/production/runner.smoke.ts OK');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
