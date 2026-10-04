AUDIT Claude Opus 5.5 — growth-project-backend#683 @ 35a18539c8a911524c3eab5b074b33e247f80ac2 — VERDICT: APPROVE
A/B/C = 0/0/1

Lens job AUD-OPUS-F34-117 (agent 117). Tier T4 (money: settlement, refunds in converted currencies, reversals, reconciliation). Piece F3 of the #627 split, base F2 #682 @ a5d6a434. 5 files, +2959/-25 = 2,984 changed lines (under 3,000; 16 lines of headroom).

## Prior findings of this lens (at e2af8ca1, APPROVE 0/0/3)
| Finding | State | Evidence |
|---|---|---|
| C-683-1 red-by-design list inexact | Closed | PR body now lists exactly checkout-webhook-fee-split (2), purchase-split-handler (2), reconciliation.service (5); matches the CI log below. |
| C-683-2 presentment refund vs settlement gross | Closed | `convertedRefundedCents` (charge-settlement.service.ts:137-161) reads each succeeded refund's own balance-transaction debit, paged, in settleChargeLocked (:624-633), applyAdjustmentsLocked (:1360-1373, caller presentment cents ignored, :1474 drain) and reconcileSettlements (reconciliation.service.ts:343-352). Unreadable or wrong-currency debit -> RefundStateUnavailableError (retryable, flagged), nothing moves. Tests: r11 spec B-683-1 x4 in #684 (two-page late refunds at a changed rate, failed refund skipped, unreadable list, same-currency control). |
| C-683-3 newest 12 settlements only | Closed | `take: 12` removed (reconciliation.service.ts:221-225); test "drift on the oldest of thirteen renewals". Follow-up bound: C-683-4. |

Sol B-683-1/2/3 were also checked independently (not borrowed): B-683-2 pending rows are no longer cash (reconciliation.service.ts:387-395 and :408-409, status `unknown` + `transfers_pending_cents=N` note, drift still wins); B-683-3 every raw `(err as Error).message` sink in charge-settlement.service.ts now goes through `settlementFailureCode` (closed: retry codes, lock codes, else F2 `moneyErrorDiagnostic`); `RefundStateUnavailableError.message` is composed only of the code, the charge id and a closed `kind=` part. `git diff a5d6a434 35a18539 -- src` has no added non-comment line that reads an error message (the two raw-message lines in reconciliation.service.ts:206 and :277 are main's lines, re-wrapped by prettier; see "outside this diff").

## Evidence reuse (G09)
- Reused: this lens's APPROVE on #627 @ 3a5338d7 and on #683 @ e2af8ca1 (https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/683#issuecomment-5975904957) for F3 code not touched since.
- Why it applies: c6fb2e3e (restack) = e2af8ca1 + F2 merge; F3's files are byte-identical between e2af8ca1 and c6fb2e3e except the 4 lines F2 itself added to stripe-connect-api.service.ts. The F3 content delta is exactly `git diff c6fb2e3e 35a18539` (+230/-141: charge-settlement.service.ts 312, money-errors.ts 14, reconciliation.service.ts 34, stripe-connect-api.service.ts 11 = listChargeRefunds; the spec file is unchanged); merge 00ef30b7 is clean (`git show --remerge-diff` empty).
- Re-done deeply at this head: every line of that delta; the F2 round-11 contract F3 depends on (reverse() still resolves `succeeded` / `refused` or throws ReversalUncertainError, incl. the new `reversalMoved` claim_lost / send_abandoned paths; `undoReversal` removed and unused by F3); currency handling of awaiting / provisional rows (provisional row currency = purchase currency, claim rewrites `currency` to the balance-transaction currency at :661, and an fx settle replaces any stored presentment `refunded_cents` with the converted total).

## Piece-boundary safety
- Compiles alone: lint, `npx tsc --noEmit` and `npm run build` pass before `npm test` in run 37174989449.
- Imports main + F1/F2 only; nothing imports F4-F6; no migration; not wired into a module here (F4 wires it). F3's regression tests ship in F4 (`test/s-fee-r11-fx-cash-truncation-logs.spec.ts`) because F3 is at its size limit; acceptable only because the stack lands as one (rule 11).

## Red by design (verified at this head)
Run 37174989449 attempt 2, build-and-test https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174989449/job/111357782526 : 3 suites / 9 tests fail, 714 passed, 23 skipped.
- `test/checkout-webhook-fee-split.spec.ts` (2) and `test/purchase-split-handler.service.spec.ts` (2): main's expectations of the legacy head-coach transfer (`createTransfer` not called). F4 carries the updated specs; both PASS at F4 (run 37175734211).
- `test/reconciliation.service.spec.ts` (5): `TypeError ... reading 'findMany'` at reconciliation.service.ts:221 (main's prisma fake has no `chargeSettlement`). F4 carries the fake + S-FEE tests; PASS at F4.
- Attempt 1 (job 111355645469) additionally timed out `test/prod-readiness/operator-keys-artifact.spec.ts` (10 s, repo file scan; no F3 input); it passes on attempt 2 and at F4. Not a regression of this piece.
- Every other check at this head is green (Schema parity, npm audit, rls-floor-guard, rls-live, mwb-3-live, community-live, test-deploy-readiness, size-label). CodeQL, danger, banned casts and SBOM run only on PRs based on main.

## Findings

### C-683-4 — reconciliation of one purchase is now unbounded in Stripe reads
- Where: `src/connect/fees/reconciliation.service.ts:221-225` (no `take`), `:339-352` (one `retrieveCharge` per settled charge, plus up to 20 refund pages for a converted charge), run inside `runSweep` (:177, admin `POST reconciliation/run-sweeper` with up to 200 purchases, payment-ops.controller.ts:504-508 at the F4 head) and `GET reconciliation/:purchaseId`.
- Counterexample: a weekly subscription in its third year has about 150 settled charges: one reconcile is about 150 sequential Stripe calls; an admin sweep over 200 such purchases is about 30,000 calls inside one HTTP request (G15: bound external calls and list sizes). Before round 11 the bound was 12 per purchase but incomplete (C-683-3).
- Fix rule: keep full coverage with a bound: per run, read at most N settlements per purchase (newest first, plus every settlement with an open recovery, a reconcile flag or an adjustment in the last 120 days), persist a per-purchase cursor (or report `unknown` with `charges_not_checked=N`) so later runs cover the rest. Never report `ok` for unchecked charges.
- Verify: spec with 60 settled charges: Stripe reads per run <= N, status `unknown` with the note until the cursor completes, then `ok`/`drift`.

## Outside this diff (not blocking)
- reconciliation.service.ts:206 (`reconcile failed purchase=...: ${message}`) and :277 (legacy charge retrieve) still log raw error messages; both are main's lines (only re-wrapped here). Recommended: route them through `settlementFailureCode` when main next touches the file.

## Notes
- Converted-currency notices show the settlement-currency refund as "customer refunded"; latent while packages are usd-only.
- No probe was needed for #683: the closure evidence is the round-11 spec (failing-before 37173415148, passing-after 37175462104 at the F4 head, which contains this tree) and the CI log above.
