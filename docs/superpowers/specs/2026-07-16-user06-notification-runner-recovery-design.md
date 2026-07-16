# user06 notification runner recovery design

> **Superseded routing policy:** the Phase 1 instruction below to keep user06
> normal work on AGY is superseded by
> [the Claude Sonnet 5 work-route design](2026-07-16-user06-claude-sonnet5-work-route-design.md).
> Current policy: notification preflight uses Codex `gpt-5.4-mini`; normal work
> uses Claude `claude-sonnet-5` with no AGY fallback. The incident record below
> remains historical evidence.

## Goal

Unblock `user06` from normal assigned work without weakening the notification
gate, then make the AGY runner failure observable and recoverable.

## Current failure

`user06` uses the AGY runner. During main-workspace notification preflight it
can exit with status 0 after returning only a model-identification message,
without posting the required comment. The notification gate correctly leaves
the notification unread and excludes that member from normal work in the same
team sweep.

## Phase 1: containment

Route only `user06` notification-preflight sessions through the existing Codex
runner and a configured Codex model. Keep `user06` normal task sessions on
AGY. The existing gate remains authoritative: Codex must still post a valid
comment before the driver marks each notification read.

This is intentionally scoped to user06 notification handling. It does not
alter main-workspace rules, mark notifications read directly, or change user06
task ownership.

Rollback is one config/routing revert: restore user06 notification preflight to
AGY. Notifications that were not verified stay unread as they do today.

## Phase 2: root-cause repair

Repair the AGY headless invocation at the adapter boundary. Define session
success for this integration as an observable operation, not merely process
exit code. A no-action AGY response must be reported as a failed preflight and
must not be considered successful by the runner.

The concrete AGY CLI argument change will be chosen only after a focused,
non-mutating probe confirms its documented input mechanism. Fallback policy
remains quota-only unless that probe proves the runner reports a distinct,
safe-to-retry failure class.

## Verification

1. Unit-test the user06 notification route separately from user06 normal task
   routing.
2. Unit-test that a clean AGY exit without an observed notification comment
   cannot advance the notification gate.
3. Run `npx tsx sim/run.test.ts`, `npx tsc --noEmit`, and
   `npx tsc -p sim/tsconfig.json`.
4. After an explicitly authorized live team sweep, verify all four current
   user06 notifications have `read_at` set and that her next normal assigned
   session is scheduled. Do not run that live sweep as part of this change
   without separate authorization.
