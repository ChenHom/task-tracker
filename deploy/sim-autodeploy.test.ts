import { strict as assert } from 'node:assert';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = mkdtempSync(join(tmpdir(), 'task-tracker-autodeploy-'));
const binDir = join(tempRoot, 'bin');
const stateDir = join(tempRoot, 'state');
const repoDir = join(tempRoot, 'repo');
const revSeenFile = join(tempRoot, 'rev-seen');
const serviceLog = join(tempRoot, 'service.log');
const oldRev = 'head-before-wait';
const newRev = 'head-after-wait';

const writeExecutable = (name: string, body: string) => {
  const path = join(binDir, name);
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path, 0o755);
};

try {
  writeFileSync(join(tempRoot, '.keep'), '');
  for (const directory of [binDir, stateDir, repoDir]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, '.keep'), '');
  }
  mkdirSync(join(repoDir, 'sim'), { recursive: true });
  writeFileSync(join(repoDir, 'sim/notify-human.sh'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(join(repoDir, 'sim/notify-human.sh'), 0o755);
  writeFileSync(join(stateDir, 'deployed_rev'), 'already-deployed');

  writeExecutable('git', `
if [[ "${'$'}*" == "rev-parse master" ]]; then
  if [[ -e "${'$'}TEST_REV_SEEN_FILE" ]]; then
    printf '%s\\n' "${'$'}TEST_NEW_REV"
  else
    touch "${'$'}TEST_REV_SEEN_FILE"
    printf '%s\\n' "${'$'}TEST_OLD_REV"
  fi
else
  exit 2
fi
`);
  writeExecutable('npm', 'printf \'build\\n\' >>"$TEST_SERVICE_LOG"');
  writeExecutable('systemctl', 'printf \'restart\\n\' >>"$TEST_SERVICE_LOG"');
  writeExecutable('pgrep', 'exit 1');
  writeExecutable('sleep', 'exit 0');
  writeExecutable('curl', 'printf \'{"status":"ok","db":true,"rev":"%s"}\\n\' "$TEST_NEW_REV"');
  writeExecutable('node', 'printf \'%s\\n\' "$TEST_NEW_REV"');

  const result = spawnSync('bash', [join(process.cwd(), 'deploy/sim-autodeploy.sh')], {
    cwd: repoDir,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      SIM_AUTODEPLOY_REPO: repoDir,
      SIM_AUTODEPLOY_STATE_DIR: stateDir,
      SIM_AUTODEPLOY_HEALTH_URL: 'http://test.invalid/api/health',
      TEST_NEW_REV: newRev,
      TEST_OLD_REV: oldRev,
      TEST_REV_SEEN_FILE: revSeenFile,
      TEST_SERVICE_LOG: serviceLog,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `autodeploy should refresh HEAD after the wait: ${result.stderr}`);
  assert.equal(readFileSync(join(stateDir, 'deployed_rev'), 'utf8').trim(), newRev);
  assert.match(readFileSync(join(stateDir, 'deploy.log'), 'utf8'), new RegExp(`deployed OK rev=${newRev}`));
  assert.equal(readFileSync(serviceLog, 'utf8'), 'build\nrestart\n');
  assert.ok(existsSync(revSeenFile));
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log('sim-autodeploy.test.ts OK');
