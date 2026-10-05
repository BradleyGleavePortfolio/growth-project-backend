AUDIT GPT-6.1 Sol — growth-project-mobile#358 @ 4dcf0aff2644ff54fc5fe4de2c97751d7ac7cf94 — VERDICT: REQUEST CHANGES

A/B/C = 0/4/0

AUD-SOL-P34-120, agent 120. Independent first full T4 review of P4 against base `b364b9eaaedfb6d297f55a40e4b6a15ac4d2a381`; all seven changed files and their relevant API/backend/auth/telemetry boundaries read, not another lens's verdict reused. [Exact candidate](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/358).

### Findings

**B-358-1 — bulk assignment continues issuing mutations after the screen/session retires.** `ProgramAssignScreen.tsx:156-212` has no mount/owner/operation-generation fence before the next chunk or after an awaited request; the 51-client probe holds the first 50-client request, unmounts the real screen, resolves that request, and observes a second assign call when only the issued first call should remain. [Executed lifecycle counterexample](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37342003294).

On an account replacement the next request uses the API interceptor's then-current token while retaining the old screen's program/client intent, because the API reads SecureStore for every request. [Assign loop](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/4dcf0aff2644ff54fc5fe4de2c97751d7ac7cf94/src/screens/coach/programs/ProgramAssignScreen.tsx#L156-L212) / [request authentication](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/4dcf0aff2644ff54fc5fe4de2c97751d7ac7cf94/src/services/api.ts#L107-L116).

Minimal fix: capture the account and operation generation before the run, retire/abort on unmount/account change, fence every continuation and next request, and keep any already-issued unknown outcome as the original owner's retry intent rather than starting a new one; add deferred chunk/unmount/account-change tests.

**B-358-2 — a whole-program refusal drops unattempted selected clients from both results and Retry.** `ProgramAssignScreen.tsx:182-202,348-353` marks only the current chunk failed and breaks; for 51 selected clients and first-call 409 `program_archived`, only 50 are represented and the UI offers “Retry 50 failed,” leaving the last selected client without any refused/not-attempted outcome or Retry coverage. [Executed 51-client completeness counterexample](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37342003294) / [result and early-break path](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/4dcf0aff2644ff54fc5fe4de2c97751d7ac7cf94/src/screens/coach/programs/ProgramAssignScreen.tsx#L182-L205).

Minimal fix: explicitly account for the entire submitted client set on early termination, distinguish failed/unknown/not-attempted outcomes as appropriate, and include the unattempted remainder in recovery; test 51 and 101 clients with failures in the first and middle chunks.

**B-358-3 — failure telemetry contains client names and coach-entered package titles.** `ProgramHistoryScreen.tsx:79-82` passes the client name inside `action`, and `ProgramPackagesScreen.tsx:90` does the same with the package title; `describeProgramFailure` forwards that string to Sentry extras, while both actual event processors retain these strings. [Named-client call site](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/4dcf0aff2644ff54fc5fe4de2c97751d7ac7cf94/src/screens/coach/programs/ProgramHistoryScreen.tsx#L77-L83) / [package-title call site](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/4dcf0aff2644ff54fc5fe4de2c97751d7ac7cf94/src/screens/coach/programs/ProgramPackagesScreen.tsx#L89-L96) / [mapper telemetry](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/4dcf0aff2644ff54fc5fe4de2c97751d7ac7cf94/src/utils/programErrors.ts#L267-L275).

The real-screen failed-removal probe composes the actual privacy and credential processors over captured metadata and still finds its synthetic client name in `extra.action`; this is an executed metadata-boundary proof, not a claim of contacting production Sentry. [Executed privacy counterexample](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37342003294).

Minimal fix: separate local customer-facing action text from an allowlisted diagnostic operation code; pass only bounded codes/status/reference and approved opaque ids to telemetry, never names, titles, or arbitrary text, with removal and package-attachment failure tests.

**B-358-4 — destructive confirmation understates an all-runs removal.** `ProgramHistoryScreen.tsx:53-75` derives the warning from one `ProgramAssignee` copy, but calls the client-level unassign endpoint, whose backend removes all not-started assignments across every copy of that master for the client and preserves both started and completed assignments. [Per-copy warning/client-level request](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/4dcf0aff2644ff54fc5fe4de2c97751d7ac7cf94/src/screens/coach/programs/ProgramHistoryScreen.tsx#L53-L75) / [exact backend removal contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/ee55f814eb02b530e6578a168dc16c7ea7e2b07b/src/workout-builder/program-library.service.ts#L1462-L1498).

With two runs containing two and five upcoming workouts, the actual warning claims two will be removed although that endpoint targets seven; the probe observes precisely that warning mismatch. [Executed destructive-copy counterexample](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37342003294).

Minimal fix: confirm the true all-runs scope and state that in-progress/finished workouts remain; use authoritative preflight totals if displaying exact numbers, otherwise omit unprovable exact counts, and test repeated runs across pages plus started-but-unfinished workouts.

### Prior evidence, piece safety and CI

Relevant Programs files are byte-identical to original #328's last Sol-approved `fb76721fa21476cf36595fcd861a6b5a07630516`; reuse is limited to original B-328-1's date/key/retry counterexample and prior helper dispositions, not automatic piece approval or proof of these additional boundaries. [Prior Sol dispositions](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/328#issuecomment-5972137276).

Corrected independent lane has **four behavioral acceptance failures / seven candidate fix-round controls passing**; the initial completeness probe stopped on a multiple-match test query and is not claimed as the completeness proof. [Corrected exact-head-plus-test lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37342003294) / [initial lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37341628728).

Candidate “Typecheck, lint, test” is SUCCESS; main-only Analyze contexts are absent on this stacked piece, so neither the candidate green context nor prior approval establishes merge/release eligibility. [Exact-head candidate CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37154713307/job/111295639368).

The Programs tab is feature-gated with the legacy screen retained when off; P4 completes the earlier screen route registrations and must land with #355–#357 as the governed stack, not independently certify the underlying builder/backend/device acceptance. [Navigator wiring](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/4dcf0aff2644ff54fc5fe4de2c97751d7ac7cf94/src/navigation/CoachNavigator.tsx#L595-L612) / [P4 stack contract](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/358).

No local npm/Jest/tsc/lint/build, candidate-branch push, merge or production action. Evidence and portable probes: `ops/aud-120/AUD-SOL-P34-120/`; report: `ops/reports/AUD-SOL-P34-120.md`. Recommended operator default: fix B1–B4, replay these probes, restack, then obtain both exact-head verdicts and complete required main-targeted CI before landing.
