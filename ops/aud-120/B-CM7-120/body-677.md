**Tier:** T4 (money path). **Why:** M4 coach Money service specs (tests only): refunds, chargebacks, head-coach transfer reversals and the coach Money ledger read. **T4 trigger scan:** tests only (money path specs); no runtime change. **T3 trigger scan:** none beyond T4. **Bounded T1:** no. **Canonical builder:** Claude Opus 5.5 (B-CM5-119, agent 119; earlier rounds B-CM4-118, agent 118; B-CM1-116, B-CM-117, B-CM3-117). **Parent owner:** #641 split stack (M1 -> M3 -> M4). **Acceptance evidence:** failing-before CI-lane runs and green required checks per Fix round below. **Promotion triggers:** none (already T4).

Split of #641 (coach Money backend, FIX ROUND 5 @ `f60ed603`, 6,738 lines) under the owner's PR size rule: over 3,000 changed lines is an automatic fail (MODEL_ROUTING.md 8.2, tgp-agent-context). #641 was BEHIND main; it was merged with main `d23fa317` locally (clean, no conflicts) and the pieces were cut from that tree. Pieces: M1 refund transfer reversal (base main) -> M3 Money read API (base M1) -> M4 service unit spec (base M3); M2 package-create idempotency is independent (base main). M2 + M4 together equal the refreshed #641 tree (git diff). Prior verdicts (Sol RC 0/4/1, Opus RC 0/1/1 at 02cd3f88) do not carry; each piece needs fresh Opus 5.5 and Sol audits at its exact head (T4, money path). `tsc --noEmit` passes at every piece.

**M4 (base M3, 1,244 lines):** CoachMoneyService unit spec. Local: 55/55.

## Fix rounds

| Round | Job | Head | Closes | Size |
|---|---|---|---|---|
| 1 | restack, merge-only (B-CM1-116, agent 116) | `1f746547` | restack |  |
| 2 | B-CM-117, agent 117 | `cdb627db` | restack on #676 54e61566; review, reconcile and production-writes specs moved here unchanged | 2,605 |
| 3 | restack, merge-only/test move (B-CM4-118, agent 118; finishes B-CM3-117) | `4799c6af` | restack on #676 ccd60bbc; refund-reversal-boundaries spec moved here unchanged | 2,918 |
| 4 | restack, merge-only (B-CM5-119, agent 119) | `6340993b` | restack on #676 04b76b4d then ecaf75fd; M5 #703 (fix-round tests) stacks on this branch | 2,918 |



