# AUD-OPUS-F4-119 (Claude Opus 5.5 lens, agent 119) — fees F4 #684 + F4b #697

Started: Sun Oct  4 12:30:53 PDT 2026
Claims: lanes119/claims/backend-684-6b13af56-opus, backend-697-88c72200-opus
Heads at start: #684 6b13af56bf2d8a36ae5559a537ee565555a6c4c7 (READY, required checks pass=10 skipping=1), #697 88c722003c23634df69338e4ee6ceb2dd71068e6 (READY, pass=10 skipping=1)
Notes dir: ops/aud-119/AUD-OPUS-F4-119/

## Progress (complete, 2026-10-04 12:48 PDT)
- Restack merges since d3e8ceb2 (#684: 6decdd0a, 145452a6, d3e8ceb2, 7872a533, bbf2eac6, 6b13af56; #697: b8b63e63, 45ebb1e1, 88c72200): `git show --remerge-diff` empty for all. #684 own-diff patch-id a5d4d171b301 unchanged d3e8ceb2..6b13af56; #697 c27f641ff50e -> a2b7fb56801a only via operator FIX ROUND 16 (1807d4cc, test-only, read).
- Red-by-design: build-and-test 6b13af56 run 37225036796 (730 passed, 0 failed; checkout-webhook-fee-split, purchase-split-handler.service, reconciliation.service PASS). 88c72200 run 37225036314 (734 passed, 0 failed). All required checks green at both heads.
- R75 range b644198b..88c72200 OK (as any net -14, others 0); also OK from main 3e9a9a75. Main 3e9a9a75 is not yet merged into the stack (operator item).
- Moved specs: s-fee-charge-settlement byte-identical to F3 35a18539 (Opus APPROVE); s-fee-settlement-sweep identical to e9ee033d; s-fee-r11 +20/-8 fixtures only.
- Prior Opus probe (117, P1-P5) passes at 6b13af56: run 37225764023 (builder's replay, spec byte-identical to the lens copy).
- New probe audit/AUD-OPUS-F4-119/684-refundstatus (a8bf276c on 6b13af56), run 37229178449: R0 PASS, R1 FAIL, R2 FAIL, S1-S4 FAIL, S5 PASS. Spec kept: ops/aud-119/AUD-OPUS-F4-119/probe-audit-opus-f4-119-684.spec.ts. Branch deleted.

## #684 @ 6b13af56bf2d8a36ae5559a537ee565555a6c4c7 — REQUEST CHANGES, A/B/C = 0/2/4
- Comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/684#issuecomment-5983739251 (draft: ops/aud-119/AUD-OPUS-F4-119/verdict-684.md)
- Prior: B-684-3 closed at the handler (production reach = B-684-7); C-684-4 closed; C-684-3 carried.
- B-684-7: `refund.updated` not routed (checkout-webhook-handler.service.ts:219-227, default :260-261); the round-13 case at refund-dispute-handler.service.ts:178 is unreachable; `charge.refund.updated` is deprecated / "selected payment methods" per Stripe. Fix: add `case 'refund.updated'` at :220 + router-level test (probe R1/R2). Same root as Sol B-684-4.
- B-684-8: stale event rewrites a failed refund to succeeded and moves money (upsertAndApplyRefund :562-571 overwrites status; apply under lock :628-631 checks only ledger_reversed; same-currency sums DB succeeded rows charge-settlement.service.ts:1689; completeRefunds trusts embedded snapshot :425; alert check outside lock :495). Fix: failed/canceled terminal and succeeded only -> failed in updateExisting; apply only if fresh row still succeeded under the lock; failed-after-apply decided under the lock. Probe S1-S4.

## #697 @ 88c722003c23634df69338e4ee6ceb2dd71068e6 — APPROVE, A/B/C = 0/0/1
- Comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/697#issuecomment-5983739415 (draft: verdict-697.md)
- C-697-2 (Sol already used C-697-1): all 17 refund-status calls in s-fee-r13 spec go to the handler directly (refundUpdated at :129-133), never the router; add a router-level case with the #684 fix.

## Follow-ups (C)
- C-684-9 refund-dispute-handler.service.ts:145: notices delivered right after the money step only for `charge.*` events; add `refund.updated` (refund object's `charge`). (Sol B-684-4 also lists the notice handoff.)
- C-684-10 payout-notice.service.ts:229, :239 (claim set at :181-191): a deadline stop keeps `dispatch_claimed_at` and spends 1 of 6 attempts; clear the claim and do not count the attempt.
- C-684-11 (outside diff) refund-dispute-handler.service.ts:263-265: a pending full refund flips the purchase to refunded / entitlement off on amount_refunded; if it then fails nothing restores access or alerts. Fix: alert on failed/canceled of a never-applied refund; restore of access is a product decision. (Mirror of Sol B-684-5: succeeded async full refund leaves access active.)
- C-684-3 (carried, outside diff) refund-dispute-handler.service.ts:1151 dispute alert "Submit evidence in Stripe within 7 days." must follow R-DISPUTE-PAUSE copy for recurring plans (owned by the dispute-pause work).

## Sol comparison (read after posting)
- Sol #684 @ 6b13af56 RC 0/3/1 (5983705658): B-684-3 deadline at awaited send boundaries; B-684-4 refund.updated unreachable (= Opus B-684-7); B-684-5 succeeded async full refund leaves access active; C-684-4 Prisma distinct in memory. Opus B-684-8 (stale status) is Opus-only.
- Sol #697 @ 88c72200 APPROVE 0/0/1 (5983685798).

## For the operator
1. One fix round on #684 (recommended default): B-684-7 + Sol B-684-4 (same line), B-684-8, Sol B-684-3/B-684-5; tests in #697 (1,831 lines, room). #684 has 565 lines of headroom for src.
2. Webhook endpoint subscription (default: subscribe to `refund.updated`, keep `charge.refund.updated` while it is sent; both are idempotent once B-684-7 lands). Verify in Stripe settings, no code.
3. C-684-11 product decision: after a failed refund, does the client get access back automatically? Default: alert only, coach decides.

## Cleanup
- audit/AUD-OPUS-F4-119/* branches: 0 remain. Worktrees wt/AUD-OPUS-F4-119-684 and -697 removed (no node_modules). Claims kept in lanes119/claims. Nothing pushed to PR branches.

## HANDOFF
- backend #684 @ 6b13af56bf2d8a36ae5559a537ee565555a6c4c7: Opus REQUEST CHANGES 0/2/4 posted (5983739251); Sol RC 0/3/1. Next: builder fix round (B-684-7, B-684-8, Sol B-684-3/4/5), restack #697/#685/#686, then fresh Opus lens audits the delta with probe spec R0-R2/S1-S5 (all must pass).
- backend #697 @ 88c722003c23634df69338e4ee6ceb2dd71068e6: Opus APPROVE 0/0/1 posted (5983739415); Sol APPROVE. The #684 fix round adds tests here, so a delta verdict is needed at the new head.
- This job ends here.
