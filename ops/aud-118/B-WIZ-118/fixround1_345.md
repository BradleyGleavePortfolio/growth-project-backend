FIX ROUND 1 (B-WIZ-118, agent 118) — growth-project-mobile#345 @ 97c9005e644ebc13731d1477bfecc270a10552fd

Brought up to main first (merge-only, clean): `48c34822` merges main `7fdb629a`; this PR's own diff was unchanged by it (1,878 lines). Then tests (`089e8527`, failing-before), fix (`d197ea9c`), and `97c9005e` (one-time answer checked by billing type and price only).

| Finding | Change | Commit | Test |
|---|---|---|---|
| B-345-1 (Opus) = B-345-2 (Sol): a cadence changed after the package was made never reached the server, and the helper remembered it | `toBackendUpdate` (src/api/packagesApi.ts) sends `billing_type`, `billing_interval`, `billing_interval_count` whenever `billingInterval` is set; one-time sends explicit nulls (backend B-629-4 clears the cadence, so recurring to free works in one PATCH). Stale TODO removed. `coachPackagesApi.update` checks the answer row when billing was sent: price and billing type must match, and for a recurring price also cadence and count; otherwise it fails closed with `PACKAGE_UPDATE_NOT_APPLIED` (specific copy, no Sentry report), so the helper does not remember the new input. `fromBackend` reads raw `interval` / `interval_count` (create and PATCH answers are raw rows: a yearly row no longer reads as monthly). Name-only edits send no billing fields and are not checked. | d197ea9c, 97c9005e | w1FixRound118.test.ts: exact PATCH bodies for monthly->one-time, one-time->monthly, paid->free; row kept old billing -> fails closed and intent unchanged; recurring cadence mismatch; yearly read-back |
| B-329-5 helper (Opus) = B-345-1 (Sol): the helper could send, call back or write storage after its owner was gone | `createPackageOnce({ isLive })` (optional, so the W3 editor compiles unchanged). Checked before the first step and after every await; once false it throws `PackageCreateStoppedError`: no request, no `onIntent`, no storage write. A sent intent stays on disk for the same account; a fresh intent written but never sent is removed again. | d197ea9c | w1FixRound118.test.ts: retired during write-ahead (no create, no callback, no leftover), re-sent create answering after sign-out, update answering after close, retired before start, live control |
| B-345-3 (Sol): unknown failures sent the raw exception to Sentry and had no reference when the server gave none | `describeError` (src/lib/coachSetup/errors.ts) reports a fixed `CoachSetupFailure` with closed fields only (area, action, kind, status, code only if it has the machine-code shape, transport, reference). Reference = server request id, else the X-Request-Id this app sent, else a fresh id (`diagnosticReference(supportReferenceOf(err))`); it is the Sentry `reference` tag, and the coach reads the same value (server id, or the short form of a client id). | d197ea9c | w1FixRound118.test.ts: local failure (fixed error, marker absent, shown ref = tagged ref), 500 with body text and a non-machine code, 418 with only the sent X-Request-Id |
| C-345-1 (Opus, copy truth on the money list) | Helper doc states the guarantee: per account on this device (sign-out wipes device storage); the form copy is narrowed in #346. | d197ea9c | - |
| C-345-2 (Opus) | W1 now carries its own tests for the helper, adapter and diagnostics. | 089e8527 | - |
| C-345-3 (Opus) | Tier header and Fix rounds table added to the PR body. | - | - |

Today's production backend (643817b3, coach backend #674/#676/#677 not deployed), capability checked in code:
- PATCH billing fields exist today (controller maps `billing_interval` -> `interval`), so the cadence fix works now.
- No `POST /coach/connect/status/refresh`: the 404/405 fallback to `GET /coach/connect/status` is now marked `refreshUnavailable`, so the panel (#346) does not say "Stripe did not answer just now".
- Legacy status payload (`requirements_due` = currently ∪ past ∪ eventually, no `state`): an account with charges and payouts on is shown as ready, not "Stripe needs an update" because of eventually-due items; accounts not switched on still list what Stripe needs.
- No `/v1/coach/money/charges`: the first-payment tick keeps the device-gate fallback, which can lag on a new device but never ticks without proof.

Failing-before (test commit `089e8527` without the fix): [CI lane 37219210136](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219210136): 14 failed, 3 passed (the 3 are controls). The two cases added in `97c9005e`: "recurring cadence mismatch" fails before (no check existed); "one-time leftover cadence" is a control.

Probe replay at this head: [CI lane 37220301571](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220301571)
| Probe | Result |
|---|---|
| Opus audOpusS12HelperProbe: control unchanged details send no PATCH | pass |
| Opus: monthly made, one-time picked, PATCH carries billing_type one_time | pass (was fail) |
| Opus: monthly made, free picked, PATCH one-time $0 | pass (was fail) |
| Opus: one-time made, monthly picked, PATCH recurring + month | pass (was fail) |
| Sol 345-contract-diagnostics: control unchanged intent | pass |
| Sol: changed retry sends one-time through the PATCH adapter | fails closed by design: the wire assertion holds (`billing_type: one_time` is sent), but the probe's double answers with the old recurring row, so the update is refused with PACKAGE_UPDATE_NOT_APPLIED instead of reporting a change the server did not make. Same probe with a double that applies the PATCH (345-contract-diagnostics-appliedrow): pass |
| Sol: paid-to-free finishes against merged pricing | pass (was fail) |
| Sol: unknown local failure has a reference | pass (was fail) |
| Sol: no untrusted exception text to Sentry | pass (was fail) |

Money list self-check:
- Webhook order and redelivery: no webhook handling here; Connect state is read from the server after every Stripe visit, so a late or repeated event only changes what the next read shows.
- Concurrency: one Idempotency-Key per intent, written before send; a second tap is held by the caller's in-flight guard; a retired create sends nothing more; a re-send replays the same package. Two devices still use two keys (unchanged, server-side rule).
- Terminal states: 410 IDEMPOTENT_PACKAGE_REMOVED -> fresh create; archived or missing remembered package -> fresh create (#346); sign-out or account switch -> the create stops with no writes. Refund, dispute and cancel are not read by W1.
- List pagination and completeness: the setup reads are existence checks; `GET /v1/coach/packages` returns the coach's full list (no cursor); charges read uses `limit=1` for "any paid".
- Currency: USD only; prices compared in minor units (`amount_cents`) on the answer row; presentment = settlement (USD).
- Copy truth: nothing reports a cadence or price as saved until the server row shows it; stale and legacy status copy says what is known; guarantee copy narrowed (C-345-1).

Size: 2,580 changed lines (2,573+ / 7-, no lockfiles), in the 1,500-3,000 band: operator SIZE ASSESSMENT needed.

Checks at this head: Typecheck, lint, test pass; Analyze (javascript-typescript) pass; Analyze (actions) pass; CodeQL pass.

READY FOR AUDIT
