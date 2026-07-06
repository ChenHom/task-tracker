# Sim Run Amplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `sim/run.ts` from a fixed local sprint demo into a reusable AI sprint harness that can generate real work, reduce token waste, persist team/prompt configuration, save prompt artifacts, produce sprint reports, and give owner agents richer CI review context.

**Architecture:** Keep the existing single-command flow (`npm run sim`) as the user-facing entrypoint, but add durable configuration and run artifacts around it. The first implementation should preserve the current default behavior, then layer scenario selection, DB-backed roster prompts, prompt artifact rendering, report generation, and CI review packets without forcing a large rewrite of the orchestration flow.

**Tech Stack:** TypeScript, Node.js `node:sqlite`, existing task-tracker HTTP API, Git CLI/worktrees, local filesystem artifacts under `sim-logs/`, existing `tsx` test runner.

---

## Baseline Direction

The current weaknesses of `sim/run.ts` are acceptable for now. This plan intentionally amplifies the strengths:

- Preserve the end-to-end sprint flow.
- Make scenarios richer and not limited to this repository.
- Reduce repeated prompt/context tokens instead of comparing model quality.
- Store team role/persona/prompt data in database tables.
- Save every rendered prompt as a reviewable artifact.
- Produce a durable sprint report.
- Give owner agents compact CI/review packets so they spend attention on judgment, not mechanical discovery.

## Target Flow

```text
npm run sim -- --scenario <name> --target <repo-path>
  -> load sim scenario definition
  -> load users + role/user prompt profiles from DB
  -> create run id and artifact directory
  -> render prompt/context artifacts
  -> bootstrap task-tracker workspace and worktrees
  -> create scenario tasks through owner/session flow or driver direct creation
  -> run member sessions using compact prompt + artifact paths
  -> pre-run branch CI and produce review packets
  -> run owner review/merge sessions
  -> write report.md + report.json
```

## Proposed Data Model

These are sim-specific tables in the same SQLite database for now. They should be created by the existing `runMigrations` style so local setup remains simple.

```sql
CREATE TABLE IF NOT EXISTS sim_roles (
  role_key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  base_prompt TEXT NOT NULL,
  token_policy TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sim_user_profiles (
  user_email TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
  role_key TEXT NOT NULL REFERENCES sim_roles(role_key),
  prompt_override TEXT NOT NULL DEFAULT '',
  working_style TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sim_scenarios (
  scenario_key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  generation_prompt TEXT NOT NULL,
  task_policy TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sim_runs (
  run_id TEXT PRIMARY KEY,
  scenario_key TEXT NOT NULL,
  workspace_id TEXT,
  target_path TEXT NOT NULL,
  tag TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS sim_prompt_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES sim_runs(run_id) ON DELETE CASCADE,
  session_label TEXT NOT NULL,
  prompt_path TEXT NOT NULL,
  context_path TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## File Structure

- Modify `src/schema.ts`
  Add sim tables with idempotent `CREATE TABLE IF NOT EXISTS`.

- Create `sim/scenarios.ts`
  Load scenario definitions from DB and provide seeded defaults for current technical debt sprint, product ideation, product build, and external repo maintenance.

- Create `sim/profiles.ts`
  Load `users`, `sim_roles`, and `sim_user_profiles`; resolve final member persona/prompt policy.

- Create `sim/artifacts.ts`
  Create `sim-logs/<run-id>/`, write prompt/context artifacts, write report files, and hash rendered prompts.

- Create `sim/reviewPackets.ts`
  Build compact CI/review packets per branch: changed files, diffstat, commit list, test status, conflict risk, and task mapping.

- Modify `sim/run.ts`
  Keep orchestration here, but call the new modules. Do not split everything at once; only move responsibilities that support the six requested amplifications.

- Create or extend `sim/run.test.ts`
  Cover scenario loading, profile resolution, prompt artifact writing, report writing, and review packet generation with temp SQLite DBs and temp git repos where possible.

## Scenario Strategy

Scenarios should generate real work, not just replay fixed backlog rows.

### Scenario Kinds

1. **Current Repo Technical Debt**
   Equivalent to today’s behavior. Generates tasks from known code debt in this repo.

2. **Existing Repo Product Enhancement**
   Takes `--target /path/to/repo`, reads repo structure, asks owner to create a realistic product enhancement backlog, then members implement.

3. **Product Project Ideation**
   Starts with a product brief instead of a codebase task list. Owner creates project scope, milestones, and task breakdown in task-tracker. Implementation may stop at planning or continue into code if a target repo exists.

4. **New Product Build**
   Creates a product project from a brief, then assigns initial implementation tasks. This mode needs stronger guardrails because it can generate broad scope.

### Scenario Output Contract

Every scenario produces:

```ts
interface ScenarioPlan {
  scenarioKey: string;
  title: string;
  projectName: string;
  targetPath: string;
  taskCreationMode: 'owner-prompt' | 'driver-direct';
  ownerBrief: string;
  acceptancePolicy: string;
  maxTasks: number;
}
```

For the first pass, use `owner-prompt` for product ideation and `driver-direct` for the current fixed technical-debt scenario. This keeps existing behavior while allowing higher-level scenarios.

## Token Efficiency Strategy

The goal is not to compare models. The goal is more useful work per token.

### Policy

- Prompts should reference artifact files instead of repeating long shared rules every round.
- Round 2 and 3 member prompts should include only deltas: assigned task state, owner comments, latest branch status, and artifact paths.
- Shared API rules should be saved once per run as `context/api-rules.md`.
- Member-specific identity and working style should be saved once per run as `context/member-<user>.md`.
- Owner review prompt should receive a compact review packet instead of being asked to rediscover branch state.

### Metrics

Use byte counts as a cheap local proxy before adding tokenizer-specific counts:

```ts
interface TokenEfficiencyStats {
  promptBytes: number;
  stdoutBytes: number;
  stderrBytes: number;
  completedTasks: number;
  mergedTasks: number;
  reviewPasses: number;
  reviewReworks: number;
}
```

Report:

- prompt bytes per completed task
- prompt bytes per merged task
- sessions with zero code changes
- owner review prompt bytes before/after review packet compression

## Prompt/Profile Strategy

Roster identity should come from `users`. Work style and prompt data should come from sim tables.

Resolution order:

1. `users.email` and `users.name`
2. `sim_user_profiles.user_email`
3. `sim_roles.role_key`
4. `sim_user_profiles.prompt_override`

Final prompt context should include:

- display name
- email
- role title
- base role prompt
- user-specific override
- token policy
- current task context

This allows role-based defaults while still supporting direct user-specific prompts.

## Prompt Artifact Strategy

Every call to `runSession` should receive a rendered prompt that is written before execution.

Artifact layout:

```text
sim-logs/<run-id>/
  manifest.json
  context/
    api-rules.md
    scenario.md
    member-user02.md
    owner.md
  prompts/
    001-owner-open.md
    002-user02-r1.md
    003-user03-r1.md
  review-packets/
    sim-user02.md
  report.md
  report.json
```

`manifest.json` should include:

```json
{
  "runId": "sim-run-20260707-001",
  "scenarioKey": "technical-debt",
  "workspaceId": "workspace-id",
  "tag": "sim-run-...",
  "targetPath": "/home/hom/code/task-tracker",
  "startedAt": "2026-07-07T00:00:00.000Z",
  "sessions": []
}
```

## Sprint Report Strategy

Write both human and machine-readable reports.

`report.md` should answer:

- What scenario ran?
- Who participated?
- Which tasks were created?
- Which tasks reached Done, Review, Doing, Todo?
- Which branches were created?
- Which commits were merged?
- Which branches failed CI?
- Which tasks had `[BUG]` or `[ESCALATE]`?
- How many prompt bytes were spent?
- What should be cleaned up?

`report.json` should contain the same facts for later comparison.

## CI Review Packet Strategy

`verifyBranches()` should evolve from boolean status to review packets.

```ts
interface BranchReviewPacket {
  branch: string;
  memberName: string;
  memberEmail: string;
  ahead: number;
  commits: string[];
  changedFiles: string[];
  diffstat: string;
  tsc: { ok: boolean; outputPath: string };
  test: { ok: boolean; outputPath: string };
  conflictRisk: 'low' | 'medium' | 'high';
  riskNotes: string[];
  packetPath: string;
}
```

Owner close prompt should reference packet paths and include only a short summary:

```text
- 小美 / sim/user02: tsc PASS, test PASS, 2 commits, 3 files changed, conflict risk low, packet: sim-logs/<run-id>/review-packets/sim-user02.md
```

This makes the owner more like a real reviewer: it gets the high-signal facts first and opens details only when needed.

---

## Implementation Tasks

### Task 1: Add Sim Tables and Seed Defaults

**Files:**
- Modify: `src/schema.ts`
- Modify: `src/schema.test.ts`
- Create: `sim/defaults.ts`
- Modify: `sim/run.test.ts`

- [ ] **Step 1: Write failing schema tests**

Add assertions that `runMigrations()` creates `sim_roles`, `sim_user_profiles`, `sim_scenarios`, `sim_runs`, and `sim_prompt_artifacts`.

Run: `npm test`

Expected: FAIL because the sim tables do not exist.

- [ ] **Step 2: Add sim table migrations**

Add the SQL from the "Proposed Data Model" section to `runMigrations()`.

Run: `npm test`

Expected: PASS for schema tests.

- [ ] **Step 3: Add default sim seed helper**

Create `sim/defaults.ts` with:

```ts
import type { DatabaseSync } from 'node:sqlite';

export function seedSimDefaults(database: DatabaseSync): void {
  database.prepare(`
    INSERT OR IGNORE INTO sim_roles (role_key, title, base_prompt, token_policy)
    VALUES (?, ?, ?, ?)
  `).run(
    'engineer',
    'Engineer',
    '你是務實的產品工程師。優先完成任務，保留清楚驗證紀錄，避免無關重構。',
    '優先讀 artifact 檔案；不要重述長規則；回覆只包含決策、改動、驗證結果。',
  );

  database.prepare(`
    INSERT OR IGNORE INTO sim_roles (role_key, title, base_prompt, token_policy)
    VALUES (?, ?, ?, ?)
  `).run(
    'owner',
    'Owner',
    '你是負責切 task、審查、整合的技術負責人。你的工作是提升交付品質，不做無謂探索。',
    '先讀 review packet；只在需要時看 diff；不要逐 branch 重跑已由 driver 跑過的測試。',
  );
}
```

- [ ] **Step 4: Test default seed helper**

In `sim/run.test.ts`, create an in-memory DB, run migrations, call `seedSimDefaults()`, and assert both roles exist.

Run: `npx tsx sim/run.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schema.ts src/schema.test.ts sim/defaults.ts sim/run.test.ts
git commit -m "feat: add sim configuration tables"
```

### Task 2: Load DB-Backed Profiles

**Files:**
- Create: `sim/profiles.ts`
- Modify: `sim/run.ts`
- Modify: `sim/run.test.ts`

- [ ] **Step 1: Write failing profile resolution test**

Create a temp DB with `users`, `sim_roles`, and `sim_user_profiles`. Assert that `resolveSimMembers()` returns member name from `users`, base prompt from role, and override from `sim_user_profiles`.

Run: `npx tsx sim/run.test.ts`

Expected: FAIL because `resolveSimMembers()` does not exist.

- [ ] **Step 2: Implement `sim/profiles.ts`**

Create:

```ts
export interface SimMemberProfile {
  email: string;
  name: string;
  user: string;
  runner: 'claude' | 'codex';
  model: string;
  roleKey: string;
  roleTitle: string;
  basePrompt: string;
  promptOverride: string;
  tokenPolicy: string;
  workingStyle: string;
  userId?: string;
}
```

Implement `resolveSimMembers(databasePath, runnerConfig)` by joining `users`, `sim_user_profiles`, and `sim_roles`. If a user has no profile, default to role `engineer`.

- [ ] **Step 3: Replace `loadMembersFromUsers()` usage**

In `sim/run.ts`, use `resolveSimMembers()` instead of directly querying `users`.

Run: `npm test`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add sim/profiles.ts sim/run.ts sim/run.test.ts
git commit -m "feat: load sim member profiles from db"
```

### Task 3: Add Scenario Loading

**Files:**
- Create: `sim/scenarios.ts`
- Modify: `sim/run.ts`
- Modify: `sim/run.test.ts`

- [ ] **Step 1: Write failing scenario tests**

Assert that:

- default scenario is `technical-debt`
- `--scenario product-ideation` loads product ideation settings
- unknown scenario throws `Unknown scenario: <key>`

Run: `npx tsx sim/run.test.ts`

Expected: FAIL because scenario loading does not exist.

- [ ] **Step 2: Implement scenario loader**

Create `loadScenario(databasePath, scenarioKey, targetPath)` returning the `ScenarioPlan` contract from this document.

Seed default scenarios:

- `technical-debt`
- `repo-product-enhancement`
- `product-ideation`
- `new-product-build`

- [ ] **Step 3: Wire CLI args**

Support:

```bash
npm run sim -- --scenario product-ideation --target /path/to/repo
```

Default:

```text
scenario = technical-debt
target = current repo root
```

- [ ] **Step 4: Commit**

```bash
git add sim/scenarios.ts sim/run.ts sim/run.test.ts
git commit -m "feat: add scenario-driven sim runs"
```

### Task 4: Persist Prompt Artifacts

**Files:**
- Create: `sim/artifacts.ts`
- Modify: `sim/run.ts`
- Modify: `sim/run.test.ts`

- [ ] **Step 1: Write failing artifact tests**

Assert that `createRunArtifacts()` creates:

- `sim-logs/<run-id>/manifest.json`
- `context/api-rules.md`
- `prompts/`
- `review-packets/`

Run: `npx tsx sim/run.test.ts`

Expected: FAIL because artifact writing does not exist.

- [ ] **Step 2: Implement artifact writer**

Functions:

```ts
export function createRunArtifacts(root: string, runId: string): RunArtifactPaths
export function writePromptArtifact(paths: RunArtifactPaths, label: string, prompt: string): PromptArtifact
export function writeContextArtifact(paths: RunArtifactPaths, name: string, content: string): string
```

Use SHA-256 for prompt hashes.

- [ ] **Step 3: Wire `runSession()`**

Before spawning Claude/Codex, write the rendered prompt to `prompts/<ordinal>-<label>.md`. Pass the same prompt string to the child process so behavior is unchanged.

- [ ] **Step 4: Commit**

```bash
git add sim/artifacts.ts sim/run.ts sim/run.test.ts
git commit -m "feat: save sim prompt artifacts"
```

### Task 5: Generate Review Packets

**Files:**
- Create: `sim/reviewPackets.ts`
- Modify: `sim/run.ts`
- Modify: `sim/run.test.ts`

- [ ] **Step 1: Write failing packet tests**

Use a temp git repo with one branch ahead of main. Assert that packet generation returns branch name, commit list, changed files, diffstat, and CI status.

Run: `npx tsx sim/run.test.ts`

Expected: FAIL because review packet generation does not exist.

- [ ] **Step 2: Implement packet generation**

Implement:

```ts
export function buildBranchReviewPacket(input: {
  root: string;
  worktree: string;
  branch: string;
  memberName: string;
  memberEmail: string;
  artifactDir: string;
}): BranchReviewPacket
```

Run `npx tsc --noEmit` and `npm test` in the worktree. Save command output files under `review-packets/<branch>-tsc.txt` and `review-packets/<branch>-test.txt`.

- [ ] **Step 3: Replace `verifyBranches()` output**

Use packets in `ownerClosePrompt()` instead of only booleans.

- [ ] **Step 4: Commit**

```bash
git add sim/reviewPackets.ts sim/run.ts sim/run.test.ts
git commit -m "feat: generate branch review packets"
```

### Task 6: Generate Sprint Reports

**Files:**
- Modify: `sim/artifacts.ts`
- Modify: `sim/run.ts`
- Modify: `sim/run.test.ts`

- [ ] **Step 1: Write failing report tests**

Assert that report generation writes `report.md` and `report.json` with scenario key, workspace id, task counts, branch summaries, bug count, escalate count, and prompt artifact count.

Run: `npx tsx sim/run.test.ts`

Expected: FAIL because report writing does not exist.

- [ ] **Step 2: Implement report model**

Create:

```ts
export interface SprintReport {
  runId: string;
  scenarioKey: string;
  workspaceId: string;
  tag: string;
  startedAt: string;
  finishedAt: string;
  tasks: Array<{ taskId: string; title: string; status: string; priority: string }>;
  members: Array<{ email: string; name: string; branch: string }>;
  branches: BranchReviewPacket[];
  promptArtifacts: Array<{ label: string; path: string; sha256: string; bytes: number }>;
  bugTasks: number;
  escalateComments: number;
}
```

- [ ] **Step 3: Replace or wrap `printStats()`**

Keep terminal output, but have it read from the same `SprintReport` object that writes files.

- [ ] **Step 4: Commit**

```bash
git add sim/artifacts.ts sim/run.ts sim/run.test.ts
git commit -m "feat: write sim sprint reports"
```

### Task 7: Compact Prompts for Token Efficiency

**Files:**
- Modify: `sim/run.ts`
- Modify: `sim/artifacts.ts`
- Modify: `sim/run.test.ts`

- [ ] **Step 1: Add prompt byte accounting test**

Assert that each prompt artifact records byte length and that `report.json` includes total prompt bytes.

Run: `npx tsx sim/run.test.ts`

Expected: FAIL until byte accounting exists.

- [ ] **Step 2: Write shared context artifacts**

Write `api-rules.md`, `scenario.md`, and member profile context files once per run.

- [ ] **Step 3: Compact round prompts**

Change round prompts so repeated rules are replaced by artifact references:

```text
請先閱讀：
- sim-logs/<run-id>/context/api-rules.md
- sim-logs/<run-id>/context/member-user02.md
- sim-logs/<run-id>/context/scenario.md
```

Keep round-specific instructions inline.

- [ ] **Step 4: Report token efficiency proxy**

Add to report:

- total prompt bytes
- prompt bytes per completed task
- prompt bytes per merged task
- zero-change sessions

- [ ] **Step 5: Commit**

```bash
git add sim/run.ts sim/artifacts.ts sim/run.test.ts
git commit -m "feat: compact sim prompts with shared context artifacts"
```

---

## Rollout Order

Recommended order:

1. Prompt artifacts
2. Sprint reports
3. CI review packets
4. DB-backed role/user profiles
5. Scenario loading
6. Token efficiency compaction

This order creates observability first. Once prompts and reports are saved, later changes become easier to evaluate.

## Acceptance Criteria

- `npm test` passes.
- `npm run build` passes.
- `npm run sim -- --smoke` still works for the current repo.
- A run creates `sim-logs/<run-id>/manifest.json`.
- Every owner/member session has a saved prompt artifact.
- Final run creates `report.md` and `report.json`.
- Owner close prompt receives review packet summaries instead of only pass/fail booleans.
- Member names still come from `users`.
- Role/user prompt data comes from sim tables.
- Current default technical-debt sprint behavior remains available without extra CLI flags.

## Explicit Non-Goals

- Do not compare model quality.
- Do not replace task-tracker as the collaboration board.
- Do not make `run.ts` production-grade infrastructure.
- Do not support remote Git providers in the first implementation.
- Do not build a UI for scenario management yet.

## Self-Review

- The six requested expansion points are each covered by a concrete task or strategy section.
- No implementation task requires changing app UX.
- The plan keeps current behavior as the default path.
- Token efficiency is measured by local byte proxies first, avoiding provider-specific tokenizer complexity.
- Scenario-driven work explicitly includes product ideation and non-current-repo target paths.
- Prompt artifacts, sprint reports, and CI review packets are prioritized before deeper scenario complexity.
