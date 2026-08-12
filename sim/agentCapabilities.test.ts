import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INTERNAL_MEMBER_PROFILE,
  INTERNAL_OWNER_PROFILE,
  SAFE_DISCUSSION_PROFILE,
  assertCapabilityPath,
  writeActorCookieJar,
} from './agentCapabilities';

assert.strictEqual(SAFE_DISCUSSION_PROFILE.kind, 'safeDiscussion');
assert.strictEqual(INTERNAL_OWNER_PROFILE.kind, 'ownerInternal');
assert.strictEqual(INTERNAL_MEMBER_PROFILE.kind, 'memberInternal');
assert.ok(INTERNAL_OWNER_PROFILE.tools.includes('Bash(curl:*)'));
assert.ok(INTERNAL_MEMBER_PROFILE.tools.includes('Bash(git status:*)'));
assert.throws(
  () => assertCapabilityPath(INTERNAL_MEMBER_PROFILE, '/home/hom/code/other-repo/file.ts'),
  /capability path/,
);
const memberInternalRoot = INTERNAL_MEMBER_PROFILE.repoRoot;
assert.ok(memberInternalRoot);
assert.doesNotThrow(() => assertCapabilityPath(
  INTERNAL_MEMBER_PROFILE,
  join(memberInternalRoot, 'user02', 'src', 'run.ts'),
));

const dir = mkdtempSync(join(tmpdir(), 'task-tracker-capability-test-'));
try {
  const jar = join(dir, '.jar-user02.txt');
  writeActorCookieJar(jar, 'session=abc123');
  const text = readFileSync(jar, 'utf8');
  assert.ok(text.includes('localhost\tFALSE\t/\tFALSE\t0\tsession\tabc123'));
  assert.throws(() => writeActorCookieJar(join(dir, '.invalid.jar'), 'foo=bar'), /session cookie/);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('agentCapabilities.test.ts OK');
