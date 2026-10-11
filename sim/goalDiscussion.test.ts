import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildGoalDiscussionPacket,
  readGoalRepoSources,
  runGoalDiscussion,
  type GoalDiscussionInvocation,
} from './goalDiscussion';

async function main(): Promise<void> {
const root = mkdtempSync(join(tmpdir(), 'goal-discussion-'));
const outside = mkdtempSync(join(tmpdir(), 'goal-outside-'));
try {
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'context.md'), 'token=super-secret\nExpected HTTP 200');
  writeFileSync(join(outside, 'secret.md'), 'outside');
  symlinkSync(join(outside, 'secret.md'), join(root, 'docs', 'escape.md'));

  const sources = readGoalRepoSources(root, ['docs/context.md']);
  assert.strictEqual(sources.length, 1);
  assert.ok(!sources[0].content.includes('super-secret'), 'credential 不可進 prompt context');
  assert.throws(() => readGoalRepoSources(root, ['../secret.md']), /超出 target repo/);
  assert.throws(() => readGoalRepoSources(root, ['docs/escape.md']), /超出 target repo|symlink/);

  const packet = buildGoalDiscussionPacket({
    objective: 'Ship goal', successCriteria: 'HTTP 200', assignment: 'Review API',
    round: 'round_1', sources,
  });
  assert.ok(packet.prompt.includes('UNTRUSTED_REPO_DATA'));
  assert.ok(packet.prompt.length <= 16_000);

  let invocation: GoalDiscussionInvocation | null = null;
  const contribution = await runGoalDiscussion({
    route: { runner: 'claude', model: 'claude-sonnet-5-5' }, packet,
  }, async (input) => {
    invocation = input;
    return {
      stance: 'analysis', claim: 'Project ownership is required',
      reason: 'It prevents cross-workspace mutation', evidenceRefs: ['docs/context.md'],
    };
  });
  assert.strictEqual(contribution.stance, 'analysis');
  assert.deepStrictEqual(invocation, {
    runner: 'claude', model: 'claude-sonnet-5-5', prompt: packet.prompt,
    cwd: '', tools: 'WebSearch,WebFetch', persistentSession: false,
  });
  await assert.rejects(
    () => runGoalDiscussion({ route: { runner: 'codex', model: 'gpt-test' }, packet }, async () => contribution),
    /只允許 Claude/,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}
}

main().then(() => console.log('goalDiscussion.test.ts OK'));
