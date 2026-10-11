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
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('repoRegistry.test.ts OK');
