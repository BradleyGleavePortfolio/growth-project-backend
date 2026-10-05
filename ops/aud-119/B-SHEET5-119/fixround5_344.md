FIX ROUND 5 (B-SHEET5-119, agent 119) — growth-project-mobile#344 @ bc4387ac9f1a35d8ad6746d8ece3cda75fe89ab4

Closes Opus B-344-7 and Sol B-344-2 / B-344-3 (residuals) from the verdicts at `7e17d142` (Opus 0/1/9 issuecomment-5984450917, Sol 0/2/3 issuecomment-5984430303). #342 `e3226f3b` and #343 `691e0cf0` untouched (dual APPROVE, frozen); no merge in this round.

Size: +2,711 / -247 = 2,958 changed lines (tests included; this round +109 / -17). Grandfathered PR, under its 3,000 ceiling (42 lines left).

## Findings -> change -> commit -> test
| Finding | Change | Commit | Test |
|---|---|---|---|
| Opus B-344-7 (trial told it was paid for; "Your plan is ended" while access continues) | `planActions.ts` `PLAN_ACTION_COPY.outcome(o, trial)`: a trial whose scheduled end is on or before its trial end reads "Your free trial ends on <date>, and nothing is charged."; any other scheduled end reads "Your plan will not renew. Access continues until <date>, and nothing more is charged." `paidPeriodKept`, `ended`, `already_ended` wording unchanged. `YourPlansPanel.tsx` `endsInTrial(plan, outcome)` uses the plan as it was when End my plan was pressed; a trial that converted meanwhile (period end after the trial end, so a charge happened) gets the paid wording. No-date consent says "the end of the current period" (no paid claim for a trial). | `bc4387a` | recovery.test `scheduled end 0/1/2` (trial, converted trial, paid; exact lines); Opus P1 |
| Sol B-344-2 residual (End my plan from a stale card promises period-end access) + Opus C-344-13 (webhook order) | No stale action without a verified read: when the last list read failed (or the route is missing) End my plan opens "Refresh your plans first" / "The latest details of this plan could not load, so it is not confirmed what ending it would do. Refresh your plans before choosing End my plan." with Keep plan / Refresh plans (reloads); no destructive button, nothing is sent. Race-safe consent on a confirmed card: active/trialing consent adds "If a payment is overdue, ending it ends access now instead and cancels the unpaid charge." (the server runs 2A on `isDelinquent`, including a dunning cycle that lands before subscription.updated). past_due consent unchanged. | `bc4387a` | recovery.test `End my plan on a card whose refresh failed sends nothing and offers a refresh` (no POST, refresh, then the race-safe consent); ClientPackagesScreen.purchase pin; Sol `a stale active card warns ...` |
| Sol B-344-3 residual (old receipt overrides a newer authoritative read) | Receipts are structured: `{ result: CancelOutcome, trial, gen }` with the generation the cancel answer was published at. Each successful read newer than the receipt reconciles it: a `scheduled` receipt stands only while the plan is `cancelAtPeriodEnd` and not ended; `ended` / `already_ended` only while the plan is ended. Contradicted receipts are dropped, so the card shows the current plan (next charge, End my plan). Receipts survive failed reads (stale banner shown). The line is rendered from the structured receipt; generation fence, canonical resume view and voided-amount outcomes unchanged. | `bc4387a` | recovery.test `a newer read showing the plan renewing again replaces the old cancel receipt`; Sol `a newer successful retry read supersedes ...` |

## Failing before / passing after (CI lane)
- Before (`7e17d142` + tests `1836f7d`, no fix): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37235851899 — 9 failed / 124: the 5 new recovery tests, Opus P1, Sol `a newer successful retry read ...` and `a stale active card warns ...`, the ClientPackagesScreen consent pin.
- After (`bc4387a`, 27 suites: every package/plans suite plus every lens probe below): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37235878848 — 451 / 457. Every red test is listed below with its reason.

## Probe replay (both lenses, every prior probe), at this tree
| Probe | Result |
|---|---|
| Sol AUD-SOL-S123-119 planAuthority (4) | pass 4/4 (both B counterexamples now green, both controls green unchanged) |
| Sol planRecovery (replayed S123), openPlanAction-current, nativeRejection-replayed | pass |
| Opus AUD-OPUS-S123-119 plans344 P1 | pass ("Your free trial ends on November 2, 2026, and nothing is charged.") |
| Opus plans344 P2 (evidence), P3 copy rules, P4 JPY, P5 Keep my plan | pass |
| Opus plans344 P6 (evidence pin of the old "Your plan is ended. Access continues until" line) | red by design: the line Opus named in B-344-7 ("fixed on the same lines"); now "Your plan will not renew. Access continues until November 2, 2026, and nothing more is charged." |
| Opus SH3-118 replay control "an active plan keeps the period-end confirmation" (exact string) | red, superseded by Sol B-344-2: the consent still starts with the exact pinned sentence and adds the overdue clause; the other SH3-118 cases pass |
| Opus S123 probe342, probe343 | pass except Q5 INFO (C-343-8, red by design, unchanged) |
| Prior probes P12117 / Sh118 (both lenses, B-SHEET4 copies) | pass except the same 3 as at `7e17d142`: Opus C-342-1 isCombo (held C) and two Sol Sh118 openPlanAction copy pins superseded by Sol B-342-1 |

## Money list self-check
- Webhook order and redelivery: consent is true whether subscription.updated or invoice.payment_failed lands first (overdue clause); a receipt is reconciled against the next authoritative read, never trusted over it.
- Concurrency: one action at a time (busy ref); generation fence drops reads older than an action answer; receipt `gen` ties it to the answer it came from; another session's Keep my plan is reflected on the next read.
- Terminal states: ended / already_ended receipts stand only while the plan reads ended; a stale card cannot send End my plan; dispute-paused plans still have no End/Keep action (`can_cancel` false; C-344-12 land gate unchanged).
- List pagination and completeness: a failed read keeps the stale banner and blocks End my plan; a receipt is dropped only on a successful read that contradicts it; a plan missing from a successful read drops its receipt (nothing rendered for it).
- Currency: no amount wording changed; voided amounts keep `money()` (P4 JPY whole yen passes).
- Copy truth: no paid or charged claim for a trial; no "ended" claim while access continues; no period-end promise when the server may end access now; no first person, emojis or exclamation marks (P3 passes over every string).

## Follow-ups (C), not folded
C-344-12 (dispute-paused / Day-10 lock shows "Confirming", backend planView `locked` state, land gate), C-344-14 / Sol C-344-12 (noAnswer "could not reach" for timeouts), Sol C-344-13 (SUBSCRIPTION_SETUP_UNAVAILABLE guidance), Sol C-344-1 (native card-update composition), Opus C-344-5/6/8/9/10/11 unchanged. New C-SH5-1 `YourPlansPanel.tsx` stale banner and stale-card dialog: they offer Try again / Refresh plans only; Email support shows on the empty-list failure and on action failures, not when cards are shown over a failed read. Fix rule: add the support action to the stale banner when the failed read had a status.

Required check at this head: Typecheck, lint, test https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37236117451 pass. Analyze contexts run only on main-based PRs: final-main gate.

READY FOR AUDIT
