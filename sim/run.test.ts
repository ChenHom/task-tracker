import assert from 'node:assert';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/schema';
import { createRunDir, formatReportMarkdown, formatReviewPacket, loadMembersFromUsers, parseScenario, writePromptArtifact } from './run';

const source = readFileSync(join(__dirname, 'run.ts'), 'utf8');
assert.ok(!source.includes('const MEMBERS: Member[] = ['), 'MEMBERS 不應在 sim/run.ts 寫死 email/name');

const dir = mkdtempSync(join(tmpdir(), 'task-tracker-sim-'));
const dbPath = join(dir, 'dev.db');
const db = new DatabaseSync(dbPath);
runMigrations(db);
const insert = db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)');
insert.run('u2', 'user02@test.local', '小美', 'hash');
insert.run('u3', 'user03@test.local', '阿凱', 'hash');
insert.run('u4', 'user04@test.local', '婷婷', 'hash');
insert.run('u5', 'user05@test.local', '大熊', 'hash');
db.close();

const members = loadMembersFromUsers(dbPath);
assert.deepStrictEqual(
  members.map((member) => ({ email: member.email, name: member.name, user: member.user, runner: member.runner })),
  [
    { email: 'user02@test.local', name: '小美', user: 'user02', runner: 'claude' },
    { email: 'user03@test.local', name: '阿凱', user: 'user03', runner: 'codex' },
    { email: 'user04@test.local', name: '婷婷', user: 'user04', runner: 'codex' },
    { email: 'user05@test.local', name: '大熊', user: 'user05', runner: 'codex' },
  ],
  'sim members 應從 users 表讀取 email/name，runner 設定仍由 sim 保留',
);
assert.ok(members.every((member) => member.profile.trim().length > 0), '每個 member 都應有 profile 供認領/難度組合參考');

const runRoot = mkdtempSync(join(tmpdir(), 'task-tracker-sim-run-'));
const runDir = createRunDir(runRoot, 'sim-run-test');
const artifact = writePromptArtifact(runDir, 'owner-open', 'hello');
assert.ok(artifact.path.endsWith('001-owner-open.md'));
assert.strictEqual(artifact.bytes, 5);
assert.strictEqual(readFileSync(artifact.path, 'utf8'), 'hello');

const packetMarkdown = formatReviewPacket({
  branch: 'sim/user02',
  memberName: '小美',
  memberEmail: 'user02@test.local',
  ahead: 2,
  commits: ['abc123 feat: example'],
  changedFiles: ['src/auth.ts'],
  diffstat: ' src/auth.ts | 2 ++',
  tsc: { ok: true, outputPath: '/tmp/tsc.txt' },
  test: { ok: false, outputPath: '/tmp/test.txt' },
  packetPath: '/tmp/packet.md',
});
assert.ok(packetMarkdown.includes('sim/user02'));
assert.ok(packetMarkdown.includes('test: FAIL'));
assert.ok(packetMarkdown.includes('src/auth.ts'));

const reportMarkdown = formatReportMarkdown({
  runId: 'sim-run-test',
  scenarioKey: 'technical-debt',
  workspaceId: 'ws1',
  tag: 'sim-run-test',
  startedAt: '2026-07-07T00:00:00.000Z',
  finishedAt: '2026-07-07T00:01:00.000Z',
  members: [{ email: 'user02@test.local', name: '小美', branch: 'sim/user02' }],
  tasks: [{ taskId: 't1', title: 'Example', status: 'Done', priority: 'High' }],
  branches: [],
  promptArtifacts: [{ label: 'owner-open', path: '/tmp/p.md', bytes: 10 }],
  bugTasks: 0,
  escalateComments: 0,
  totalPromptBytes: 10,
  commentCount: 1,
  eventCount: 2,
  unmergedGreen: ['sim/user03'],
});
assert.ok(reportMarkdown.includes('sim-run-test'));
assert.ok(reportMarkdown.includes('Example'));
assert.ok(reportMarkdown.includes('total prompt bytes: 10'));
assert.ok(reportMarkdown.includes('sim/user03'));

assert.strictEqual(parseScenario(['node', 'run.ts']).key, 'self-directed');
assert.strictEqual(parseScenario(['node', 'run.ts', '--scenario', 'product-ideation']).key, 'product-ideation');
assert.throws(() => parseScenario(['node', 'run.ts', '--scenario', 'missing']), /Unknown scenario/);

console.log('sim/run.test.ts OK');
