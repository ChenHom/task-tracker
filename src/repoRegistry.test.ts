import assert from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRepoRegistry } from './repoRegistry';
import { CommandError } from './eventStore';

const root = mkdtempSync(join(tmpdir(), 'task-tracker-repos-'));
try {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const registryPath = join(root, 'repos.json');
  writeFileSync(registryPath, JSON.stringify({
    [repo]: { checks: ['npm test'], deployment: 'not_required' },
  }));

  const registry = loadRepoRegistry(registryPath);
  const canonical = realpathSync(repo);
  assert.deepStrictEqual(registry.get(canonical), {
    targetRepo: canonical,
    checks: ['npm test'],
    deployment: 'not_required',
  });

  writeFileSync(registryPath, JSON.stringify({ relative: { checks: ['npm test'], deployment: 'not_required' } }));
  assert.throws(() => loadRepoRegistry(registryPath), CommandError, 'relative repo path 應拒絕');

  writeFileSync(registryPath, JSON.stringify({
    [repo]: { checks: ['rm -rf .'], deployment: 'not_required' },
  }));
  assert.throws(() => loadRepoRegistry(registryPath), /check 不允許/, '任意 shell 指令不可進 registry');

  writeFileSync(registryPath, JSON.stringify({
    [repo]: { checks: ['python3 -m pytest', 'git diff --check'], deployment: 'not_required' },
  }));
  assert.deepStrictEqual(loadRepoRegistry(registryPath).get(canonical)?.checks, ['python3 -m pytest', 'git diff --check'], 'Python repo 可用 pytest');

  writeFileSync(registryPath, JSON.stringify({
    [repo]: { checks: ['npm test'], deployment: 'not_required', allowedPrefixes: ['src/', 'tests/', 'pyproject.toml'] },
  }));
  assert.deepStrictEqual(loadRepoRegistry(registryPath).get(canonical)?.allowedPrefixes, ['src/', 'tests/', 'pyproject.toml'], 'allowedPrefixes 應原樣載入');
  assert.strictEqual(registry.get(canonical)?.allowedPrefixes, undefined, '未設定時不帶 allowedPrefixes');

  for (const bad of [[], 'src/', [1], [''], ['/etc'], ['../x'], ['src/../x'], ['..']]) {
    writeFileSync(registryPath, JSON.stringify({ [repo]: { checks: ['npm test'], deployment: 'not_required', allowedPrefixes: bad } }));
    assert.throws(() => loadRepoRegistry(registryPath), /allowedPrefixes 不合法/, `不合法 allowedPrefixes 應拒絕：${JSON.stringify(bad)}`);
  }

  const withExtra = (extra: Record<string, unknown>) => writeFileSync(registryPath, JSON.stringify({
    [repo]: { checks: ['npm test'], deployment: 'not_required', ...extra },
  }));
  withExtra({
    seedFiles: [{ from: 'data/research.db', to: 'data/_run.db' }],
    workCommands: ['python3 scripts/backtest.py', 'python3 -m research.report --fast'],
  });
  const seeded = loadRepoRegistry(registryPath).get(canonical);
  assert.deepStrictEqual(seeded?.seedFiles, [{ from: 'data/research.db', to: 'data/_run.db' }], 'seedFiles 應原樣載入');
  assert.deepStrictEqual(seeded?.workCommands, ['python3 scripts/backtest.py', 'python3 -m research.report --fast'], 'workCommands 應原樣載入');
  assert.strictEqual(registry.get(canonical)?.seedFiles, undefined, '未設定時不帶 seedFiles');
  assert.strictEqual(registry.get(canonical)?.workCommands, undefined, '未設定時不帶 workCommands');

  for (const bad of [
    [], 'data/x', [{ from: 'a' }], [{ to: 'a' }], [{ from: 'a', to: 1 }], [{ from: '', to: 'b' }], ['a'], [null],
    [{ from: '/etc/passwd', to: 'data/x' }], [{ from: 'data/x', to: '/tmp/x' }],
    [{ from: '../x', to: 'data/x' }], [{ from: 'data/x', to: 'a/../../x' }], [{ from: 'ok', to: '..' }],
  ]) {
    withExtra({ seedFiles: bad });
    assert.throws(() => loadRepoRegistry(registryPath), /seedFiles 不合法/, `不合法 seedFiles 應拒絕：${JSON.stringify(bad)}`);
  }
  for (const bad of [
    [], 'make', [1], [''], ['  '], ['a; rm -rf .'], ['a | b'], ['a && b'], ['echo $HOME'], ['echo `id`'], ['a > out'], ['a < in'], ['a\nb'], ['a\rb'],
  ]) {
    withExtra({ workCommands: bad });
    assert.throws(() => loadRepoRegistry(registryPath), /workCommands 不合法/, `不合法 workCommands 應拒絕：${JSON.stringify(bad)}`);
  }
  // network / denyRead：選填、原樣載入；未設定時不帶欄位（預設行為不變）
  assert.strictEqual(registry.get(canonical)?.network, undefined, '未設定時不帶 network');
  assert.strictEqual(registry.get(canonical)?.denyRead, undefined, '未設定時不帶 denyRead');
  writeFileSync(registryPath, JSON.stringify({
    [repo]: { checks: ['npm test'], deployment: 'not_required', network: false, denyRead: ['Sinopac.pfx', 'secrets/api.key'] },
  }));
  const hardened = loadRepoRegistry(registryPath).get(canonical);
  assert.strictEqual(hardened?.network, false, 'network=false 應原樣載入');
  assert.deepStrictEqual(hardened?.denyRead, ['Sinopac.pfx', 'secrets/api.key'], 'denyRead 應原樣載入');
  writeFileSync(registryPath, JSON.stringify({ [repo]: { checks: ['npm test'], deployment: 'not_required', network: true } }));
  assert.strictEqual(loadRepoRegistry(registryPath).get(canonical)?.network, true, 'network=true 也合法');

  for (const bad of ['false', 0, null, 'no']) {
    writeFileSync(registryPath, JSON.stringify({ [repo]: { checks: ['npm test'], deployment: 'not_required', network: bad } }));
    assert.throws(() => loadRepoRegistry(registryPath), /network 不合法/, `不合法 network 應拒絕：${JSON.stringify(bad)}`);
  }
  for (const bad of [[], 'a.pfx', [1], [''], ['/etc/passwd'], ['../x'], ['a/../x'], ['..'], ['*.pfx'], ['keys/*'], ['a?'], ['k[0]']]) {
    writeFileSync(registryPath, JSON.stringify({ [repo]: { checks: ['npm test'], deployment: 'not_required', denyRead: bad } }));
    assert.throws(() => loadRepoRegistry(registryPath), /denyRead 不合法/, `不合法 denyRead 應拒絕：${JSON.stringify(bad)}`);
  }
  // allowCodex：選填、原樣載入；未設定時不帶欄位（預設允許 codex）
  assert.strictEqual(registry.get(canonical)?.allowCodex, undefined, '未設定時不帶 allowCodex');
  for (const allowCodex of [false, true]) {
    writeFileSync(registryPath, JSON.stringify({ [repo]: { checks: ['npm test'], deployment: 'not_required', allowCodex } }));
    assert.strictEqual(loadRepoRegistry(registryPath).get(canonical)?.allowCodex, allowCodex, `allowCodex=${allowCodex} 應原樣載入`);
  }
  for (const bad of ['false', 0, null, 'no']) {
    writeFileSync(registryPath, JSON.stringify({ [repo]: { checks: ['npm test'], deployment: 'not_required', allowCodex: bad } }));
    assert.throws(() => loadRepoRegistry(registryPath), /allowCodex 不合法/, `不合法 allowCodex 應拒絕：${JSON.stringify(bad)}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('repoRegistry.test.ts OK');
