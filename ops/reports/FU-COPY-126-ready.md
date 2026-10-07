FIX ROUND 1 (OPENING) (FU-COPY-126, agent 126) — growth-project-mobile#440 @ 48348a628a40b5323a99cb1a547e5e2c92baae57 — READY FOR AUDIT

Tier T2. B=0, U=6, C=0; 263 additions + 101 deletions = 364 changed lines, including tests.

- U-17-5/6/7: one working bulk-invite Settings entry, Codes -> emailed-invite history, truthful missing-code/history states, and safe action-specific invite alerts.
- U-03-3: coachless Messages opens the existing coach-code sheet behind the existing server capability, keeps support, refreshes the thread on attachment and preserves the sheet welcome.
- U-08-7/U-12-4: specific meal/list/bookmark failures, recipe 404 versus load-failure distinction and retry, and removal of inert Units/Calorie Display controls.

Acceptance evidence:
- Main-fail regression lane: 17 failed / 44 passed across six suites — https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37555490180
- Fixed targeted lane: 70/70 tests across eight suites — https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37555731169
- Full PR CI: guards, lint, typecheck and full tests passed — https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37555724890/job/112581382146
- All CodeQL checks green at the exact head.

Pushed once; no fix-round repush was needed. No auth/tenancy, PII, money behavior, backend, flag, migration, dependency or lockfile changes. No overlap with the open builder file sets checked. No operator/owner decision needed.
