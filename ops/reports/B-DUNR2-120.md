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

## HANDOFF
- In progress. Next: B-687-8 copy fix on #687; read #705 pause/restart code.
