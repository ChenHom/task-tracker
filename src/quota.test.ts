import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getQuotaSnapshot, type QuotaStatus } from './quota';

async function main(): Promise<void> {
  const tempRoot = mkdtempSync(join(tmpdir(), 'quota-test-'));
  const cacheFile = join(tempRoot, '.cache', 'quota.json');
  let now = Date.parse('2026-07-13T00:00:00.000Z');
  const calls = { codex: 0, claude: 0, agy: 0 };

  const fetchers = {
    codex: async (): Promise<QuotaStatus> => {
      calls.codex += 1;
      return { provider: 'codex', remaining: '80%', resetAt: '2026-07-13T05:00:00.000Z', source: 'codex-live', unavailable: false };
    },
    claude: async (): Promise<QuotaStatus> => {
      calls.claude += 1;
      return { provider: 'claude', remaining: null, resetAt: null, source: 'claude-unavailable', unavailable: true };
    },
    agy: async (): Promise<QuotaStatus> => {
      calls.agy += 1;
      return { provider: 'agy', remaining: null, resetAt: null, source: 'agy-unavailable', unavailable: true };
    },
  };

  const first = await getQuotaSnapshot({ cacheFile, now: () => now, fetchers });
  assert.strictEqual(first.providers.length, 3, '第一次刷新應回三家 provider');
  assert.strictEqual(calls.codex, 1, '第一次刷新應打 codex 一次');
  assert.strictEqual(calls.claude, 1, '第一次刷新應打 claude 一次');
  assert.strictEqual(calls.agy, 1, '第一次刷新應打 agy 一次');
  assert.ok(existsSync(cacheFile), '刷新後應寫出 cache 檔');

  const second = await getQuotaSnapshot({ cacheFile, now: () => now + 60_000, fetchers });
  assert.strictEqual(second.providers[0].remaining, '80%');
  assert.strictEqual(calls.codex, 1, 'cache 未過期不應重打 codex');
  assert.strictEqual(calls.claude, 1, 'cache 未過期不應重打 claude');
  assert.strictEqual(calls.agy, 1, 'cache 未過期不應重打 agy');

  now += 181_000;
  const third = await getQuotaSnapshot({ cacheFile, now: () => now, fetchers });
  assert.strictEqual(third.providers[0].remaining, '80%');
  assert.strictEqual(calls.codex, 2, 'cache 過期後應重新刷新 codex');
  assert.strictEqual(calls.claude, 2, 'cache 過期後應重新刷新 claude');
  assert.strictEqual(calls.agy, 2, 'cache 過期後應重新刷新 agy');

  const failing = await getQuotaSnapshot({
    cacheFile,
    now: () => now + 181_000,
    fetchers: {
      codex: async (): Promise<QuotaStatus> => {
        throw new Error('codex boom');
      },
      claude: fetchers.claude,
      agy: fetchers.agy,
    },
  });
  const codex = failing.providers.find((provider) => provider.provider === 'codex');
  assert.ok(codex, '應回 codex provider');
  assert.strictEqual(codex?.unavailable, true, '單一 provider 失敗時應標 unavailable');
  assert.match(codex?.source ?? '', /codex/i, '失敗時 source 應保留 provider 線索');

  const cache = JSON.parse(readFileSync(cacheFile, 'utf8')) as { providers: QuotaStatus[] };
  assert.strictEqual(cache.providers.length, 3, 'cache 內容也應維持三家 provider');

  console.log('quota.test.ts OK');
}

void main();
