# AUD-OPUS-CM8-120 — Claude Opus 5.5 lens, coach stack #674/#676/#677/#703 at FIX ROUND 5 heads (agent 120)

- Started 10:29 PDT 10-05. Verdicts posted 10:54 PDT.
- Claims: lanes120/claims/backend-{674-e35c37a1,676-0ee4933d,677-b17888ab,703-88940c3f}-opus (left in place).
- Notes, probe, lane logs and verdict bodies: ops/aud-120/AUD-OPUS-CM8-120/.
- Independence: the Sol lens report and the bodies of Sol's comments were not read. Only the first lines of comments were listed, to find this lens's prior verdict heads.

## Verdicts (heads re-read at 10:54 PDT, unchanged; all draft, mergeable)

| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| #674 | e35c37a1db1da2949c366f681633b1b1f72a11b3 | REQUEST CHANGES | 0/1/7 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/674#issuecomment-6000051266 |
| #676 | 0ee4933d0f227991bde5e41c0a770b4887ec1957 | APPROVE | 0/0/2 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/676#issuecomment-6000051724 |
| #677 | b17888ab6eaa018a49d42a40eb2b773b89198d28 | APPROVE | 0/0/2 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/677#issuecomment-6000052146 |
| #703 | 88940c3f5a0843a5979d1ac3196049e0be516141 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/703#issuecomment-6000052530 |

PR CI at all four heads is green, including the mwb-3-live-tests step "refund reversal concurrency live spec" in run 37343105712.

## Lens lanes (deleted after use)
- **Lane A, #674 alone:** https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37350431169
  - Branch audit/AUD-OPUS-CM8-120/674-probes-1; probe commit b38c1337 on e35c37a1.
  - Result: 17 suites, 152/157.
  - Reds:
    - The new B-674-15 probe: 2 red, control green.
    - audit-cm1-674-reversal-mirror: 2 cases. Obsolete writer / observe-only by design.
    - Original 118 B-674-14 case: its precondition is no longer reachable. The adapted twin is green.
- **Lane B, stack top:** https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37350491962
  - Branch audit/AUD-OPUS-CM8-120/703-probes-1; probe commit b4182bf7 on 88940c3f.
  - Result: 23 suites, 181/187.
  - Reds:
    - The B-674-15 probe again: 2 red.
    - The original 117/118 #676 probes: no op table in their private store. The adapted twins, with assertions unchanged, are green.

## Findings
**B-674-15** (#674): src/checkout/refund-dispute-handler.service.ts:1340-1348 runs before the refund's own-operation loop at :1360-1375.
- **Problem:** a refund in review whose own operation was completed by another driver is closed as nothing_owed when the transfer ended full. The other driver is either the settlement sweep (resolveStuckReversals, charge-settlement.service.ts:1048-1078) or a sibling refund's reverse().
- **Effect:** the refund gets no bound Stripe id and no SplitLedgerReversal posting, and the owner is told 0 cents. Coach Money then overstates the head coach's kept earnings.
- **Proof:** probe test/audit-opus-cm8-120-674-reconcile.spec.ts. Full refund: `nothing_owed`/0/[] where `recorded_from_stripe`/245/[245] is expected. Sibling fill: `nothing_owed`/0/a=[] where 122/a=[122] is expected. Control green.
- **Fix rule:** run the own-operation loop before computing owed. This is a reorder, so #674 stays under 3,000. The regression spec goes in #703.

Closed at these heads:
- B-674-13 and B-674-14.
- B-CM6-1 and B-CM7-1.
- C-674-12.
- B-676-5 (this lens's 118 B).

Probe substitution: accepted. The B-641-12 mirror and the Sol-116 two-refund probe drive writers that no longer exist. The live Postgres spec, the slot-base and found-slot specs, and boundaries B-674-1 (now driven by a real concurrent reverse()) prove the same property.

## Follow-ups (C)
- C-674-16 :1362-1375, :1455-1462, :1478-1488. A `-review` operation refused once is sticky (422 forever), and the REFUSED copy gives no working next action.
- C-674-17: the runbook has no rows for UNCERTAIN, REFUSED, LIST_INCOMPLETE, TOO_MANY or TRANSFER_NOT_IN_STRIPE. It and the comment at :1302 still name metadata tgp_charge_refund_id; new reversals carry tgp_reversal_op.
- C-674-6 (narrowed) :1568. A listTransferReversals provider error is a generic 500 in reconcile.
- C-674-7: admin controller :38-74 records no acting owner.
- C-674-9 :1052-1056. A pending transfer reads as nothing_owed.
- C-674-13 :78/:858. The 60 s first-pass heuristic.
- C-641 :1062. Float share (release condition).
- C-676-6 coach-money.service.ts:1187/:1325/:1352. A lost dispute with a null closed_at is dated at updated_at.
- C-641-2 / C-676-1: release condition (integrated fee, renewal, recovery and dunning-v2 acceptance).
- C-677-3 refund-reversal-reconcile.spec.ts:151-154. The metadata check went from toEqual to toMatchObject.
- C-677-2 (Sol, carried): reversal-postings assertion hardening.

## Operator decisions (recommended default first)
1. **B-674-15:** fix in #674 now. Move the own-operation loop above `owedHeadCoachReversal` in reconcileTransferReversal; the size stays under 3,000. Add this lens's probe as the regression in #703, then restack #676 -> #677 -> #703. A delta Opus verdict follows: deep on the #674 handler hunk, byte-identity checks on the rest.
2. **C-674-16 / C-674-17:** queue them after the FREEZE (copy and runbook). The alternative is to take the runbook rows in the same round, as docs only, if the operator wants owner copy complete before launch.

## HANDOFF
- Done:
  - 4 verdicts posted; bodies in ops/aud-120/AUD-OPUS-CM8-120/verdict-{674,676,677,703}.md.
  - Lane branches audit/AUD-OPUS-CM8-120/{674-probes-1,703-probes-1} deleted (0 remaining).
  - Worktrees wt/AUD-OPUS-CM8-120-{1,2} removed and pruned.
  - Claims left in place.
- The stack is blocked only by B-674-15. #676, #677 and #703 are approved at these heads. A restack after the #674 fix needs a delta verdict: their own content must be byte-identical, and #703 gains the regression spec.
- Probe for the builder: ops/aud-120/AUD-OPUS-CM8-120/audit-opus-cm8-120-674-reconcile.spec.ts. It imports ./support/refund-reversal-harness, so place it in test/.
