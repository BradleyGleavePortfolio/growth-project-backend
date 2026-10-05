# #653 independent Sol fix verification requirements

Candidate head: `9a23e3b2471794a1356d9939cc4e06682f1ea7ec`.
The exact independent spec is retained as `653-expiry-boundaries.spec.ts`.
CI run: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37366141725

## B-653-1: expiry deadline across lock waits

Preserve the owner's answer-window rule and the current request-expiry error envelope.

1. Start moving a request with one second left; delay coach advisory-lock acquisition until the deadline has passed. Expect 409 REQUEST_EXPIRED and no interval/deadline change.
2. Start approving a request with time left; hold the request's row lock until after the deadline. After release, require the same refusal rather than confirmation based on a bound pre-wait timestamp.
3. Replay both schedules with the expiry sweep absent; it must not be necessary for a cron tick to make the exact deadline authoritative.
4. Keep controls: actions immediately before the deadline remain allowed, an instant booking has no deadline, a permitted re-approval move before expiry still creates a fresh answer window, and other-client/other-coach access remains denied.
5. Preserve lock order. Do not acquire the coach lock after holding a session row if another path does coach→session.
6. A transaction-start `now()` does not fix a wait that occurred inside the transaction. Clock/expiry predicates must refer to the relevant post-wait/write instant.

## B-653-2: singleton and notice claim lifetime

Preserve dead-worker takeover, channel receipts, max attempts and backlog catch-up.

1. Make expiryPass consume more than the singleton TTL before notices start. A worker without current singleton ownership must not continue emitting under that stale ownership.
2. If ownership is renewed, each notice lease must be based on the actual claim time, not the original sweep time; new rows must never start already expired.
3. Two instances must not emit the same recipient after takeover while the old instance is still alive. The submitted probe blocks its first emitter call to expose current behavior; if the chosen fix correctly stops before any call on lost ownership, adapt that barrier to race with completion rather than requiring an emitter call. If the fix renews ownership, the competing worker may properly return `held` instead of `acquired`.
4. Same-instance overlapping cron invocations need an acquisition-generation token or equivalent fence: an old release must not clear the newer acquisition merely because holder strings match.
5. Retry only channels lacking receipts; never repeat an existing in-app row because push failed. Keep the existing dead-worker and three-attempt controls.
6. Bound page/work duration or renew and recheck ownership, without truncating the backlog permanently.
7. Exercise the new `expired` enum, constraint slot release, actual lease table/claim uniqueness and clock/lock schedules against PostgreSQL, not only the in-memory fake.

## Freeze and scope

Only the two B fixes are required; C-653-1 remains optional unless its line is changed for a B fix.
No migration rename, answer-rule change, removal of expiry/recovery, onboarding gate or production flag action is required by these findings.
