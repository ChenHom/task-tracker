# Cross-Repo Knowledge Publishing Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn one public ChatGPT share into one verified book knowledge package, prepare a deterministic publication release, and complete a dry-run through Task Tracker, Harness, knowledge-mirror, and knowledge-showcase without pushing public content.

**Architecture:** Task Tracker owns intake and status, a bounded Claude research runner produces a validated source bundle, Harness writes and verifies one book package in an isolated knowledge-mirror worktree, and a deterministic publisher prepares canonical/showcase diffs. Phase 1 stops at the approved dry-run gate; remote pushes are enabled only after that evidence is reviewed.

**Tech Stack:** Node.js 24, TypeScript, `node:http`, `node:crypto`, Claude CLI with `WebSearch,WebFetch`, Harness CLI, Python 3 standard library, Git, existing Task Tracker HTTP API.

---

## Scope boundary

This plan implements only Phase 1 from the approved spec:

- one public ChatGPT share source;
- one selected book;
- one isolated knowledge-mirror book package;
- deterministic build and showcase dry-run;
- Task Tracker evidence through `Review`.

It does not enable RSSHub intake, multi-book concurrency, unattended Git push, or automatic `Done`. Those require the Phase 1 dry-run evidence and separate plans.

## Repository and worktree setup

Execution must use isolated worktrees because the task spans three mutable repositories. Before Task 1, use the `using-git-worktrees` skill and create:

```text
/home/hom/code/task-tracker/.worktrees/knowledge-publishing-phase1
/home/hom/knowledge-mirror/.worktrees/knowledge-publishing-phase1
/home/hom/knowledge-showcase/.worktrees/knowledge-publishing-phase1
```

Do not modify `/home/hom/code/harness`; it currently has an unrelated untracked `.jar-owner-sweep.txt`. Phase 1 consumes its existing CLI and records its version instead of changing Harness Core.

## File map

### task-tracker

- Create `sim/knowledge/contracts.ts`: source, candidate, claim-ledger, release-manifest types and strict validators.
- Create `sim/knowledge/contracts.test.ts`: contract and rejection tests.
- Create `sim/knowledge/chatgptShare.ts`: URL normalization, public-page fetch, title/share metadata, digest and embedded-conversation evidence.
- Create `sim/knowledge/chatgptShare.test.ts`: synthetic page fixture tests.
- Create `sim/knowledge/researchSecurity.ts`: knowledge-specific prompt, egress policy and JSON output validation.
- Create `sim/knowledge/researchSecurity.test.ts`: prompt-injection, private URL, source-level and claim coverage tests.
- Create `sim/knowledge/researchRunner.ts`: isolated Claude invocation with injected process seam.
- Create `sim/knowledge/researchRunner.test.ts`: invocation and zero-output/failure tests.
- Create `sim/knowledge/taskTrackerAdapter.ts`: idempotent `[SOURCE]`/`[BOOK]` task creation and one-field transitions.
- Create `sim/knowledge/taskTrackerAdapter.test.ts`: fake HTTP client tests.
- Create `sim/knowledge/orchestrator.ts`: Phase 1 state machine through dry-run Review.
- Create `sim/knowledge/orchestrator.test.ts`: end-to-end fake dependency tests.
- Create `sim/knowledge/run.ts`: explicit CLI entry point; no timer or sweep integration.
- Modify `package.json`: include focused knowledge tests in `npm test` and add `knowledge:phase1` script.
- Modify `sim/tsconfig.json`: include `sim/knowledge/**/*.ts` if current include is narrower than `sim/**/*.ts`.
- Modify `docs/operations.md`: document dry-run command, state paths, credentials and no-push boundary.

### knowledge-mirror

- Modify `README.md`: add the `books` domain and book package rules.
- Modify `scripts/build_pages.py`: add `books` to `DOMAINS`.
- Create `scripts/validate_book_notes.py`: validate required headings, source ledger, unsupported-claim markers and public-data rules.
- Create `scripts/validate_book_notes_test.py`: temporary-directory validator tests.
- Modify `scripts/build_showcase.py`: add `--dry-run`, repo identity, clean baseline, copy manifest and allowlisted diff reporting.
- Create `scripts/build_showcase_test.py`: temporary Git-repo dry-run tests.
- Create `.harness/config.json`: freeze allowed paths and Phase 1 verification commands.
- Create `notes/books/index.md`: canonical cross-book index with completed and pending sections.

### knowledge-showcase

- No source changes in Phase 1. The publisher targets an isolated worktree and must leave it uncommitted after dry-run.

## Task 1: Define strict Phase 1 contracts

**Files:**
- Create: `sim/knowledge/contracts.ts`
- Create: `sim/knowledge/contracts.test.ts`

- [ ] **Step 1: Write the failing contract tests**

Create assertions covering a valid source record, exactly one selected book, at least one primary source, cross-confirmation of important claims, stable SHA-256 digests, and rejection of unknown fields:

```ts
const bundle = parseResearchBundle({
  schemaVersion: 1,
  source: {
    kind: 'chatgpt-share',
    canonicalUrl: 'https://chatgpt.com/share/6abb3cc5-afc8-83ee-b169-f7ded2cb4081',
    title: '每日摘要需求設定',
    contentSha256: 'a'.repeat(64),
    fetchedAt: '2026-09-29T00:00:00.000Z',
  },
  candidates: [{
    title: 'Example Book', author: 'Example Author', selected: true,
    discussionEvidence: ['message:12'], exclusionReason: null,
  }],
  selectedBook: {
    title: 'Example Book', author: 'Example Author', edition: '1st', slug: 'example-book',
  },
  claims: [
    { id: 'C1', claim: 'A testable claim', importance: 'important', status: 'supported', notePaths: ['01-core-thesis.md'], sourceIds: ['S1', 'S2'] },
  ],
  sources: [
    { id: 'S1', url: 'https://publisher.example/book', level: 'primary', relation: 'support', title: 'Publisher page', accessedAt: '2026-09-29T00:00:00.000Z' },
    { id: 'S2', url: 'https://research.example/paper', level: 'research', relation: 'support', title: 'Research paper', accessedAt: '2026-09-29T00:00:00.000Z' },
  ],
  openQuestions: [],
});
assert.strictEqual(bundle.selectedBook.slug, 'example-book');
assert.throws(() => parseResearchBundle({ ...bundle, extra: true }), /unknown field/);
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npx tsx sim/knowledge/contracts.test.ts`  
Expected: FAIL because `contracts.ts` does not exist.

- [ ] **Step 3: Implement the minimal contract parser**

Define literal unions and manual validators without adding a schema dependency:

```ts
export type SourceLevel = 'primary' | 'research' | 'secondary';
export type ClaimStatus = 'supported' | 'contradicted' | 'author-claim' | 'unverified';
export interface ResearchBundle { /* fields asserted above */ }
export interface ReleaseManifest {
  schemaVersion: 1;
  releaseId: string;
  bookTaskId: string;
  sourceBundleSha256: string;
  expectedKnowledgeMirrorRevision: string;
  allowedSourcePaths: string[];
  intendedPublicSlugs: string[];
  checks: Array<{ id: string; outcome: 'pass' | 'fail' | 'unknown'; evidence: string }>;
}
export function parseResearchBundle(value: unknown): ResearchBundle { /* exact-key and field checks */ }
export function parseReleaseManifest(value: unknown): ReleaseManifest { /* exact-key and field checks */ }
export function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
```

The parser must require exactly one `selected: true` candidate, require `selectedBook` to match it, require a primary source, and require two distinct source IDs for every `importance: 'important'` claim with `status: 'supported'`.

- [ ] **Step 4: Run focused test and typecheck**

Run: `npx tsx sim/knowledge/contracts.test.ts && npx tsc -p sim/tsconfig.json --noEmit`  
Expected: `contracts.test.ts OK`, TypeScript exit 0.

- [ ] **Step 5: Commit**

```bash
git add sim/knowledge/contracts.ts sim/knowledge/contracts.test.ts
git commit -m "feat(knowledge): define research and release contracts"
```

## Task 2: Fetch and fingerprint a public ChatGPT share

**Files:**
- Create: `sim/knowledge/chatgptShare.ts`
- Create: `sim/knowledge/chatgptShare.test.ts`

- [ ] **Step 1: Write the failing adapter tests**

Use a small synthetic HTML string containing a title, `sharedConversationId`, `conversation_id`, `is_public` and `linear_conversation` reference list. Assert canonicalization removes query/fragment, non-ChatGPT hosts and non-HTTPS URLs fail, missing public markers fail, and returned raw HTML is not embedded in the record.

```ts
const fetched = await fetchChatGptShare(INPUT, async () => new Response(FIXTURE_HTML, {
  status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
}));
assert.strictEqual(fetched.canonicalUrl, INPUT);
assert.strictEqual(fetched.title, '每日摘要需求設定');
assert.strictEqual(fetched.linearConversationRefs, 3);
assert.match(fetched.contentSha256, /^[a-f0-9]{64}$/u);
assert.ok(!('html' in fetched));
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npx tsx sim/knowledge/chatgptShare.test.ts`  
Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement the fetch adapter**

Expose an injected fetch seam and enforce:

```ts
export async function fetchChatGptShare(
  rawUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<ChatGptShareRecord>
```

The implementation must use `validatePublicUrl`, require hostname `chatgpt.com`, path `/share/<uuid-like-id>`, HTTP 200, HTML content type, maximum 20 MiB, `<title>ChatGPT - ...</title>`, matching `sharedConversationId`, `is_public`, `conversation_id`, and a non-empty `linear_conversation` list. Return metadata and digest only; keep raw HTML in memory only long enough to derive the record.

- [ ] **Step 4: Run focused tests**

Run: `npx tsx sim/knowledge/chatgptShare.test.ts`  
Expected: `chatgptShare.test.ts OK`.

- [ ] **Step 5: Commit**

```bash
git add sim/knowledge/chatgptShare.ts sim/knowledge/chatgptShare.test.ts
git commit -m "feat(knowledge): validate public ChatGPT shares"
```

## Task 3: Add a bounded research policy and output validator

**Files:**
- Create: `sim/knowledge/researchSecurity.ts`
- Create: `sim/knowledge/researchSecurity.test.ts`
- Modify: `sim/notificationSecurity.ts`
- Modify: `sim/run.test.ts`

- [ ] **Step 1: Write failing policy tests**

Cover public URL validation, private redirects, credential-like queries, a configurable 12-search knowledge limit, strict JSON-only output, exactly one selected book, primary-source presence, claim coverage and rejection of tool envelopes in model output.

- [ ] **Step 2: Run tests and confirm RED**

Run: `npx tsx sim/knowledge/researchSecurity.test.ts`  
Expected: FAIL because the module and configurable search limit do not exist.

- [ ] **Step 3: Generalize the existing egress limit without changing notification behavior**

Add `maxSearches?: number` to `EgressPolicy` and replace the fixed comparison with:

```ts
const maxSearches = policy.maxSearches ?? DISCUSSION_MAX_SEARCHES;
if ((policy.searchCount ?? 0) >= maxSearches) return { ok: false, reason: 'search_limit' };
```

Existing notification tests must continue proving the default remains three.

- [ ] **Step 4: Implement knowledge prompt and bundle validation**

Export:

```ts
export const KNOWLEDGE_MAX_SEARCHES = 12;
export function buildResearchPrompt(source: ChatGptShareRecord): string;
export function validateResearchOutput(output: string): ResearchBundle;
export function researchEgressPolicy(source: ChatGptShareRecord): EgressPolicy;
```

The prompt must label the share as untrusted data, require Traditional Chinese, original-source priority, counter-evidence, short quotations only, JSON-only output matching `ResearchBundle`, and one selected book for Phase 1. It must require `WebFetch` of the canonical ChatGPT share before any search, require candidate books to cite concrete discussion evidence, and instruct the runner to fail closed when the share does not yield substantive conversation content. Metadata or search-result snippets alone are not sufficient evidence that a book appeared in the discussion.

- [ ] **Step 5: Run focused and regression tests**

Run: `npx tsx sim/knowledge/researchSecurity.test.ts && npx tsx sim/run.test.ts`  
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add sim/knowledge/researchSecurity.ts sim/knowledge/researchSecurity.test.ts sim/notificationSecurity.ts sim/run.test.ts
git commit -m "feat(knowledge): bound public source research"
```

## Task 4: Implement the isolated Claude research runner

**Files:**
- Create: `sim/knowledge/researchRunner.ts`
- Create: `sim/knowledge/researchRunner.test.ts`

- [ ] **Step 1: Write failing invocation tests**

Inject a `spawnProcess` seam and assert the invocation uses Claude Sonnet, `--tools WebSearch,WebFetch`, `--allowedTools WebSearch,WebFetch`, `--no-session-persistence`, an empty temporary cwd, filtered environment, PreToolUse hook, a 15-minute timeout and captured output. Assert the prompt starts from the canonical share URL, requires discussion evidence before selecting a book, and treats an inaccessible or content-empty share as failure. Assert exit 0 with empty output is failure.

- [ ] **Step 2: Run and confirm RED**

Run: `npx tsx sim/knowledge/researchRunner.test.ts`  
Expected: FAIL because the runner does not exist.

- [ ] **Step 3: Implement the runner**

Reuse `safeDiscussionEnvironment` semantics without importing `sim/run.ts`. Write the policy JSON with mode `0600`, point the existing `notification-egress-hook.ts` at it, increment `searchCount` through the hook, and remove the temporary directory in `finally`.

```ts
export async function runKnowledgeResearch(
  source: ChatGptShareRecord,
  deps: ResearchRunnerDeps = defaultResearchRunnerDeps,
): Promise<{ bundle: ResearchBundle; rawOutputSha256: string; durationMs: number }>;
```

Do not persist the raw share HTML, raw model prompt or raw model output.

- [ ] **Step 4: Run focused tests and sim typecheck**

Run: `npx tsx sim/knowledge/researchRunner.test.ts && npx tsc -p sim/tsconfig.json --noEmit`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add sim/knowledge/researchRunner.ts sim/knowledge/researchRunner.test.ts
git commit -m "feat(knowledge): add isolated research runner"
```

## Task 5: Add idempotent Task Tracker intake and evidence updates

**Files:**
- Create: `sim/knowledge/taskTrackerAdapter.ts`
- Create: `sim/knowledge/taskTrackerAdapter.test.ts`

- [ ] **Step 1: Write failing fake-client tests**

Assert the adapter searches the fixed Project for exact canonical URL plus digest before creating `[SOURCE]`, creates one `[BOOK]` task for the selected normalized title/author, writes one evidence comment per action key, and PATCHes only one field per request.

- [ ] **Step 2: Run and confirm RED**

Run: `npx tsx sim/knowledge/taskTrackerAdapter.test.ts`  
Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement the adapter around an interface**

```ts
export interface KnowledgeTaskClient {
  listProjects(workspaceId: string): Promise<Array<{ project_id: string; name: string }>>;
  createProject(workspaceId: string, name: string): Promise<{ id: string }>;
  listTasks(workspaceId: string): Promise<TaskRow[]>;
  createTask(workspaceId: string, input: CreateTaskInput): Promise<{ id: string }>;
  getComments(taskId: string): Promise<CommentRow[]>;
  postComment(taskId: string, content: string): Promise<{ id: string }>;
  patchTask(taskId: string, field: 'status' | 'description', value: string): Promise<void>;
}
```

Use markers `Knowledge-Source-Key: <sha256>`, `Knowledge-Book-Key: <sha256>` and `Knowledge-Action-Key: <sha256>` in descriptions/comments for readback and dedupe. Do not add database tables.

- [ ] **Step 4: Run focused tests**

Run: `npx tsx sim/knowledge/taskTrackerAdapter.test.ts`  
Expected: `taskTrackerAdapter.test.ts OK`.

- [ ] **Step 5: Commit**

```bash
git add sim/knowledge/taskTrackerAdapter.ts sim/knowledge/taskTrackerAdapter.test.ts
git commit -m "feat(knowledge): track idempotent knowledge work"
```

## Task 6: Add the public `books` domain and book validator

**Files (knowledge-mirror):**
- Modify: `README.md`
- Modify: `scripts/build_pages.py`
- Create: `scripts/validate_book_notes.py`
- Create: `scripts/validate_book_notes_test.py`
- Create: `notes/books/index.md`

- [ ] **Step 1: Write failing Python validator tests**

Use `tempfile.TemporaryDirectory()` to test a valid package and failures for missing book index, fewer than three files in a topic directory, missing required headings, no primary source, unsupported important claims, non-HTTPS sources, excessive block quotes and missing cross-book index entry.

- [ ] **Step 2: Run and confirm RED**

Run: `python3 scripts/validate_book_notes_test.py`  
Expected: FAIL because the validator does not exist.

- [ ] **Step 3: Implement the validator**

Provide:

```python
def validate_book_package(root: Path, slug: str) -> list[str]:
    """Return every validation problem; an empty list means PASS."""
```

Require the headings approved in the spec, a `## 來源清單與查證日期` section in each deep note, at least one `[primary]` source in the book index, explicit `待查證` for unverified claims, and no block quote longer than 25 words.

- [ ] **Step 4: Add `books` to the builder and README**

Change:

```python
DOMAINS = {'ai', 'backend', 'books', 'finance', 'infrastructure', 'mobile'}
```

Document `notes/books/<book-slug>/index.md`, the three-file topic minimum, lowercase slugs and canonical/generated boundary. Create `notes/books/index.md` with `## 已完成研究`, `## 主題關聯`, `## 推薦閱讀路徑`, `## 待研究書籍`, and `## 證據不足或未收錄項目`.

- [ ] **Step 5: Run validator and site build**

Run: `python3 scripts/validate_book_notes_test.py && python3 scripts/build_pages.py`  
Expected: validator OK; build exits 0 and `docs/manifest.json` contains slug `books/index`.

- [ ] **Step 6: Commit in knowledge-mirror**

```bash
git add README.md scripts/build_pages.py scripts/validate_book_notes.py scripts/validate_book_notes_test.py notes/books/index.md docs
git commit -m "feat(books): add validated knowledge domain"
```

## Task 7: Harden showcase synchronization for dry-run

**Files (knowledge-mirror):**
- Modify: `scripts/build_showcase.py`
- Create: `scripts/build_showcase_test.py`

- [ ] **Step 1: Write failing temporary-repo tests**

Test `--dry-run` leaves the target byte-for-byte unchanged, rejects a dirty target, rejects an unexpected origin, reports create/update/delete paths, preserves `.git` and README, and writes no commit.

- [ ] **Step 2: Run and confirm RED**

Run: `python3 scripts/build_showcase_test.py`  
Expected: FAIL because the CLI lacks the new gates.

- [ ] **Step 3: Refactor copy planning from mutation**

Define:

```python
@dataclass(frozen=True)
class CopyPlan:
    create: tuple[str, ...]
    update: tuple[str, ...]
    delete: tuple[str, ...]

def plan_copy(docs: Path, out: Path) -> CopyPlan: ...
def apply_copy(plan: CopyPlan, docs: Path, out: Path) -> None: ...
```

Add CLI flags `--dry-run`, `--expected-origin`, and `--release-id`. Default behavior remains manual apply without commit or push; Phase 1 orchestrator must always pass `--dry-run`.

- [ ] **Step 4: Run tests and manual dry-run against the isolated showcase worktree**

Run: `python3 scripts/build_showcase_test.py`  
Expected: test OK.

Run: `python3 scripts/build_showcase.py /home/hom/knowledge-showcase/.worktrees/knowledge-publishing-phase1 --dry-run --expected-origin https://github.com/ChenHom/knowledge-showcase.git --release-id phase1-fixture`  
Expected: prints a deterministic copy plan and makes no target changes.

- [ ] **Step 5: Commit in knowledge-mirror**

```bash
git add scripts/build_showcase.py scripts/build_showcase_test.py
git commit -m "feat(publish): add safe showcase dry-run"
```

## Task 8: Configure knowledge-mirror for Harness

**Files (knowledge-mirror):**
- Create: `.harness/config.json`

- [ ] **Step 1: Write the repository contract**

Use this exact intent:

```json
{
  "schemaVersion": "1",
  "repositoryId": "knowledge-mirror",
  "context": {
    "entryPoints": ["README.md", "notes/books/", "scripts/build_pages.py", "scripts/validate_book_notes.py"]
  },
  "filesystem": {
    "protectedPaths": [".git/**", ".harness/**", "docs/assets/vendor/**"]
  },
  "verification": {
    "checks": [
      { "id": "book-validator", "kind": "test", "argv": ["python3", "scripts/validate_book_notes_test.py"], "required": true },
      { "id": "showcase-validator", "kind": "test", "argv": ["python3", "scripts/build_showcase_test.py"], "required": true },
      { "id": "build", "kind": "test", "argv": ["python3", "scripts/build_pages.py"], "required": true }
    ]
  }
}
```

- [ ] **Step 2: Verify the contract with current Harness**

Run: `node /home/hom/code/harness/src/cli.ts doctor /home/hom/knowledge-mirror/.worktrees/knowledge-publishing-phase1`  
Expected: doctor passes repository and isolation checks.

- [ ] **Step 3: Commit in knowledge-mirror**

```bash
git add .harness/config.json
git commit -m "chore(harness): define knowledge repository contract"
```

## Task 9: Orchestrate Phase 1 through Harness and publisher dry-run

**Files (task-tracker):**
- Create: `sim/knowledge/orchestrator.ts`
- Create: `sim/knowledge/orchestrator.test.ts`
- Create: `sim/knowledge/run.ts`
- Modify: `package.json`
- Modify: `docs/operations.md`

- [ ] **Step 1: Write failing orchestration tests**

Use fake intake, research, Task Tracker, Harness and publisher dependencies. Assert the exact sequence:

```text
fetch -> ensure source task -> research -> ensure book task -> Doing
-> create/run Harness Work -> verify evidence -> Review
-> build -> showcase dry-run -> evidence comment
```

Assert research failure leaves Doing, required Harness fail/unknown prevents publisher, publisher dry-run failure leaves Review, repeated action keys produce no duplicate comments, and Phase 1 never PATCHes Done.

- [ ] **Step 2: Run and confirm RED**

Run: `npx tsx sim/knowledge/orchestrator.test.ts`  
Expected: FAIL because the orchestrator does not exist.

- [ ] **Step 3: Implement dependency-injected orchestration**

```ts
export interface Phase1Dependencies {
  fetchSource(url: string): Promise<ChatGptShareRecord>;
  research(source: ChatGptShareRecord): Promise<ResearchBundle>;
  tasks: KnowledgeTaskAdapter;
  harness: KnowledgeHarnessAdapter;
  publisher: KnowledgePublisher;
}

export async function runPhase1(input: {
  sourceUrl: string;
  workspaceId: string;
  knowledgeMirror: string;
  showcase: string;
  dryRun: true;
}, deps: Phase1Dependencies): Promise<Phase1Result>;
```

The real Harness adapter must execute `doctor`, `new`, `run`, and `show`, capture the Work ID without shell parsing ambiguity, and require every configured check to pass. The publisher adapter runs the book validator, build, `git diff --check`, and `build_showcase.py --dry-run`; it performs no commit or push.

- [ ] **Step 4: Add explicit CLI and test registration**

Add:

```json
"knowledge:phase1": "tsx sim/knowledge/run.ts"
```

The CLI requires `--source`, `--workspace`, `--knowledge-mirror`, `--showcase`, and literal `--dry-run`; absence of `--dry-run` must exit 2. Add all focused tests to `npm test`.

- [ ] **Step 5: Document operation and recovery**

Document the command, state/artifact locations, filtered environment, Task transitions, Harness evidence, no-push guarantee, action-key dedupe and failure recovery. Explicitly state that this command is not part of `npm run sim` and has no timer.

- [ ] **Step 6: Run focused tests and full Task Tracker gate**

Run: `npx tsx sim/knowledge/orchestrator.test.ts`  
Expected: OK.

Run: `npm test`  
Expected: all lint, TypeScript and test gates pass.

- [ ] **Step 7: Commit in task-tracker**

```bash
git add sim/knowledge package.json docs/operations.md
git commit -m "feat(knowledge): orchestrate verified book publishing"
```

## Task 10: Run the approved real-source dry-run

**Files:**
- No planned source changes; generated book notes and `docs/` changes are expected in the knowledge-mirror feature worktree.

- [ ] **Step 1: Record clean baselines**

Run `git status --short --branch` and `git rev-parse HEAD` in all three worktrees. Stop if any unrelated change exists.

- [ ] **Step 2: Verify Task Tracker health**

Run: `curl -sS http://127.0.0.1:3000/api/health`  
Expected: HTTP 200 JSON with `status: ok` and `db: true`.

- [ ] **Step 3: Execute Phase 1 with the public share**

```bash
npm run knowledge:phase1 -- \
  --source https://chatgpt.com/share/6abb3cc5-afc8-83ee-b169-f7ded2cb4081 \
  --workspace d9da9945-ce5f-400f-806e-1d75e95e313a \
  --knowledge-mirror /home/hom/knowledge-mirror/.worktrees/knowledge-publishing-phase1 \
  --showcase /home/hom/knowledge-showcase/.worktrees/knowledge-publishing-phase1 \
  --dry-run
```

Expected: one `[SOURCE]` task, one selected `[BOOK]` task, valid research bundle, Harness PASS, knowledge-mirror notes/docs diff, deterministic showcase copy plan, book Task in Review, no remote push.

- [ ] **Step 4: Verify generated knowledge**

Run in the knowledge-mirror worktree:

```bash
python3 scripts/validate_book_notes_test.py
python3 scripts/validate_book_notes.py --all
python3 scripts/build_pages.py
git diff --check
git status --short
```

Expected: all validators/build pass; diff contains only the selected book, books index, approved scripts/config, and generated docs.

- [ ] **Step 5: Verify showcase remained unchanged**

Run in the showcase worktree: `git status --short`  
Expected: empty output because Phase 1 uses `--dry-run`.

- [ ] **Step 6: Record dry-run evidence without publishing**

Post a deduplicated Task comment containing source digest, Harness Work ID, validation outcomes, knowledge-mirror diff summary and showcase copy plan. Do not PATCH Done, commit generated book content, push either repo, or enable a timer.

- [ ] **Step 7: Stop at the rollout review gate**

Present the selected book, note list, primary/research sources, unsupported or disputed claims, Git diffs, test results and proposed public URLs for human review. The next plan may enable deterministic commit/push only after this evidence is approved.

## Final verification checklist

- [ ] `npm test` passes in task-tracker.
- [ ] `python3 scripts/validate_book_notes_test.py` passes in knowledge-mirror.
- [ ] `python3 scripts/build_showcase_test.py` passes in knowledge-mirror.
- [ ] `python3 scripts/build_pages.py` passes and manifest includes `books/index` plus the selected book notes.
- [ ] Harness `doctor`, `run`, and `show` report required checks PASS.
- [ ] Task Tracker source/book tasks and action-key comments are idempotent.
- [ ] Book Task is Review, not Done.
- [ ] Showcase worktree is unchanged after dry-run.
- [ ] No remote push, timer enablement, live sim, or unrelated repo modification occurred.
