# B-DUND2D-121 report (builder, Claude Opus 5.5, T4) — agent 121

Job: dunning D2d PR on #705 with the remaining #705 fixes (Sol B-705-2..5, Opus B-705-1..3), per
ops/lanes121/JOBS121.md "B-DUND2D-121" and the D2d plan in ops/reports/B-DUNR2-120.md.
Started 12:37 PDT 10-05. Lock `dunning` taken 12:38:35 PDT (ops/lanes121/locks/dunning).

## Starting heads (GitHub REST 12:39 PDT, all match the entry)
| Piece | PR | Head |
|---|---|---|
| D1 | #687 | d86b31a67e1d89352c3e92dde674cb4d45a25a1a (FR4 READY; mergeable_state behind main) |
| D2a | #688 | 2662d01a82c267f00af27566e3984d58fb0996d1 |
| D2b | #704 | 764af2e1df66612c503427016f83c3d1776cfdc0 |
| D2c | #705 | 2a03d7dd1d39e2553df10f4d7e10ecdb025807aa (1,425) |

## Design (as built)
- Every Stripe pause / resume of a dispute pause runs under the purchase's ClientBillingLease (CAS claim, fence +1,
  120 s), the lease D3 card pay / cancel take. Keys carry the fence: `dunning_v2:dispute_pause:<p>:<cycle>:<fence>`,
  `dunning_v2:dispute_restart:<p>:<cycle>:<fence>`.
- Pause: DB tx first (unchanged; sets billing_paused_at null) -> confirmDisputePause: lease -> re-read (still paused?)
  -> Stripe pause -> fenced tx stamps billing_paused_at -> release -> notices (once per cycle, outbox ids).
  Lease busy: holder `dispute_*` -> deferred (that holder re-reads under its lease); other holder -> throw
  DUNNING_PAUSE_BILLING_BUSY (redelivery) and the sweep re-asserts.
- Sweep (behind the flag): re-asserts paused cycles with billing_paused_at null (C-705-6).
- Restart: pre-checks (tenant, not_paused, plan_ended, other_live_plan) -> lease (busy -> billing_busy) -> pre-checks
  again -> clear billing_paused_at -> resume -> fenced tx (checkout advisory lock, DS, CP; new_dispute,
  other_live_plan, plan_ended, CAS) restores status + access_expires_at from the resumed subscription, stamps
  obligations restarted_at -> finally: any exit after the resume that leaves the plan paused re-pauses with its own
  key -> release -> confirm any pause recorded meanwhile.
- Read model: billing_paused = billing_paused_at != null.
- refund-dispute-handler: lost closure of a dispute the coach restarted over: money reversal runs, ledger_reversed
  set, status / access unchanged; the `disputed` mirror on dispute.created is skipped for such a dispute.
- Migration 20270318000000_dunning_dispute_pause_effects (two nullable columns, down.sql).

## Log
- 12:37-12:55 read _COMMON_121 (items 1-11), SOT A1/A6/A9.1/A9.2 B-DUNR2-120 + wrap-up, B-DUNR2-120, AUD-*-D6-120,
  both lens #705 verdicts and probes. Worktree wt/B-DUND2D-121-1 at 2a03d7dd, branch agent121/dunning-split-2d-restart-fixes.
- 12:55-13:15 built the fix + test/dunning-v2-d2d-restart.spec.ts.

## Follow-ups (C)
- C-D2D-1 src/checkout/subscription-checkout.service.ts:513-522: a dispute-paused plan whose status is still `active`
  (closure-first pause) counts as live, so checkout refuses the re-buy the ruling allows. Fix rule: exclude plans whose
  DunningState carries the dispute marker from the live check.
- C-D2D-2 src/checkout/refund-dispute-handler.service.ts upsertDispute: the restarted_at read happens before the mirror
  transaction (no lock), so a restart committing in between could still be mirrored `disputed`. Fix rule: guard the
  mirror's updateMany on the obligation in the same statement or take the purchase lock first.
- Carried: C-705-1 (empty catch in test/dunning-v2-dispute-pause.spec.ts:342), C-705-5 (uncollectible invoices stay
  so after restart; coach not told), C-687-8/9/10, C-688-9 (lock order), C-DUNMR-2..5. Decision 7 (full refund on a
  recurring plan pauses billing) stays its own later piece (B-DUNB-120).

## HANDOFF
- In progress. Code in wt/B-DUND2D-121-1 (not yet pushed at the time of this line).
