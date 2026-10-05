AUDIT Claude Opus 5.5 — growth-project-backend#697 @ 88c722003c23634df69338e4ee6ceb2dd71068e6 — VERDICT: APPROVE
A/B/C = 0/0/1

Lens job AUD-OPUS-F4-119 (agent 119). Opus IDs (C-697-2 avoids the Sol C-697-1 number). First Opus verdict on this PR. Tier T4 (tests for refunds, reversals, sweep deadline, payout notices). Piece F4b, tests only, base F4 #684 @ 6b13af56. 4 files, +1,831/-0 (1,500-3,000 band: operator SIZE ASSESSMENT). No `src` file, no migration, no lockfile.

## Scope read
| File | Lines | Basis |
|---|---|---|
| `test/s-fee-r13-refund-list-notices-deadline.spec.ts` | 513, new | Read in full. 22 tests: Sol B-683-4 reader (5 malformed / incomplete page shapes reject `SFEE_REFUND_STATE_UNAVAILABLE`, converted incomplete page moves nothing and flags), Sol B-683-1 (CAD 25 at USD 20: coach 5,640, notice keeps both amounts; changed-rate full refund 8,300 / 10,000), Opus B-684-3 P1-P5 (exact 4,630 / 0 / one reversal), C-684-4 (alert prefix, flag, coach 2,630 kept), Sol B-684-1 (11 refunds, 10 embedded: 11 rows, 4,900, reversals 4,630; unreadable list rejects with 0 rows), Sol B-684-3 (16 of 25 pushes at exactly 8:00, 9 pending, next run 25 total, none repeated), G12 canary. Every amount is exact; no banned cast. |
| `test/s-fee-r11-fx-cash-truncation-logs.spec.ts` | 373, moved from F4 | `git diff e9ee033d:<file> 88c72200:<file>` = +20/-8: listed refunds gain Stripe's own `amount`/`currency` (the reader now requires them) and the two B-684-1 cases stub the complete list holding the eleventh refund; every amount assertion unchanged. |
| `test/s-fee-charge-settlement.spec.ts` | 586, moved from F3 | Byte-identical to F3 @ 35a18539, where this lens posted APPROVE on #683 (comment 5976735455). |
| `test/s-fee-settlement-sweep.spec.ts` | 359, moved from F4 | Byte-identical to F4 @ e9ee033d (this lens's #684 review there raised nothing in it). |

## Evidence reuse (G09)
- Reused for the two byte-identical moved specs only (verified with `git diff` against 35a18539 and e9ee033d); they now run against later F3/F4 code and pass at this head.
- Audited fully: the round-13 spec and the round-11 fixture delta; the operator FIX ROUND 16 change (1807d4cc, test-only: `chargeRefundsFromStripe` imported and called directly, the `as unknown as Record<...>` lookup and the unused type import removed, assertions unchanged).

## Restack check
- Merges b8b63e63, 45ebb1e1, 88c72200: empty `git show --remerge-diff`. Own-diff patch-id `c27f641ff50e` at 2ae0c3c9 / 45ebb1e1 and `a2b7fb56801a` at 1807d4cc / 88c72200 (the only change is FIX ROUND 16).

## Piece-boundary safety
- Tests only; imports exist at #684 and below (no later piece); inert for production. The moved specs leave F3/F4 without them until the stack lands together (rule 11), which the operator ruled for size.

## CI and R75
- build-and-test at this exact head, [run 37225036314](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37225036314/job/111502836345) (head_sha 88c72200 verified): 734 suites passed, 0 failed, 12,674 tests; s-fee-r13, s-fee-r11-fx-cash-truncation-logs, s-fee-charge-settlement, s-fee-settlement-sweep all PASS. Every required check green (deploy-readiness-gate skipped, conditional).
- `node scripts/check-r75.js --mode=range --base=b644198b --head=88c72200`: OK, no positive class (`as any` net -14, `as unknown as` / `as never` / empty-catch net 0). Same result from current main 3e9a9a75 (which is not yet merged into the stack: operator main-merge item).

## Findings

### C-697-2 — every refund-status test calls the refund handler directly, never the webhook router
- `s-fee-r13-refund-list-notices-deadline.spec.ts:129-133` (`refundUpdated` builds `charge.refund.updated` events) and all 17 handler calls use `c.refunds.handle(...)`, so the suite cannot see that `refund.updated` is not routed by `CheckoutWebhookHandlerService` (Opus B-684-7 on #684). Fix rule: drive at least one async-refund case through the router with `refund.updated`; the natural place is the B-684-7 / B-684-8 test the #684 fix round adds here (probe spec R0-R2, S1-S5 at ops/aud-119/AUD-OPUS-F4-119/probe-audit-opus-f4-119-684.spec.ts).

## Note
- #684 below carries REQUEST CHANGES from this lens (B-684-7, B-684-8, code in #684). Per guide rule 9 those do not block this tests-only piece; its fix round will add tests here, which needs a fresh delta verdict.
