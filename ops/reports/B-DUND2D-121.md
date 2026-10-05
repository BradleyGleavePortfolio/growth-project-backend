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
- 13:2x operator mail: two lockout-guard fixes added (Opus L3 m#353). Guard lives on main and the stack does not change
  it; the waiver rule (hasOtherLiveAccess / effectiveLock) exists only in #687. So: waiver fix in D2d (#724), the
  /messages allow-list in a separate main PR (#725).
- 13:33 operator mail: A2 edge-case freeze. The four edge items (Opus B-705-1, Sol B-705-2/3/4) were already built and
  tested; listed in the #724 comment as "C (edge, deferred to 10k clients)", kept (default) pending operator confirm.
- Full local tsc OOMs at the heavy.sh heap cap (2.5 GB); used a narrow tsconfig (/tmp/d2d/tsconfig.json) over the
  changed files' dependency closure: clean. Full tsc is in lane run 37371522588 (.ci-lane-tsc).
- foundation-fixes B-687-2 test ("no later-sorting migration touches a table it creates") went red on the ruled
  20270318 migration (ALTER DunningDisputeObligation). Narrowed: STACK_ADDITIONS names it, plus a pin that it only adds
  nullable TIMESTAMP(3) columns.
- Commits #724: fd25e970 (tests), e77a8d36 (fix). Size 1,133. Pushed 13:4x; PR #724 opened, base #705.
- Commits #725: 3eec9ed7 (tests), 1dbc59b6 (fix). Size 117. PR #725 opened, base main @ 5da537d6.
- Local evidence logs: ops/aud-121/B-DUND2D-121/{failing-before-local.log, probe-replay-local.log,
  main-failing-before-local.log, main-after-fix-local.log}. Adapted probe copies: replay-*.ts (marked `D2d REPLAY:`).
- Lane ci/B-DUND2D-121-1 run 37371522588 (D2d head + probe commit + tsc, 16 specs) queued in the Actions incident.

## PRs and comments
- #724 D2d head e77a8d360f7a7ad02cf465b525eeed648a3a7825 — FIX ROUND 1 (OPENING) + READY FOR AUDIT (local evidence):
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/724#issuecomment-6002641347
- #725 main head 1dbc59b690119f03f010e406f9f1e0e43d1e6556 — FIX ROUND 1 (OPENING) + READY FOR AUDIT (local evidence):
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/725#issuecomment-6002647483
- #705 note (fixes continue in D2d): https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/705#issuecomment-6002647779

## Findings (A/B/C)
- A: 0. B fixed: 9 (Sol B-705-2..5, Opus B-705-1..3, lock waiver, B-353-10). Of these, by A2 (13:29 owner rule), four
  are C (edge, deferred to 10k clients) but already built: Opus B-705-1, Sol B-705-2, Sol B-705-3, Sol B-705-4.
- New C: C-D2D-1, C-D2D-2 (below).

## Operator decisions (recommended default)
1. Keep the four already-built edge fixes in #724 (default keep; stripping costs a round).
2. Concurrent pause meeting a dispute holder defers (no throw); a D3 holder (card pay / cancel) makes the pause throw
   for redelivery and the sweep re-asserts (default as built).
3. Restart writes status and access_expires_at from the resumed Stripe subscription (a past_due subscription stays
   past_due) (default as built).
4. Lost closure / redelivered opening after a restart: access and status unchanged, ledger reversal runs (ruled).
5. B-353-10 option (a) backend allow-list of the client's own coach thread (default, #725); (b) mobile leads with
   Email support instead.
6. foundation-fixes migration-order test narrowed for the ruled 20270318 addition (default accept).

## Follow-ups (C)
- C-D2D-1 src/checkout/subscription-checkout.service.ts:513-522: a dispute-paused plan whose status is still `active`
  (closure-first pause) counts as live, so checkout refuses the re-buy the ruling allows. Fix rule: exclude plans whose
  DunningState carries the dispute marker from the live check.
- C-D2D-2 (edge, deferred to 10k clients) src/checkout/refund-dispute-handler.service.ts upsertDispute: the
  restarted_at read happens before the mirror transaction (no lock), so a restart committing in between could still be
  mirrored `disputed`. Fix rule: guard the mirror's updateMany on the obligation in the same statement or take the
  purchase lock first.
- C-D2D-3 (edge, deferred to 10k clients) same-millisecond second pause reuses notice outbox ids (cycle key =
  entered_at), so the second cycle sends no notice set. Fix rule: key the outbox ids on the dunning state version.
- Carried: C-705-1 (empty catch in test/dunning-v2-dispute-pause.spec.ts:342), C-705-5 (uncollectible invoices stay
  so after restart; coach not told), C-687-8/9/10, C-688-9 (lock order), C-DUNMR-2..5. Decision 7 (full refund on a
  recurring plan pauses billing) stays its own later piece (B-DUNB-120).

## HANDOFF
- #724 (D2d, head e77a8d36) and #725 (main, head 1dbc59b6) are READY FOR AUDIT on local evidence. Next: lens pair
  audits #724 (replay ops/aud-121/B-DUND2D-121/replay-*.ts + the two B-DUNMR-120 probes) and #725 (route-table spec).
- CI: PR CI on both heads queued (runner incident) at hand-off (2026-10-05 13:51:29 PDT); next operator cites it when it finishes. Lane
  run 37371522588 cancelled at the 13:50 wrap-up order and ci/B-DUND2D-121-1 deleted (probe replay evidence is local:
  ops/aud-121/B-DUND2D-121/probe-replay-local.log; rerun in a lens lane if wanted).
- Open Bs: none known. Edge Cs (built, operator to confirm keep): Opus B-705-1, Sol B-705-2/3/4. Follow-up Cs:
  C-D2D-1 (re-buy refused for a closure-first paused plan; normal-use candidate for the next piece), C-D2D-2, C-D2D-3.
- Lock `dunning` released (2026-10-05 13:51:29 PDT). Worktrees wt/B-DUND2D-121-1/2/3 removed. Branches exist only as pushed PR heads.
- Not done: full-project tsc locally (OOM at the heavy.sh cap; narrow tsc clean); CI-backed failing-before (local only).
