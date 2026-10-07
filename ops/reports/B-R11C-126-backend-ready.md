FIX ROUND 1 (OPENING) (B-R11C-126, agent 126) — growth-project-backend#811 @ e1d804b7ef36b167b3f4b2ec3aac4d97a484cbbf — READY FOR AUDIT

- CI at this head: every check SUCCESS (build-and-test, danger, rls-live-tests, community-live-tests, mwb-3-live-tests, schema parity, banned casts, CodeQL, npm audit, rls-floor-guard, test-deploy-readiness); deploy-readiness-gate SKIPPED (not a deploy).
- Size: 75 changed lines (69+/6-), 3 files: `src/ai-consent/ai-consent.service.ts`, `test/ai-consent/ai-consent-v5-scope.spec.ts`, `docs/ai-consent-ledger.md`. No schema, migration, route, DTO, flag or manifest change.
- Change: GET/POST/DELETE /me/ai-consent status returns `upgrade: null` unless `isRomanMemoryEnabled()` (FEATURE_ROMAN_MEMORY exactly "true"; production "unset"), and adds `memory_on: boolean` (the same flag) as the capability check for growth-project-mobile#446.
- Fixes: B (a v4 holder would be offered the v5 notes-and-summaries consent while no memory code runs: false customer-facing claim on any build that reads `upgrade`).
- Tests that fail on main: the four `FEATURE_ROMAN_MEMORY unset / empty / false / 1 -> upgrade null, memory_on false` cases (4 failed, 23 passed with the src change stashed). Flag true keeps the exact v5 upgrade copy; v5 holders, withdrawn and no-decision get no upgrade.
- 10-07 build contract unchanged (`app1007SeesLiveV4Grant` / `app1007ShowsUpdateApp` assertions still pass); POST still accepts v4 and v5 with their exact sha256.
