FIX ROUND 1 (OPENING) (AUDIT-20-125, agent 125) — growth-project-mobile#416 @ 45a117a7fed0384f29fb7d8a81cb7f1b1afbc742 — READY FOR AUDIT

Tier T2. B=0; five highest-value U fixes in this PR; C=0.

- Readable light/dark primary tabs and preserved content above the bottom safe-area inset.
- Shared actionable press controls expose button semantics; explicit roles and non-actionable content are preserved.
- Selected exercise filters and error foregrounds use the correct contrast tokens; the Home message label can wrap for large text.

148 changed lines: 38 source + 110 tests (134 additions, 14 deletions), below the operator's revised under-150-line U-only cap.

Acceptance: lint, typecheck, release guards, and the full suite passed: 603 suites / 8,288 tests, including all four changed regression files. Both CodeQL analysis jobs passed. [Final PR CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37531749222)

Tests-only main baseline reproduced 11 regression failures with 6 existing/preservation assertions passing. [Baseline proof](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37530694949)

The opening CI caught the removed legacy `colors` import still needed by unchanged stack headers; restored it and pushed again before this READY comment. Tests were condensed to meet the updated size limit.

No backend, flags, dependencies, lockfiles, migrations, builds, merges, deploys, or production changes. No overlap with agent 124's open PR files.

Audit report also records a lower-priority legacy-screen dark-appearance migration, intentionally not expanded into this launch slice. Recommended default: defer that broad migration, and retain the normal device dark-mode/large-text/VoiceOver smoke pass.
