# Sim Model Route Update Design

## Goal

Update two explicit model routes in the legacy sim harness so they match the currently available CLI models:

- Route `user04` work from Codex `gpt-5.4-mini` to `gpt-5.6-luna`.
- Route Owner opening and ideation work from Claude `claude-sonnet-5` to `claude-opus-5-5`.

## Scope

Change only `MEMBER_RUNNERS` for `user04` and `OWNER_OPEN_MODEL` in `sim/run.ts`. Keep Owner review, safe discussion, notification, fallback, effort, tools, timeouts, and every other member route unchanged.

Update the current-state documentation where it describes these active routes. Preserve statements that explicitly describe historical routes.

## Verification

Add focused assertions to `sim/run.test.ts` for the `user04` work model and Owner opening model. Follow red-green verification, then run:

```bash
npx tsx sim/run.test.ts
npx tsc --noEmit
```

Do not run `npm run sim` or any sweep command because those are live AI operations.
