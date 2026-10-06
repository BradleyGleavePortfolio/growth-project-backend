AUDIT GPT-6.1 Sol — growth-project-backend#785 @ f64275e42c27bc703ac73d3c4f5357163378bc01 — VERDICT: REQUEST CHANGES

A=2 B=0 C=0; U=0.

**A-785-1 — `build-and-test` fails from this PR's intended contract changes.** The retrieved job log identifies `invite-attach-reliability.spec.ts`, `rate-limit.spec.ts`, `throttler-isolation.spec.ts`, and `dunning-v2-lockout-allowlist-route-table.spec.ts`: assertions still encode the previous signup/login ceilings or exact mounted route inventory, while this PR changes those ceilings and adds the public resend route. [Failing check](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37525742910/job/112482163738), [changed throttler contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f64275e42c27bc703ac73d3c4f5357163378bc01/src/throttler/throttler.config.ts), [new route](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f64275e42c27bc703ac73d3c4f5357163378bc01/src/auth/auth.controller.ts#L348-L365).

**A-785-2 — `Banned cast tokens (R75 / R100.A2)` fails from newly added casts.** Its log reports net +1 `as any` in `src/auth/auth.service.ts`, net +2 `as unknown as`, and net +6 `as never` in `test/hunt02-auth-recovery.spec.ts`. [Failing R75 check](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37525742609/job/112482162777), [resend implementation, file:line 1470](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f64275e42c27bc703ac73d3c4f5357163378bc01/src/auth/auth.service.ts#L1463-L1485).

Fix the expected contracts while retaining endpoint bucket isolation/account locks, replace the new casts with the existing typed transport/double patterns, and obtain green CI before READY. No normal-user B found in the reviewed anonymous resend response, email normalization, signup limit, or preserved password lock; the REQUEST CHANGES is specifically required by the PR-caused CI failures. [Reviewed changes](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/785/files).

No local test/build, code push, merge, deployment, or provider action.
