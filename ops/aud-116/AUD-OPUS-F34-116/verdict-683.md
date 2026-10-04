AUDIT Claude Opus 5.5 — growth-project-backend#683 @ e2af8ca1fe872ca3c319b52b3ac3b8fca17de7bd — VERDICT: APPROVE
A/B/C = 0/0/3

Tier T4 (money). Piece F3 of the #627 split: `src/connect/fees/charge-settlement.service.ts` (+2075), `src/connect/fees/reconciliation.service.ts` (+234/-25), `test/s-fee-charge-settlement.spec.ts` (+586). Base agent115/fee-split-2-transfer-orchestrator (#682 @ 007d3dcb).

## Evidence reuse (G09)
- Reused: this lens's APPROVE 0/0/1 on #627 @ 3a5338d72c277238486452f7f256da2d8e22c7c8 (https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/627#issuecomment-5972040127).
- Why it applies: all three F3 files are byte-identical to 3a5338d7, to the refreshed #627 tree (merge-tree of 66162285 and main d23fa317 = 09de2bff), and to the F6 #686 tree (`git diff` empty for each file). Round 10 (6c7706e1) touched only `transfer-orchestrator.service.ts` (F2) and `test/s-fee-r9-paused-sender.spec.ts` (F5); the main merge 0d33c4d4 did not touch F3 files. No F3 line changed since that APPROVE.
- Not reused, re-done at this head: full read of `charge-settlement.service.ts` and `reconciliation.service.ts`; the F2 reversal contract this piece depends on (reverse() resolves `succeeded` or `refused`, uncertain outcomes throw ReversalUncertainError) re-checked against #682 @ 007d3dcb; red-check root causes from the CI log.
- C-627-10 (nullable column follow-up) stays the deferred C on #627; not re-raised.

## Piece-boundary safety
- Compiles alone: `npx tsc --noEmit` and `npm run build` pass at this head (job 111286637746, steps before `npm test`).
- Nothing imports a later piece: `charge-settlement.service.ts` imports main + F1/F2 modules only; the spec uses `test/utils/settlement-fakes` from F2.
- No migrations in F3 (tables come from F1). Not wired into any module here; F4 #684 wires it.
- Tests: the settlement spec ships here and passes in the F3 run (`PASS test/s-fee-charge-settlement.spec.ts`, job 111286637746). The reconciliation spec update for this piece's `reconciliation.service.ts` change ships in F4 (see C-683-1).

## Red by design (verified)
CI run 37151662477, job https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37151662477/job/111286637746 : build-and-test red, 3 suites / 9 tests failed, 712 suites passed, 23 skipped. Every other check at this head is green (Schema parity, rls-floor-guard, rls-live, mwb-3-live, community-live, npm audit, migrations).
- `test/checkout-webhook-fee-split.spec.ts` (2) and `test/purchase-split-handler.service.spec.ts` (2): main's versions expect the legacy head-coach transfer; F2 swapped the orchestrator, so `createTransfer` is not called / idempotency keys size 0. F4 carries the updated specs (both PASS at F4 run 37151663653).
- `test/reconciliation.service.spec.ts` (5): `TypeError: Cannot read properties of undefined (reading 'findMany')` at `reconciliation.service.ts:216`; main's prisma stub has no `chargeSettlement`. F4 adds the `chargeSettlement`/`payeeRecovery` stubs and 3 S-FEE tests (PASS at F4).
- `test/checkout.service.spec.ts` is green here (F1 carried its update).
- Result: every red test fails for the stated class of reason (main spec not yet updated for the coupled S-FEE change; F4 carries the update), but the stated list is not exact (C-683-1).

## Money paths re-verified (no finding)
- Fee = gross (balance transaction) - actual Stripe fee - 2%; `computeChargeSplit` integer cents, platform absorbs rounding; $0/free skipped; legacy destination charges never get a coach transfer.
- Settle idempotent per charge: unique settlement row + CAS claim that includes the adjustment columns; transfer idempotency key `tgp-settle-${chargeId}-${leg}`; head coach without a Connect account leaves the split with the sub-coach.
- OR-111-1: refunds/disputes converge each leg to an absolute target under the charge lock; only that charge's own transfers are reversed; the remainder becomes a PayeeRecovery; forward-only netting from the payee's next transfers in the same currency with CAS on (amount, collected, status); no payout delay, no negative-balance debit. Checked by hand: refund of a sale whose transfer already netted an earlier recovery leaves the coach owing exactly both sales' fees.
- ChargeLock: re-entrant (AsyncLocalStorage); fence refuses on not_held / budget_exceeded / taken_over; wait 3 s inside the 5 s webhook transaction; hold budget 60 s < TTL 120 s.
- Sweep bounds: 25 settlements per pass, transfer batch 50, run budget 8 min < 10 min lease.

## Findings

### C-683-1 — red-by-design statement is inexact; reconciliation spec update is not with its code
- Where: PR body "Landing" paragraph; `src/connect/fees/reconciliation.service.ts:216` (new `prisma.chargeSettlement.findMany`) vs main's `test/reconciliation.service.spec.ts` stub.
- Counterexample: the body says "purchase-split, webhook fee-split and checkout specs stay red at F2 and F3". At this head the checkout spec is green and `test/reconciliation.service.spec.ts` is red (5 tests, TypeError above), job 111286637746.
- Fix rule: correct the body to "purchase-split, webhook fee-split and reconciliation specs" (no code change needed, the stack lands as one), or move the reconciliation spec stub + S-FEE tests from F4 into F3.
- Verify: body text matches the failing-suite list of the next F3 run.

### C-683-2 — refunded amount (presentment currency) compared with gross (settlement currency)
- Where: `src/connect/fees/charge-settlement.service.ts:499`, `:581` (gross = `bt.amount`, settlement currency) vs `:589` (`charge.amount_refunded`, presentment currency) and `:1317-1322` (`succeededRefundCents` from ChargeRefund rows, presentment); same mix in `reconciliation.service.ts:257`, `:364`, `:371`.
- Counterexample: a package priced in EUR settles in USD on a US platform: gross 10850 (USD cents), full refund `amount_refunded` 10000 (EUR cents). The settlement treats it as a partial refund and leaves part of the coach payout in place; a zero-decimal currency (JPY) errs the other way and over-recovers. Latent today: the mobile editor always sends `usd` (growth-project-mobile `CoachPackageEditScreen.tsx:314`), but the API accepts any 3-letter code (`src/packages/packages.service.ts:679`, outside this diff).
- Fix rule: until multi-currency is designed, reject non-`usd` package currency in `packages.service.ts` (separate small PR), and in `settleChargeLocked` refuse to settle (mark awaiting + `alert=true`) when `charge.currency !== bt.currency`.
- Verify: unit test creating a `eur` package returns 400 PACKAGE_INVALID with a working next action; settlement spec with `charge.currency='eur'`, `bt.currency='usd'` leaves the row awaiting with an alert log.

### C-683-3 — reconciliation covers only the 12 newest settled charges of a purchase
- Where: `src/connect/fees/reconciliation.service.ts:216-219` (`take: 12`).
- Counterexample: weekly subscription, week 16: a chargeback on the week-2 charge (inside Stripe's dispute window) is never reconciled, so drift on that charge is not reported.
- Fix rule: also reconcile any settlement with an open recovery or updated in the last 120 days, or page through all settlements in bounded batches.
- Verify: reconciliation spec with 14 settlements and drift on the oldest reports that drift.

## Other notes
- Nothing found that belongs to another PR from this piece.
- No probes were needed: all three findings are C and rest on the CI log and the code lines above.
