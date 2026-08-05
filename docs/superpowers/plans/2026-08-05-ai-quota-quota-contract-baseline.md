# AI Quota / Task Tracker Quota Contract Baseline

> docs-only inventory baseline collected on 2026-08-05. The contract is already implemented; this file records the producer/consumer boundary and the temp-path smoke matrix so future changes can re-run the same checks without guessing.

## Scope

- Producer repo: `/home/hom/services/ai-quota`
- Consumer repo: `/home/hom/code/task-tracker`
- Shared private snapshot path: `/home/hom/.local/state/ai-quota/quota.json`
- Optional public copy: `/var/www/ai-quota-public/quota.json` (`AI_QUOTA_PUBLIC_PATH`, not used by task-tracker)

## Evidence Matrix

| Role | File / unit | What it owns | Contract notes |
| --- | --- | --- | --- |
| Producer | `/home/hom/services/ai-quota/deploy/ai-quota.timer` -> `/home/hom/services/ai-quota/deploy/ai-quota.service` | One-shot poll every 5 minutes, reads provider credentials, normalizes usage, writes the private snapshot atomically | The service pins `AI_QUOTA_STATE_PATH` to the shared private snapshot and also supports an opt-in public copy via `AI_QUOTA_PUBLIC_PATH`. |
| Producer schema | `/home/hom/services/ai-quota/src/types.ts` / `src/store.ts` | `schemaVersion: 1`, `generatedAt`, `providers.codex`, `providers.claude`, optional `providers.agy` | Private snapshot keeps `status`, `confidence`, `source`, `lastAttemptAt`, `lastSuccessAt`, `nextAllowedAt`, `consecutiveFailures`, `windows`, optional `resetCredits`, `raw`, and `error`. Public snapshot is an allowlist subset. |
| Consumer | `deploy/task-tracker.service` -> `src/quota.ts` -> `GET /api/quota` | Reads the shared snapshot from disk and maps it into the API/footer shape | The task-tracker service pins the same `AI_QUOTA_STATE_PATH`. The API returns the provider array only; it does not expose the internal `cachedAt` field. |
| Consumer UI | `public/js/quota.js` / `public/js/quota-format.js` / `src/quotaFrontend.test.ts` | Formats the API response for the footer and hover tooltip | The UI trusts the API shape, formats `resetAt` in `Asia/Taipei`, and shows stale/unavailable states without reimplementing quota logic. |

## Field Semantics

- `schemaVersion`: current supported schema on both sides is `1`.
- `generatedAt`: UTC ISO timestamp for the poll result. The consumer preserves it internally as `cachedAt`, but `/api/quota` does not expose it.
- `providers.codex` / `providers.claude`: required snapshot entries.
- `providers.agy`: optional snapshot entry. Missing or malformed agy data is not fatal to codex/claude history.
- `status`: `ok`, `stale`, `auth_failed`, `rate_limited`, or `unavailable`.
- `windows.five_hour` / `windows.seven_day`: normalized usage windows with `usedPercent`, `remainingPercent`, and `resetsAt`. The task-tracker consumer only needs `remainingPercent` and `resetsAt`.
- `remaining` / `resetAt` in task-tracker: chosen from `five_hour` first, then `seven_day`, then `null` if neither window is available.
- `stale`: producer says the last successful data is being reused or the snapshot could not be refreshed cleanly; task-tracker preserves the last known window values and marks the provider stale.
- `unavailable`: no usable window exists for that provider in the snapshot the consumer read.
- `source`: opaque to task-tracker except for display. Agy may append a source note such as `#model=...`; the consumer does not parse it.
- `resetCredits`: Codex-only detail in the private snapshot. It stays in the producer-side private file and is not part of the public allowlist.

## Compatibility Boundary

- Task-tracker currently reads the shared private snapshot, not the public nginx-served copy.
- The public copy is intentionally narrower and is safe for external consumers, but it is not the path used by `src/quota.ts`.
- Missing agy data is treated as a compatibility feature, not an error.
- A malformed file, unsupported `schemaVersion`, or missing required codex/claude provider entry is treated as unavailable state in task-tracker rather than a hard crash.

## Temp-Path Smoke Matrix

The matrix below is the minimal migration check for this contract. It uses a throwaway directory only; no live state path is touched.

| Case | Fixture shape | Producer-side expectation | Consumer-side expectation |
| --- | --- | --- | --- |
| `v1-pre-agy` | `schemaVersion: 1`, `generatedAt`, `providers.codex`, `providers.claude`, no `providers.agy` | `readSnapshot()` accepts the file and preserves codex/claude | `getQuotaSnapshot({ stateFile: tmp })` returns codex/claude plus `agy.unavailable = true` with `source = ai-quota-agy-missing` |
| `v1-current` | `schemaVersion: 1`, codex/claude plus valid agy entry | `readSnapshot()` accepts the file and round-trips agy | `getQuotaSnapshot({ stateFile: tmp })` returns all three providers; agy is surfaced like the other providers |
| `stale-reuse` | same as `v1-current`, but provider `status` is `stale` | producer keeps the last successful windows | consumer marks the provider stale and keeps the last known window values |
| `malformed-or-unsupported` | bad JSON, missing required provider, or `schemaVersion: 2` | `readSnapshot()` returns `null` | consumer returns unavailable entries instead of throwing |
| `path-override` | same fixture as above, but `AI_QUOTA_STATE_PATH` points at the temp file | both repos read the override path without touching the live snapshot | contract can be exercised in isolation, including from unit tests |

## Current Verification Set

- Producer-side contract coverage already exists in `/home/hom/services/ai-quota/test/store.test.ts`.
- Consumer-side contract coverage already exists in `src/quota.test.ts`.
- Footer formatting coverage already exists in `src/quotaFrontend.test.ts`.
- The live path wiring is already pinned in `deploy/ai-quota.service` and `deploy/task-tracker.service`.
- Temp-path smoke verified `AI_QUOTA_STATE_PATH` override, pre-agy acceptance, current agy acceptance, and `schemaVersion: 2` rejection without touching the live snapshot.

## Notes

- There is no real `schemaVersion: 2` in either repo today. The smoke matrix uses the current payload generations and the unsupported-version rejection case as the compatibility boundary.
- The consumer contract is intentionally narrow: it only needs the provider identity, status, source, and windows. That keeps the task-tracker side tolerant of extra producer fields as long as the required fields stay stable.
