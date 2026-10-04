# AUD-OPUS-CM-118 — Claude Opus 5.5 lens, coach Money M1 #674 + M3 #676 (agent 118 wave)

- Started Sun Oct 4 10:31 PDT 2026. Verdicts posted at 11:01 PDT. Closed at 11:03 PDT.
- Claims (left in place): lanes118/claims/backend-674-f9e21a87-opus and backend-676-ccd60bbc-opus.
- Notes: ops/aud-118/AUD-OPUS-CM-118/. It holds the comment bodies c<id>.md, the delta diffs, all probe specs, the lane logs, the verdict bodies verdict-674.md and verdict-676.md, and Sol's verdicts sol118-<id>.md (read only after drafting).

## Verdicts (posted; heads and checks re-read immediately before posting at 11:01 PDT)
| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| #674 (M1) | f9e21a87bf47502458a6ae21c2393010a1279198 | REQUEST CHANGES | 0/2/6 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/674#issuecomment-5982843273 |
| #676 (M3) | ccd60bbcb6b724534cfc69547c89a68c9af32901 | REQUEST CHANGES | 0/1/1 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/676#issuecomment-5982843389 |

- prstate at 11:02 PDT:
  - #674: opus=REQUEST_CHANGES, sol=REQUEST_CHANGES, required checks pass=11, BEHIND main (merge-tree clean, no file overlap).
  - #676: opus=REQUEST_CHANGES, sol=REQUEST_CHANGES, pass=10 and skipping=1 (deploy-readiness-gate), CLEAN. CodeQL, danger, banned casts and SBOM do not run on the stacked base.

## Evidence chain (G09)
- Opus history:
  - #641 APPROVE at fb29fb9e.
  - The 116 full audit: M1 at 9a512028 (RC 0/4/5) and M3 at 564f33bf (RC 0/2/1).
  - The 117 delta audits: to d9327546 (RC 0/1/5, 5976743131) and to cf5ef18b (RC 0/2/0, 5976743259).
- This round read every line of the FR2+FR3 delta:
  - #674: merge-tree(b644198b, d9327546)=a66e54b5 against f9e21a87, 14 files.
  - #676: cf5ef18b..ccd60bbc on the M3 files.
  - The ccd60bbc tree equals merge-tree(fbd6402c, f9e21a87), so the restack is merge-only.
- The builder's FIX ROUND 3 claims (5982570833, 5982571192) were verified against the code and the lanes. The B-CM4-118 report claims are consistent with what was found.

## Probe runs (CI lane; branches deleted after the runs)
| Run | Branch, commit | Result |
|---|---|---|
| [37221612173](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221612173) | 674-probes, a1d3c68f on f9e21a87 | 30 pass, 2 red as predicted |
| [37221623024](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221623024) | 676-probes, 914603c3 on ccd60bbc | 16 pass, 2 red as predicted |
| [37222417496](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37222417496) | 674-send, 12e32313 on f9e21a87 | 25 pass, 2 red (B-674-13, B-674-14) |

- **Run 37221612173:**
  - The Opus 117 B-674-5 probe is green. Opus 116's mirror is 5/6; the red `mirror_before_reconcile` is by design and was accepted before.
  - C-674-12 is red, and its control is green.
  - The PR specs dispute-transfer-reversal-once and refund-reversal-once are green.
- **Run 37221623024:**
  - The Opus 117 B-676-3a/b/c and churn probes are green, and so is Opus 116 window-cents.
  - The composed C-674-12 race control is green (one client_refunded row, ledger-exact totals). The composed C-674-12 case is red.
  - B-676-5 (MRR) is red: 9800/2 instead of 4900/1.
- **Run 37222417496:**
  - B-674-13: Stripe 244 against local 122, and the row is not moved to review.
  - B-674-14: Stripe 490 against local 245, after a `has_more: true` empty page.
  - Both controls are green.
- Logs: lane-674-37221612173.log, lane-676-37221623024.log and lane-674-send-37222417496.clean.log.

## Decisions
- **Closed at these heads:**
  - B-674-5 (dispute-scoped key, stamped amount, Stripe-first retry, record claim, unattributed alert).
  - C-674-10.
  - B-676-3 (event-time writer, event-id rows, occurrence seeding).
  - B-676-4 (BILLED_WHERE churn and heldIds).
  - Sol's B-674-11 and B-674-12 were checked from source as sound. That is not a copy of Sol's closure.
- **Independence:** both verdicts were drafted as APPROVE before Sol's RCs (5982716289, 5982716659) were read. After reading them:
  - B-674-13 and B-674-14 were derived again from source and proved by this lens's own probe (run 37222417496). They were adopted under Sol's ids.
  - This lens's own C-676-4 (MRR counting a never-billed trial whose first invoice failed) is the same defect as Sol's B-676-5. It was raised to B to stay consistent with this lens's 117 B-676-4 (same ruling 10-03, same reachability only once trials exist). The id is shared.
  - C-676-3 (BILLED_WHERE not exported) is folded into the B-676-5 fix rule.

## Follow-ups (C)
- **C-674-12 (new):** refund-dispute-handler.service.ts:568-574.
  - Problem: the head-coach posting is dated at record time when the delivery that did not claim the ledger wins the record. Money stays exact.
  - Fix: date it at the refund's posted_at for any attempt admitted in the first-success pass, and at record time only for a retry after a failed or unanswered attempt.
- **C-674-6:** :952 and :1054. A reconcile provider outage gives a generic 500. Fix: a closed 502/503 that says the reconcile can be retried.
- **C-674-7:** refund-reversal-admin.controller.ts:51-74. No acting owner is recorded. Fix: persist req.user.id with the outcome.
- **C-674-8:** :517 and :531. The refund status can move backwards. Fix: never move a terminal status back, and make succeeded -> failed an explicit path.
- **C-674-9:** :597-601. A pending head-coach transfer is treated as nothing_owed. Fix: keep it owed while a pending transfer exists.
- **C-674-11:** :519-522. A stale reason, note or initiated_by is written back. Fix: write undefined for absent fields.
- **C-676-6:** coach-money.service.ts:1187 and :1352. A lost dispute with null closed_at is dated at updated_at. Fix: stamp the first lost status, or backfill closed_at.
- **Carried release conditions:** C-641-2 / C-676-1 (integrated fee, per-renewal, recovery and dunning-v2 acceptance) and C-641 float share arithmetic (main code).

## Operator decisions
1. **Fix scope for #674.** Recommended default: the builder fixes B-674-13 (a fresh clock read at send) and B-674-14 (fail closed on an incomplete list) in M1, keeps the size under 3,000, then restacks #676 and #677. Fresh dual verdicts follow.
2. **B-676-5 in M3, or deferred to #680 (trials composition).** Recommended default: fix it in M3 now, so that the predicate the C-673-3 integration needs is exported. The alternative is to accept it as composition-only and track it with C-673-3; this lens does not recommend that.
3. **C list under the freeze.** Recommended default: queue C-674-12 and C-676-6 for after the freeze. They are cheap but not money-changing.

## HANDOFF
- Status: DONE.
  - Both verdicts are posted at the current heads.
  - The audit/AUD-OPUS-CM-118/* branches are deleted (0 remain).
  - Both worktrees are removed (`git worktree remove --force`, pruned).
  - Claims are left in place.
- Next Opus lens on these PRs: start from the new heads after the builder's fix round.
  - Reuse this file's evidence chain; everything closed stays closed if its code is unchanged.
  - Re-run ops/aud-118/AUD-OPUS-CM-118/audit-opus-cm-118-674-send.spec.ts: its B-674-13 and B-674-14 cases must go green unchanged.
  - Re-run audit-opus-cm-118-676.spec.ts: its C-676-4 case is B-676-5 and must go green. The composed C-674-12 case stays red unless C-674-12 is taken.
