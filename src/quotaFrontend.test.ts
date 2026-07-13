import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

async function main(): Promise<void> {
  const source = readFileSync(join(__dirname, '../public/js/quota-format.js'), 'utf8');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const formatter = await import(moduleUrl) as {
    formatTaipeiResetTime: (value: string | null) => string;
    formatQuotaDetails: (value: unknown) => string;
  };

  assert.strictEqual(
    formatter.formatTaipeiResetTime('2026-07-19T19:00:07.000Z'),
    '2026/07/20 03:00',
  );
  assert.strictEqual(formatter.formatTaipeiResetTime(null), '尚無重置時間');

  assert.strictEqual(formatter.formatQuotaDetails({
    stale: false,
    windows: [
      { window: 'five_hour', remaining: '100%', resetAt: null, available: true },
      { window: 'seven_day', remaining: '14%', resetAt: '2026-07-14T23:00:00.207Z', available: true },
    ],
  }), [
    '5 小時：100% · 尚無重置時間',
    '7 天：14% · 2026/07/15 07:00',
  ].join('\n'));

  assert.strictEqual(formatter.formatQuotaDetails({
    stale: true,
    windows: [
      { window: 'five_hour', remaining: null, resetAt: null, available: false },
      { window: 'seven_day', remaining: '78%', resetAt: '2026-07-19T19:00:07.000Z', available: true },
    ],
  }), [
    '5 小時：尚無資料',
    '7 天：78% · 2026/07/20 03:00',
    '資料可能過期',
  ].join('\n'));

  console.log('quotaFrontend.test.ts OK');
}

void main();
