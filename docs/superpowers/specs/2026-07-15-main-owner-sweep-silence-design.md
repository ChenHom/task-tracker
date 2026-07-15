# Main Workspace Owner Sweep Silence Design

## Goal

Keep main-workspace discussion threads readable by preventing the Owner sweep
from posting a repeated status summary when the task has not materially
changed.

## Scope

This changes only the instruction contract supplied to the Owner's
main-workspace sweep session and its regression coverage. It does not add
database state, API routes, timers, or a new moderation mechanism.

## Behaviour

Before posting to an existing main-workspace discussion, the Owner reads the
comments and compares them with the last Owner update. It must stay silent
when there is no new substantive participant or boss input and no lifecycle
change.

An Owner comment remains appropriate when it is required to:

- publish the initial `【OWNER想法】` or `【全員回覆：N天】`;
- answer a new direct instruction or substantive participant input;
- record a new blocker, scope decision, status change, or conclusion; or
- perform the required post-deadline conclusion flow.

Repeated reminders that the discussion is still `Todo`, that the same deadline
has not arrived, or that already-recorded consensus is unchanged are not
material changes and must not produce a comment.

## Implementation

Add this explicit rule to `ownerSweepPrompt()` for the main workspace. Extend
`sim/run.test.ts` to assert the prompt includes the no-change silence rule.
Keep `docs/owner-sweep-guide.md` aligned with the enforced instruction.

## Verification

Run the focused sim prompt test and TypeScript typecheck. No live sweep is run:
it would invoke real AI and mutate the board, which requires separate explicit
authorization.
