# B-DUNR2-120 report (builder, Claude Opus 5.5, T4) — agent 120

Job: dunning FIX ROUND: #687 (B-687-8 copy) + #705 (Sol B-705-1..5, Opus B-705-1..4) with operator rulings, then merge-only
restack #688 -> #704 -> #705. Entry: ops/lanes120/JOBS120.md "B-DUNR2-120".

Started 11:05 PDT 10-05. Lock `dunning` taken 11:05:58 PDT (ops/lanes120/locks/dunning).

## Starting heads (GitHub REST 11:06 PDT)
| Piece | PR | Head | Size |
|---|---|---|---|
| D1 | #687 | f3c7fd37777ef1cde75ec5fb984edf5cb973f864 | +2424/-216 = 2,640 (grandfathered 3,000) |
| D2a | #688 | 21714f7bba299336cf71df0c87288c798fd5da13 | +2249/-535 = 2,784 (grandfathered 3,000) |
| D2b | #704 | 49d0b66e8a0a1cab02f0a5a03d48cad276a08e20 | +615/-79 = 694 (1,500 rule) |
| D2c | #705 | 5138947cd082328b81cbeb787833914431b22fc1 | +1029/-380 = 1,409 (1,500 rule; 91 headroom) |

## Rulings applied (JOBS120 entry, operator, Opus defaults)
- B-705-3: a lost closure leaves a coach-restarted plan's access unchanged (money reversal + OR-111-1 notice still run).
- B-705-2: re-buying allowed; restart refuses when another live plan exists for that package.
- Pause check runs regardless of FEATURE_DUNNING_V2.
- If #705 would pass 1,500: restart fixes go to a new D2d PR on #705 (fixes only; decision 7 its own later piece).

## Log
- 11:05 rules read (_COMMON_120/119/118/116, AGENT_RULES), entry, reports AUD-SOL-D6-120, AUD-OPUS-D6-120, B-DUNMR-120,
  DECISION_LOG 10-05 rulings. Lock taken. Verdict comments saved under ops/reports/B-DUNR2-120-evidence/.
- 11:08 worktrees wt/B-DUNR2-120-687 (f3c7fd37), wt/B-DUNR2-120-705 (5138947c).

- 11:20 #687: 940dd093 (failing-before tests) + d86b31a6 (copy fix) pushed; head d86b31a67e1d89352c3e92dde674cb4d45a25a1a,
  size +2458/-216 = 2,674. Failing-before lane ci/B-DUNR2-120-1 run 37354020156 (at 940dd093).
- 11:16 failing-before lane 37354020156 at 940dd093: 13 failed / 59 passed (exactly the new + updated copy assertions).
- 11:18 merge-only restack: #688 2662d01a82c267f00af27566e3984d58fb0996d1 (tree == merge-tree 21714f7b+d86b31a6),
  #704 764af2e1df66612c503427016f83c3d1776cfdc0 (tree == merge-tree 49d0b66e+2662d01a), pushed.
- 11:21 #705: 7b1d33b3 merge of 764af2e1 (clean, tree == merge-tree), 0f445691 test + 2a03d7dd fix (B-705-4 Opus / B-705-1 Sol:
  marker read ignores the flag), pushed; head 2a03d7dd1d39e2553df10f4d7e10ecdb025807aa, size 1,425. Failing-before lane
  ci/B-DUNR2-120-2 run 37355304885 (at 0f445691).
- Next: D2d (new PR on #705) for the remaining B fixes (Sol B-705-2..5, Opus B-705-1..3): plan below.

## D2d plan
- Serialize every Stripe pause/resume per purchase on the existing ClientBillingLease (CAS claim, fence +1, 120 s) - the same
  lease D3 card pay / cancel take. Keys carry the fence: a fresh key per attempt, stable within one attempt.
- New migration 20270318000000_dunning_dispute_pause_effects: DunningState.billing_paused_at (confirmed Stripe pause) and
  DunningDisputeObligation.restarted_at (coach restart covered this dispute). Additive, nullable, down.sql.
- Pause: DB first (as now) -> lease -> re-check still paused -> Stripe pause -> fenced tx sets billing_paused_at -> release.
  Busy lease -> throws (redelivery) and the sweep reconciler re-pauses rows with billing_paused_at null.
- Restart: pre-checks + other live plan for the package (B-705-2 Opus) -> lease (busy -> billing_busy) -> clear billing_paused_at
  -> resume -> fenced tx restores status from the resumed subscription (B-705-5) + obligations restarted_at -> finally: if the DB
  is still paused, re-pause with its own key (B-705-1 Opus a/b/c, Sol B-705-2) -> release.
- Read model: billing_paused only when billing_paused_at is set (Sol B-705-4).
- Lost closure of a coach-restarted plan: money reversal runs, access and status unchanged (B-705-3 Opus ruling).

- 11:29 operator mail: credits nearly spent, finish fast. D2d not started on remote (local migration draft discarded); stopped.
- Lane 37355304885 at 0f445691: 2 failed / 34 passed (new flag-rollback cases). PR CI green at d86b31a6, 2662d01a, 764af2e1, 2a03d7dd.
- Comments: #687 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-6000627026 (READY),
  #688 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-6000627374 (READY),
  #704 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/704#issuecomment-6000627664 (READY),
  #705 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/705#issuecomment-6000627915 (IN PROGRESS). PR bodies: Fix round table appended.

## Follow-ups (C)
- Sol C-687-8 src/checkout/dunning-v2/dunning-v2.copy.ts:59-78,104-108,134-144: payment push copy asserts attempts / first person; rule: state only what is known.
- Sol C-687-9 dunning-v2.copy.ts:209-211: LR_LOCKOUT_SCREEN aliases the card lockout; rule: dispute screen copy of its own.
- Sol C-687-10 dunning-v2.dispatcher.ts:310: dispute CTA routes to tgp://billing/update; rule: no card CTA on a dispute pause.
- Opus C-687-4: migration ordering note. C-688-9 lock order (webhook ClientPurchase then DunningState). C-688-12 land as one.
- C-705-1 test/dunning-v2-dispute-pause.spec.ts:342 empty catch; rule: assert the rejection.
- C-705-5 invoices marked uncollectible stay so after restart; C-705-6 sweep reconciler for unconfirmed pauses (planned in D2d).
- New: subscription-checkout.service.ts:513-522 counts a dispute-paused plan with status 'active' as live, so re-buy is refused; rule: exclude dispute-paused plans (ruling says re-buy is allowed).
- New: refund-dispute-handler.service.ts ~1093-1104 'disputed' mirror after a coach restart (out-of-order dispute.created) ends access while billing runs; rule: skip when the obligation has restarted_at (D2d).
- Mobile: render billing-is-paused copy only when billing_paused is true. C-DUNMR-2..5 carried.

## Decisions for operator (recommended default first)
1. D2d carries all non-flag #705 fixes (pause effects and restart), not only restart fixes, since #705 has 75 lines headroom. Default: yes.
2. Additive migration 20270318000000_dunning_dispute_pause_effects (DunningState.billing_paused_at, DunningDisputeObligation.restarted_at). Default: yes.
3. A restart while a pause's Stripe step is in flight returns coded billing_busy (serialized on ClientBillingLease, shared with D3). Default: yes.
4. Sweep re-pause of unconfirmed pauses stays flag-gated like other writes. Default: yes.

## HANDOFF
- In progress. Next: B-687-8 copy fix on #687; read #705 pause/restart code.
- State at 2026-10-05 11:31:01 PDT: #687 d86b31a67e1d89352c3e92dde674cb4d45a25a1a READY (0/0 B open); #688 2662d01a82c267f00af27566e3984d58fb0996d1 and
  #704 764af2e1df66612c503427016f83c3d1776cfdc0 restacked READY; #705 2a03d7dd1d39e2553df10f4d7e10ecdb025807aa 1,425 lines, IN PROGRESS:
  B-705-4 Opus / B-705-1 Sol fixed; open: Sol B-705-2..5, Opus B-705-1..3.
- Next job: build D2d per "## D2d plan" (new branch from 2a03d7dd, base agent119/dunning-split-2c-dispute-pause), failing-before lane
  per finding, replay all D6 probes (adapt Sol in-flight pause probe to billing_busy, Opus B-705-3 probe to the ruling), then B-DUNB-120.
- Worktrees removed; ci/B-DUNR2-120-1 and -2 deleted; lock released; notify written.

