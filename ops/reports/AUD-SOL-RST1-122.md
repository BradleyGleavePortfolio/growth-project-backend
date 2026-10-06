# AUD-SOL-RST1-122 — agent 122

## Status

Independent Sol first review complete and posted. Start: 2026-10-05 17:21:35 PDT; completion: 17:24:26 PDT; deadline: 17:41:35 PDT.

Target: growth-project-mobile#380 at `b49d714777b6eaf2df12b200abbf2fc3eb78a1d5`; 549 additions, no deletions, four files ([mobile #380](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/380)).

Scope: coach Restart plan visibility and ownership, confirmation, server refusal copy, success refresh, backend restart contract. Repository checkouts remain read-only. No Opus notes, report, or comments read.

## Verdict

AUDIT GPT-6.1 Sol — growth-project-mobile#380 @ b49d714777b6eaf2df12b200abbf2fc3eb78a1d5 — VERDICT: APPROVE

A/B/C = 0/0/1. Bs: none.

Posted after immediate exact-head verification: [Sol audit comment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/380#issuecomment-6006408046).

## Evidence and review coverage

- Full four-file diff read; saved at `ops/aud-122/AUD-SOL-RST1-122/mobile380.diff`.
- Candidate detection requires the routed client's ID, recurring billing, access off, and a non-ended purchase, followed by an active `charge_disputed` dunning row with `entered_at`; roster and drill-down field names match the backend responses ([coachDisputeRestart.ts:65–115](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/b49d714777b6eaf2df12b200abbf2fc3eb78a1d5/src%2Fentitlements%2Fdunning%2FcoachDisputeRestart.ts), [backend #687](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687)).
- Confirmation is mandatory, Cancel issues no POST, busy disables the restart controls, and a successful server acknowledgement updates the card and hides its button ([DisputePausedPlansCard.tsx:52–114](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/b49d714777b6eaf2df12b200abbf2fc3eb78a1d5/src%2Fcomponents%2Fcoach%2FDisputePausedPlansCard.tsx)).
- Pull-to-refresh re-reads the card through `planReloadKey`; the surrounding client summary has no purchase/dunning state to invalidate, so the successful local state update is sufficient for this screen ([ClientDetailScreen.tsx:251–256,445–450](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/b49d714777b6eaf2df12b200abbf2fc3eb78a1d5/src%2Fscreens%2Fcoach%2FClientDetailScreen.tsx)).
- Known backend refusals map to specific copy and final/temporary states; a missing answer reports an unknown result rather than asserting that the restart failed or succeeded ([coachDisputeRestart.ts:121–195](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/b49d714777b6eaf2df12b200abbf2fc3eb78a1d5/src%2Fentitlements%2Fdunning%2FcoachDisputeRestart.ts)).
- Backend reference fetched from pull/687/head: `2f11f14bb8c361d72dc0f5db8e0725801a83b821`; route controller is mounted in `DunningV2Module`, requires JWT plus coach/owner role, derives the coach ID from the authenticated user, and checks purchase ownership before billing changes ([backend #687](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687)).
- Backend files read: `checkout.controller.ts:303–328`, `checkout.service.ts:934–951`, `coach-payments.select.ts:17–98`, `payment-ops.controller.ts:703–753`, `dunning-restart.controller.ts:1–94`, `dunning-v2.module.ts:31–58`, `dunning-v2.service.ts:1505–1684`, and `http-exception.filter.ts:55–108` ([backend #687](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687)).
- New tests cover visibility, confirmation/Cancel, all seven coded refusals, final/temporary outcomes and unknown network results ([coachDisputeRestart.test.tsx](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/b49d714777b6eaf2df12b200abbf2fc3eb78a1d5/src%2Fentitlements%2Fdunning%2F__tests__%2FcoachDisputeRestart.test.tsx)).
- PR check “Typecheck, lint, test”: completed, success at the reviewed head ([PR CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37392943563/job/112042068552)).
- Builder CI lane: completed, success; local comparison of lane head `041390101243ea78673611b11ad81cb7139edbca` against the reviewed head adds only `.ci-lane-specs`, `.ci-lane-tsc`, and `.github/workflows/ci-lane.yml` ([CI lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37392952996)).

No previous lens evidence reused. No local npm/jest/tsc/eslint/builds run. No probes, pushes, merges, production reads, or deployments. No worktree created.

## C findings

C-380-1 — C (edge, deferred to 10k clients): roster discovery stops after 500 purchases per coach; no fix now ([coachDisputeRestart.ts:27–28,89–98](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/b49d714777b6eaf2df12b200abbf2fc3eb78a1d5/src%2Fentitlements%2Fdunning%2FcoachDisputeRestart.ts)).

## Operator gates

This is stacked on m#354, so required main-only checks must be green after retargeting; the backend route must be available before dispute-paused plans are enabled ([mobile #380](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/380), [backend #687](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687)).

Recommended default: keep the accepted coach-client-detail placement. No B fix round needed.

## HANDOFF

Done at 17:24:26 PDT. One APPROVE posted at the unchanged exact head; A/B/C = 0/0/1, no Bs ([Sol audit comment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/380#issuecomment-6006408046)).

Evidence: `ops/aud-122/AUD-SOL-RST1-122/mobile380.diff`; posted payload: `ops/aud-122/AUD-SOL-RST1-122/verdict-comment.md`.

Operator: apply the stack/main-only-check and backend availability gates above, then use this verdict at this exact head. C-380-1 needs no launch fix. No repo edits, worktree, probe branch, or active CI lane to clean up. Claim marker retained as the audit ownership record; no locks held.
