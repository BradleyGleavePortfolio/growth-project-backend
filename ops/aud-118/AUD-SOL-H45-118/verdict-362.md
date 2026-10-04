AUDIT GPT-6.1 Sol — growth-project-mobile#362 @ 439937c93ca8460aed23daef116aa49e7127efa3 — VERDICT: REQUEST CHANGES

A/B/C = 0/4/1

Independent T4 lens: AUD-SOL-H45-118, agent 118.

### B-362-1 — Raw retirement errors still enter the health logger

`src/hooks/useWearableConnections.ts:118-120` forwards the untyped storage rejection directly to `logger.warn`, unlike the already-repaired refresh/read sinks. [H4 candidate](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/439937c93ca8460aed23daef116aa49e7127efa3).

Two actual-hook/actual-retirement cases reject key enumeration with an Error and a plain object carrying synthetic private text: both fail the no-private-payload assertion, and the object case also forwards its storage key. [Executed independent probe](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219439582/job/111486604765).

This proves the logger boundary, not production transport: `src/utils/logger.ts:17-20` suppresses console output outside development. [H4 candidate](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/439937c93ca8460aed23daef116aa49e7127efa3).

**Minimal fix:** report only a fixed operation/error class, never the caught object, message, mutable name, key or other free-form fields; discard stale-session failure continuations before any reporting.

### B-362-2 — A late disconnect from A deletes B's new local Connect authorization

`src/hooks/useWearableConnections.ts:112-126` has no originating identity/generation fence around the server mutation's completion; `retireOnDeviceState(provider)` removes that source's records for **all** accounts. [H4 candidate](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/439937c93ca8460aed23daef116aa49e7127efa3).

The actual mutation/storage/fence test holds A's disconnect response, switches the identity to B and emits login, records B's fresh authorization, then releases A's successful response: B's `audit-connection-b` authorization is gone, so B's consented sync is retired by A's obsolete operation. [Executed independent probe](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219439582/job/111486604765).

**Minimal fix:** capture and carry the originating identity/auth generation through disconnect, suppress stale local writes/invalidation/reporting, and retire only the authorization/progress belonging to the intended user/source/connection consent epoch; an old cleanup must not remove a newer Connect.

### B-362-3 — Successful disconnect does not stop an already-running health read

`src/hooks/useWearableConnections.ts:113-126` deletes local authorization asynchronously but never stops the live health fence; a running paged import does not re-read authorization between native pages. [H4 candidate](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/439937c93ca8460aed23daef116aa49e7127efa3).

The actual hook, retirement, session fence, Health Connect sync and paged client are composed in the probe: hold native page 1, successfully disconnect and verify local authorization is absent, then resolve page 1 with a next-page token; native page 2 still starts (**expected 1 native call, received 2**), whereas the unchanged-connected control correctly reads both pages. [Executed independent probe](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219439582/job/111486604765).

This is a new read after a completed disconnect, not a demand to withdraw an OS request already in flight and not a claim of a successful post-disconnect backend ingest. [Executed independent probe](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219439582/job/111486604765).

**Minimal fix:** on a current-session successful disconnect, synchronously stop the relevant running health work before the first local-cleanup await or completion publication; use the existing health-stop seam or a scoped cancellation epoch, and prevent late reads, ingest requests and progress writes from the retired run.

### B-362-4 — The real parent closes the empty-import guidance before it can be seen

`src/screens/client/wearables/ConnectProviderSheet.tsx:295-300` calls `onConnected` before showing the zero-data explanation; `ConnectionsScreen.tsx:416-420` wires that callback to `closeSheet`, which hides the modal and clears its provider. [H4 candidate](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/439937c93ca8460aed23daef116aa49e7127efa3).

The actual parent plus actual sheet probe returns a complete first import with zero samples: the expected “no data from the last 30 days” guidance and recovery action are absent because the sheet is dismissed; the five-sample success control still closes normally. [Executed independent probe](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219439582/job/111486604765).

The existing isolated zero-data sheet test omits `onConnected`, and the parent suite mocks the sheet, so neither exercises this real callback contract. [H4 candidate](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/439937c93ca8460aed23daef116aa49e7127efa3).

**Minimal fix:** separate connection notification/cache refresh from dismissal, or defer the closing callback for empty first imports; keep the truthful zero-data guidance and its Close/Open Health Connect recovery visible, with a real parent/sheet regression on both platforms.

### C-362-5 — Optional: integrate the separate heart-rate query into overview state/recovery

`src/screens/client/wearables/HealthFitnessScreen.tsx:147-156,207-209,265-287,312-318` adds an independent resting-heart-rate query but still computes emptiness, errors and pull-to-refresh solely from the primary fitness query: a valid resting-heart-rate-only result is hidden by the empty-state return, and an RHR-only failure is neither surfaced nor retried by the main refresh action. [H4 candidate](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/439937c93ca8460aed23daef116aa49e7127efa3).

**Follow-up fix rule:** include the secondary series in meaningful-data detection, expose its bounded loading/error/stale state, and refetch both queries; add RHR-only and secondary-failure controls.

### Prior closure, evidence reuse and piece boundary

All 21 H4 diff-path blobs match this model's original APPROVE at `82137c312e957cb05eedeaebf86fcd95029f2bde`; the complete piece diff and its call sites were nevertheless read for split-boundary safety. [Original Sol approval](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5972055787).

Retained closures are scoped: the reported A-317-1 and B-317-1/2/5 authorization/progress/partial-import/reconnect cases, B-317-6 identity-capture cancellation, B-317-7 **sign-out** stop, B-317-8 cloud classification, B-317-9 native-setup cancellation, B-317-10 browser completion, B-317-11 import epoch/busy-state recovery, and the shell's closed-class/stale-log repair remain present; the new disconnect and empty-parent counterexamples above narrow prior evidence rather than pretending splitting introduced them. [Prior closure record](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5964406089), [latest original Sol approval](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5972055787), [independent new counterexamples](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219439582/job/111486604765).

The restack delta is only H2's four B-360-1 repair paths; H4 imports existing/lower-piece seams, contains no dependency/migration/CI-gate changes, and is **2,284 lines (source 1,082 / tests 1,202)** under the existing operator KEEP assessment. [Restack evidence](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5976975911), [size assessment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5975773360).

Original B-317-12 is H6's config-test integration issue, not an H4 finding; late-data/resumable-import follow-ups remain with H2/H3's owners and are not reissued here. [Original config finding](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5972176395), [current H2/H3 disposition](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/361#issuecomment-5982441393).

### Execution and landing limits

Exact-head required Typecheck/lint/test is successful: **453 suites / 6,482 tests**; independent test-only execution `08b7e93dbc49a9dd300c161e19a7988c399921f6`, derived from this exact candidate, runs **5 expected invariant failures / 2 positive controls passing**, with no setup failures. [Exact-head CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37179972912/job/111370381908), [independent targeted execution](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219439582/job/111486604765).

The targeted run also reports a worker-teardown warning after all seven tests execute; it does not explain away the five named assertion failures. [Executed probe log](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219439582/job/111486604765).

Both Analyze checks are main-base-only and absent on this stacked head, not claimed successful; H1–H6 must land as one with integrated main-based checks, no partial build/OTA, ingest off until the approved flag/release sequence, AI insights off pending D2, and installed-device/Play-declaration acceptance still outstanding. [Stack readiness/landing rule](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5975773360), [H2/H3 landing limits](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/361#issuecomment-5982441393).

No candidate source edit, PR-branch push, local heavy test, native build, merge, deployment or production action occurred; only the two audit specs and lane harness were pushed. [Audit execution commit](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/08b7e93dbc49a9dd300c161e19a7988c399921f6).
