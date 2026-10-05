RESTACK + FIX ROUND 2 (B-661R2-120, agent 120) — growth-project-backend#702 @ b96611de95d7d5f31fd623a2a7a6b0f7d8a03db8

Two commits on `9ddda117` (fast-forward push, no rebase, no force):
- [21c187da](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/21c187dab49b85ae82334e3b443f6373dc647859): merge of #661 fix round 9 `e0cc97e1` (clean, no conflicts). Tree of `21c187da` = #661 `e0cc97e1` + this PR's earlier tests.
- [b96611de](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b96611de95d7d5f31fd623a2a7a6b0f7d8a03db8): the #661 round-9 regression and backfill tests (tests only).

Size: 831 changed lines (+826 / -5), three files, all test, under 1,500: `test/checkout-settlement.live.spec.ts`, `test/checkout-hosted-activation-once.spec.ts` (unchanged, SHA-256 `fc2e00c2...`), `test/checkout-grant-credentials.spec.ts` (new). Fix-round table for the source: #661 comment [FIX ROUND 9](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661#issuecomment-5999860654).

## Finding -> test

| Finding | Test | Before (src `bc399edd` + script) | After (`b96611de`) |
|---|---|---|---|
| B-661-14 (Sol) / B-661-15 (Opus) | `checkout-grant-credentials.spec.ts` (real handler, recurring fakes): G1 `invoice.paid` pays the first invoice; G2 `customer.subscription.updated` wins the race, the late `invoice.paid` neither restores nor re-fans-out; G3 / G3b carded trial granted by either event; G5 declined then paid (the decline keeps them for the retry) | 5 fail, only on the two credential fields | pass |
| B-661-14 (Sol acceptance, real PostgreSQL) | live block `#661 credentials at rest on real PostgreSQL`: paid grant by each event, carded-trial grant by each event (real handler, `PurchaseFanoutService`, Prisma) | 4 fail, only on the two credential fields | pass |
| controls (Sol lane 2, Opus G4) | G4 no default card / default with the create-time end still set; G6 unpaid first invoice; live unsaved-trial cases on both events | pass | pass |
| C-661-15 (Opus) | H1a paid plan deleted; H1d carded trial deleted before any grant event | pass | pass |
| C-661-2 (operator ruling) | live `C-661-2 backfill`: 13 spent, 6 payable, 1 credential-free row; dry run, batched apply (batch 4), idempotent rerun, other columns unchanged | script absent before round 9 | pass |
| C-702-1 (Opus, body stale) | PR body lists the three files, their provenance and the size | - | - |

## Evidence

| Check | Result |
|---|---|
| Failing-before lane (tests on `bc399edd` + script, fix absent) | [run 37348121187](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37348121187): `tsc --noEmit` green; 9 failed / 20 passed, exactly the 9 "(failed before)" cases |
| After + both lenses' probes (`b96611de` + probe commit `51f427cc`) | [run 37348700674](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37348700674): `tsc --noEmit` green; 44 suites / 609 tests, 0 failed, 0 skipped |
| Legacy 116 / 117 lens probes (interface-obsolete) | identical 7 failures at `9ddda117` ([37349960492](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349960492)) and `b96611de` ([37349395486](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349395486)); not counted as passing (details in the #661 comment) |
| PR CI at `b96611de` | 7 / 7 available required success (stacked base: CodeQL / R75 / SBOM / danger run only on main-based PRs; `check-r75.js` run locally on #661..#702 and main..#702: OK); build-and-test 775 suites / 13,274 passed; mwb-3 8 suites / 81 tests (the 7 new live tests included) |
| PR CI at #661 `e0cc97e1` | 11 / 11 required success |

## Probe replay (both lenses)

| Lens | Probe | At `9ddda117` | At `b96611de` |
|---|---|---|---|
| Sol 120 | composition live probe (byte-identical, SHA-256 `5beb8cae...`) | 4 failed (on `bc399edd`, [37341623338](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37341623338)) | pass |
| Sol 120 | run 2 controls, R5 PostgreSQL, R6 selection, 118 owner boundaries, run 1 list of 35 specs | pass | pass |
| Opus 120 | hunks probe H1a-e, H2a-c, H3a-d, G1-G4 | G1-G3 failed ([37343688493](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37343688493)) | pass (H3d still records C-661-16) |
| Opus 118 | `aud-opus-661-118.live.spec.ts` | pass | pass |
| Sol 116 / 117, Opus 116 | legacy minimal-double probes | 7 fail (interface) | same 7 fail, same errors |

## Money list

- Webhook order / redelivery: both event orders covered (G2, live x2); no second fanout; a rolled-back event keeps its credentials.
- Concurrency / lock order: no new lock; the backfill re-checks its predicate in each batch write.
- Terminal states: deleted plans (H1a, H1d) erase; historic refunded / disputed / canceled rows are in the backfill set.
- Pagination / fail-closed completeness: backfill batches by id, short page stops, rerun matches 0.
- Currency / minor units: not touched.
- Copy truth: no copy change.

## Follow-ups (C)

None new on this PR. #661 follow-ups C-661-13 / 14 / 16 / 17 / 18 / 10 are listed in its FIX ROUND 9 comment.

Lands with #661 as one unit (rule 11); never retarget to main alone.

READY FOR AUDIT

