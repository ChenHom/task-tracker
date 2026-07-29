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
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemberSessionRunner, createOwnerSessionRunner } from './runner';

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

(async () => {
  await smokeOwner();
  await smokeMember();
  console.log('sim/production/runner.smoke.ts OK');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
