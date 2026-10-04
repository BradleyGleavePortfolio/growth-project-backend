FIX ROUND 6 (B-SHEET6-119, agent 119) — growth-project-mobile#344 @ 88659e21806ace4fc0c883d624de1abc07413b6d

Closes Sol B-344-3 residual from the verdict at `bc4387ac` (Sol REQUEST CHANGES 0/1/3, issuecomment-5984798322; Opus APPROVE 0/0/11, issuecomment-5984695452). One finding only; no C folded. #342 `e3226f3b` and #343 `691e0cf0` untouched (frozen); no merge in this round.

Size: +2,726 / -247 = 2,973 changed lines (tests included; this round +20 / -5 in 2 files). Grandfathered PR, under its 3,000 ceiling (27 lines left).

## Finding -> change -> commit -> test
| Finding | Change | Commit | Test |
|---|---|---|---|
| Sol B-344-3 residual (`agrees()` checked only the cancellation flag and non-ended state, so a newer successful read with a different access end, or a paid period where the receipt said free trial, kept the old receipt line) | `YourPlansPanel.tsx` `agrees()`: a `scheduled` receipt stands only while the newer successful read is `cancelAtPeriodEnd`, not ended, has the **same access-end instant** as the receipt (`sameInstant`, parsed, null only equals null), **and the same trial or paid kind** (`endsInTrial(current view, receipt) === receipt.trial`). Otherwise the receipt is dropped and the card renders the current view ("Ends on <date>. Nothing more is charged.", next charge, or trial line). Unchanged: receipts kept through failed reads (stale banner), `ended` / `already_ended` receipts with the voided amount while the plan reads ended, canonical resume view, generation fence (`r.gen >= mine`). | `88659e2` (tests `2420854`) | recovery.test `a newer read 0..5 keeps the cancel receipt only when its date and trial or paid kind agree`: rows 1 (paid, Dec 2), 2 (trial receipt, paid Dec 2 view), 3 (trial receipt, paid view, same Nov 2 date) must drop the receipt; rows 0 (renewing again), 4 (agreeing trial), 5 (agreeing paid) controls |

## Failing before / passing after (CI lane)
- Before (`bc4387ac` + tests `2420854` + probes, no fix): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37238293419 — 5 failed / 46: new rows 1, 2, 3 and Sol `delta-probes.test.tsx` "a newer successful read with a different access-end date ..." and "a newer paid-period view must not retain an old free-trial receipt" (Sol's exact probe, unmodified). Green before: new control rows 0, 4, 5; Sol's 5 other probes; Opus S3D delta probe 6/6.
- After (`88659e2` + every lens probe, 32 suites): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37238384052 — 522 / 529. Every red test is listed below with its reason.

## Probe replay (both lenses), at this tree
| Probe | Result |
|---|---|
| Sol AUD-SOL-S3D-119 `delta-probes.test.tsx` (7) | pass 7/7: both B-344-3 challenges now green; consent x2, stale-trial 503/404, agreeing-trial control green unchanged |
| Sol AUD-SOL-S123-119 planAuthority (4), planRecovery, openPlanAction-current, nativeRejection | pass |
| Opus AUD-OPUS-S3D-119 `delta344` D1-D5, D7, D8 | pass |
| Opus S3D D6 "converted trial gets the paid wording" | red by design: its fixture's newer successful read says `access_ends_at` Nov 2 (`SCHEDULED_VIEW('active')`) while the cancel answer said Dec 2, so under the B-344-3 rule the read owns the state and the card shows "Ends on November 2, 2026. Nothing more is charged." The intent of D6 still holds: with the newer read consistent with the answer (Dec 2), the receipt is kept and reads "Your plan will not renew. Access continues until December 2, 2026, and nothing more is charged." (D6b, ci-only variant, pass: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37238619376), and recovery.test `scheduled end 1` (converted trial over a failed read) passes. |
| Opus S123 plans344 P1-P5 | pass |
| Opus S123 plans344 P6 (evidence pin of the old "Your plan is ended" line) | red by design, unchanged since FIX ROUND 5 (B-344-7) |
| Opus SH3-118 replay exact consent pin | red, superseded by B-344-2 overdue clause, unchanged since FIX ROUND 5 |
| Opus S123 probe342, probe343 | pass except Q5 INFO (C-343-8 / Sol C-343-7, held lower-piece C), unchanged |
| Prior probes P12117 / Sh118 (both lenses) | pass except Opus C-342-1 isCombo (held C) and Sol Sh118 openPlanAction pins superseded by B-342-1, unchanged |

Red set at this tree = FIX ROUND 5's 6 + Opus D6 (fixture contradiction, above). No other test changed state.

## Money list self-check
- Webhook order and redelivery: a scheduled receipt that a later webhook-driven read contradicts (period end moved, trial converted, cancel undone) is dropped on the next successful read; a redelivered event producing the same view keeps it. The receipt never outranks a successful read.
- Concurrency: unchanged busy ref and generation fence; a read older than the receipt (`gen >= mine`) cannot drop or keep it by mistake; another session's Keep + End shows its own current period end.
- Terminal states: `ended` / `already_ended` receipts (voided amount) stand while the plan reads ended; ended or deleted plans missing from a successful read drop the receipt; dispute-paused plans unchanged (no End/Keep, C-344-12 land gate).
- List pagination and completeness: only a successful read reconciles; a failed or unavailable read keeps the receipt and the stale banner and blocks End my plan.
- Currency: no amount or currency logic touched.
- Copy truth: no free-trial or "nothing is charged" claim against a paid-period view; no access-end date other than the current view's after a successful read; no new strings.

## Follow-ups (C), not folded
Unchanged from FIX ROUND 5: C-344-12 (dispute-paused / Day-10 state), C-344-14 / Sol C-344-12 (noAnswer timeouts), Sol C-344-13 (SUBSCRIPTION_SETUP_UNAVAILABLE guidance), Sol C-344-1 (native card-update composition), C-SH5-1 (stale banner support action), Opus C-344-5/6/8/9/10/11/15/16/17.

Required check at this head: Typecheck, lint, test https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37238658638 pass. Analyze contexts run only on main-based PRs: final-main gate.

READY FOR AUDIT
