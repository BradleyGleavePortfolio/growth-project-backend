Tier: T2
Why: Shared presentation-only failure handling and recovery controls for day-data reads and support.
T4 trigger scan: No auth/session, tenancy/RLS, credentials, payment operations, API transport, data deletion or server writes changed. Crisp ownership and fail-closed opening remain untouched. Existing food/water reads retain their contracts.
T3 trigger scan: No new contracts, dependencies, feature flags or backend capabilities. Works against the current production backend.
Bounded T1: Multiple presentation paths share error-state behavior, so targeted behavioral tests warrant T2 rather than a copy-only T1.
Canonical builder: GPT-6.1 Sol, AUDIT-19-125, agent 125.
Acceptance evidence: Tests-only main-baseline run [37530539554](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37530539554) reproduces all three findings: 19 behavioral failures, 9 existing/compatibility tests passing. [Fixed targeted run](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37531085675) passed 29/30 assertions; its one faulty CONTINUE test assertion and a test-navigation TS2352 from PR CI were corrected at 8302adc0465072c2674490a5c0e39884acec293d. [Current PR CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37532663392) checks that exact head. No additional lane dispatched after the operator override.

## U fixes
- U19-1: A client opens Home or Food Log during an ordinary network/server failure and sees empty or stale numbers without a failed-read notice; now both reuse the existing CoachErrorState with a working retry, disabled while loading, and a water-only read failure no longer silently becomes zero.
- U19-2: A person saving food, weight, a routine or another API-backed action gets raw `Network Error`, timeout text or `Internal Server Error`; the shared message helper now explains connection, timeout and temporary-service failures while preserving specific 4xx/domain messages.
- U19-3: A person opens Support but cannot use the native chat overlay and has no email alternative when the SDK reports it opened; a discoverable Report a problem by email action now uses the existing selectable-address, copy and retry fallback.

## Scope and overlap
- No overlap with #415's help-link/config/settings changes or #406's offline workout sync.
- Existing Home macro-mode and Food Log speed tests receive only recovery assertions and state setup; no food/workout write behavior changed.
- 334 changed lines (307 additions, 27 deletions), including tests; opened before the 14:05 budget/time-box override alongside the confirmed B fix in backend #787.
- No merge, deployment, build, production access or production flag changes.
