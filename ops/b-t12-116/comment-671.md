FIX ROUND 6 (B-T12-116, agent 116) — growth-project-backend#671 @ 1efac91e1c073c7ea67d3a81550f03c2210343bf

Closes the findings on #671 @ a6a2b589 from both lenses: Sol REQUEST CHANGES 0/1/0 (https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/671#issuecomment-5976061087) and Claude Opus 5.5 REQUEST CHANGES 0/1/3 (https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/671#issuecomment-5976130575). Rulings kept: real free trials, coach sets 0-30 days, card up front, one trial per client per coach, trial-ending notice; still inert until #673 (nothing registered in a module).

Commits: `af0f8a81` (tests only, failing before) then `1efac91e` (fix).
- Failing-before run (tests at `af0f8a81` on the unfixed code, CI lane with a Postgres 15 service): https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174151877 — 10 failed / 28 passed (every new B and C case red, every control green).
- Passing-after run (same three specs at `1efac91e`, plus `tsc --noEmit`): https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174355443 — 38/38 passed, tsc clean.

| Finding | Change | Commit | Test (red before, green after) |
|---|---|---|---|
| B-671-1 (Sol + Opus) two concurrent `markStarted` calls for one purchase with no reservation: the loser got `conflict` for its own started row (T3 would record a conflict and cancel a legitimate trial) | `trial-usage.service.ts` `markStarted`: after a skipped insert, and after a lost takeover of a released row, re-read the started row by purchase; the same purchase takes it through a bounded fenced compare-and-set (`startOwned`, 3 attempts) and returns `owned`; `conflict` only when a different purchase holds the trial | `1efac91e` | `test/b-trials-t1-fix-round-6.spec.ts` (two-way, three-way, lost released-row takeover, reservation committing between read and insert; controls: different purchase still `conflict`). `test/b-trials-usage-concurrency.live.spec.ts` on real Postgres: two transactions interleaved on a held row lock (the second waits on `pg_stat_activity` until the first commits), plus the takeover variant and a different-purchase control |
| C-671-1 a never-started trial read `ended` | `trial-view.ts`: not in a trial and no `trial_ends_at` reads `none` | `1efac91e` | fix-round-6 spec: pending reservation and expired/failed attempt read `none`; control: started and over still reads `ended` |
| C-671-2 T1 modules untested in T1; no live-DB race test for the ledger | the two suites above; the live suite adds the reservation race (two concurrent `reserve` calls for one client and coach leave exactly one reserved row); `.github/workflows/ci.yml` adds the live suite to `mwb-3-live-tests` (same gate and bootstrap) | `af0f8a81`, `1efac91e` | live `C-671-2` case (coverage: green before and after, no behaviour defect behind it) |
| C-671-3 zero-decimal currencies printed wrong (JPY 4900 as 49) | `trial-copy.ts` `formatTrialAmount` divides by the currency's own minor unit (Intl), unknown codes keep the code | `1efac91e` | JPY and KRW unscaled; USD and GBP unchanged; unknown code printed with its code |
| C-672-5 (schema and copy part; operator ruling "plus any tax") | `trial-copy.ts` `chargeLabel` and `taxMayApply` input: "Your card will be charged $49 plus any tax then. Cancel anytime before." only when tax may apply, exact old line otherwise; `PackageTrialNotice.tax_may_apply` (default false); notice `skipped` status allowed on push and email (used by #672 B-672-2) | `1efac91e` | tax line red before; control keeps the exact line and no-charge lines never mention tax |

Notes:
- Migration `20270313000000_package_trial_truth` (unapplied, never deployed; first lands with this stack) is edited in place with its `down.sql`, not a new timestamp: `tax_may_apply BOOLEAN NOT NULL DEFAULT false`, push/email CHECK constraints accept `skipped`; down maps `skipped` to `failed` before restoring the old CHECKs.
- Logs: unchanged shape, ids and closed codes only. Copy: no first person, no exclamation marks.
- Size: #671 is 2,291 changed lines against main (under 3,000).
- Out of this piece (operator items): the composition with recurring #680's own one-trial check lands later in #673 (C-656-1, still carried, not a blocker); #671 is BEHIND main (operator update-branch).

Restacked: #672 @ 4fa2fe4a merges this head; #673 @ 9719cb88 merges #672 (merge-only).
