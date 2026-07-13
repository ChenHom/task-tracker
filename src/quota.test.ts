import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getQuotaSnapshot } from './quota';

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'quota-adapter-test-'));
  const stateFile = join(root, 'quota.json');
  writeFileSync(stateFile, JSON.stringify(snapshotFixture()));

  const snapshot = await getQuotaSnapshot({ stateFile });
  assert.strictEqual(snapshot.cachedAt, '2026-07-13T06:20:26.859Z');
  assert.deepStrictEqual(snapshot.providers.map((provider) => provider.provider), ['codex', 'claude', 'agy']);

  const codex = snapshot.providers[0];
  assert.strictEqual(codex.remaining, '78%', 'Codex 缺少五小時視窗時應 fallback 七天');
  assert.strictEqual(codex.resetAt, '2026-07-19T19:00:07.000Z');
  assert.strictEqual(codex.unavailable, false);
  assert.strictEqual(codex.stale, false);
  assert.deepStrictEqual(codex.windows, [
    { window: 'five_hour', remaining: null, resetAt: null, available: false },
    { window: 'seven_day', remaining: '78%', resetAt: '2026-07-19T19:00:07.000Z', available: true },
  ]);

  const claude = snapshot.providers[1];
  assert.strictEqual(claude.remaining, '100%', 'Claude 有五小時視窗時應優先顯示');
  assert.strictEqual(claude.resetAt, null, '有效視窗可沒有 active reset time');
  assert.deepStrictEqual(claude.windows, [
    { window: 'five_hour', remaining: '100%', resetAt: null, available: true },
    { window: 'seven_day', remaining: '14%', resetAt: '2026-07-14T23:00:00.207Z', available: true },
  ]);

  const agy = snapshot.providers[2];
  assert.strictEqual(agy.remaining, '64%', 'agy 只有五小時視窗時應直接顯示');
  assert.strictEqual(agy.resetAt, '2026-07-13T23:59:59.000Z');
  assert.strictEqual(agy.unavailable, false);
  assert.strictEqual(agy.stale, false);
  assert.deepStrictEqual(agy.windows, [
    { window: 'five_hour', remaining: '64%', resetAt: '2026-07-13T23:59:59.000Z', available: true },
    { window: 'seven_day', remaining: null, resetAt: null, available: false },
  ]);

  const staleFixture = snapshotFixture();
  staleFixture.providers.codex.status = 'stale';
  staleFixture.providers.agy.status = 'stale';
  writeFileSync(stateFile, JSON.stringify(staleFixture));
  const stale = await getQuotaSnapshot({ stateFile });
  assert.strictEqual(stale.providers[0].remaining, '78%', 'stale 應保留最後成功資料');
  assert.strictEqual(stale.providers[0].stale, true);
  assert.strictEqual(stale.providers[0].unavailable, false);
  assert.strictEqual(stale.providers[2].stale, true, 'agy stale 仍應保留 windows 資料');
  assert.strictEqual(stale.providers[2].remaining, '64%');
  assert.deepStrictEqual(stale.providers[2].windows, agy.windows);

  const noAgyFixture = snapshotFixture();
  delete (noAgyFixture.providers as Record<string, unknown>).agy;
  writeFileSync(stateFile, JSON.stringify(noAgyFixture));
  const noAgy = await getQuotaSnapshot({ stateFile });
  assert.strictEqual(noAgy.providers[2].unavailable, true, '快照不含 agy 時應視為 unavailable（部署相容性）');
  assert.strictEqual(noAgy.providers[2].source, 'ai-quota-agy-missing');
  assert.strictEqual(noAgy.providers[0].remaining, '78%', '缺 agy 不應影響 codex');
  assert.strictEqual(noAgy.providers[1].remaining, '100%', '缺 agy 不應影響 claude');

  const missing = await getQuotaSnapshot({ stateFile: join(root, 'missing.json') });
  assert.strictEqual(missing.providers.length, 3);
  assert.ok(missing.providers.every((provider) => provider.unavailable));
  assert.ok(missing.providers.every((provider) => provider.stale));

  writeFileSync(stateFile, '{bad json');
  const malformed = await getQuotaSnapshot({ stateFile });
  assert.ok(malformed.providers.every((provider) => provider.unavailable));

  console.log('quota.test.ts OK');
}

function snapshotFixture() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-13T06:20:26.859Z',
    providers: {
      codex: provider('codex', {
        five_hour: null,
        seven_day: { usedPercent: 22, remainingPercent: 78, resetsAt: '2026-07-19T19:00:07.000Z' },
      }),
      claude: provider('claude', {
        five_hour: { usedPercent: 0, remainingPercent: 100, resetsAt: null },
        seven_day: { usedPercent: 86, remainingPercent: 14, resetsAt: '2026-07-14T23:00:00.207Z' },
      }),
      agy: {
        ...provider('agy', {
          five_hour: { usedPercent: 36, remainingPercent: 64, resetsAt: '2026-07-13T23:59:59.000Z' },
          seven_day: null,
        }),
        source: 'daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels#model=gemini-3-flash-agent',
      },
    },
  };
}

function provider(providerName: 'codex' | 'claude' | 'agy', windows: Record<string, unknown>) {
  return {
    provider: providerName,
    status: 'ok',
    confidence: 'experimental',
    source: `${providerName}-source`,
    lastAttemptAt: '2026-07-13T06:20:26.859Z',
    lastSuccessAt: '2026-07-13T06:20:26.859Z',
    nextAllowedAt: null,
    consecutiveFailures: 0,
    windows,
    raw: {},
    error: null,
  };
}

void main();
