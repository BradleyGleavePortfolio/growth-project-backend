AUDIT Claude Opus 5.5 — growth-project-backend#690 @ 06307883100ec142aa2818fc30ee276cab26c1ec — VERDICT: APPROVE
A/B/C = 0/0/3

Lens AUD-OPUS-D34-118 (agent 118). Tier T4 (money, access, webhooks). Head re-read right before posting: unchanged. Checks at this head: pass=10, skipping=1 (CI 37178686881, npm audit 37178686852, schema 37178686843). Size 2,913 changed lines (2,690+/223-; under 3,000). R75 range check OK. This verdict covers the D4 diff (base #689's branch). #690 cannot land before #689's B-689-5 fix; that fix restacks this PR, and the restacked head needs a short merge-only delta verdict.

Probe run (this head + probe spec only, branch audit/AUD-OPUS-D34-118/690-probes): https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37220162681 — W0, W1, W2 pass. W3 and W4 fail; both are in #688 code (below, not counted here).

## Prior Opus findings (116 verdict 5976089623 @ f72668c2)
| ID | Decision | Closing commit | Failing-before | Replay at this head |
|---|---|---|---|---|
| B-690-1 one failed dispute read on invoice.paid settled the dispute cycle | CLOSED | 821d943f (resolveDunningOnPaid fails the delivery with DunningWebhookRetryError DUNNING_DISPUTE_CHECK_FAILED) | 37174150526 | W1 passes: the webhook throws, the redelivery keeps the dispute cycle and the compressed-cycle lock applies on its day |
| C-690-1 late payment_failed after 2A flipped the ended plan to past_due | CLOSED | 821d943f, 0681babd (stale_after_cancel :1328-1333, safeDeclineCode) | 37174150526 | W2 passes: canceled / abandoned kept, last_error is a code |
| C-690-2 dispute effects fire-and-forget | CLOSED in this diff | 821d943f (runDisputeEffect :305-338 awaited before the dedup row; :336 throws DUNNING_DISPUTE_EFFECT_FAILED) | 37174150526 | builder test B-690-3 green in 37174520805; residual in #688 (W3 below) |
| C-690-3 card page first person and "your access stays on" | CLOSED as raised | 821d943f | 37174150526 | the dispute-cycle nuance of the new sentence is C-690-5 |
| C-690-4 free-form error text in new log lines | CLOSED | 821d943f (dunningErrorCode on every new warn/error) | 37174150526 | no `(err as Error).message` in added lines |

FIX ROUND 2 (5976853953) is merge-only: the D4 files changed since f72668c2 are exactly the fix-round files (handler, dunning-grace, scheduler, entitlement guard, public-pages.html, two specs); every other D4 file is byte-identical to f72668c2. Sol's B-690-1 fix (DunningState FOR UPDATE + clientCancelPending re-check + `status: { not: 'canceled' }` predicate, :886-904) and B-690-5 (unpaid grace, dunning-grace.ts, entitlement guard) were read in full and hold.

## C-690-5 — the public card page still promises a charge and restored access to clients in a dispute cycle
- Where: `src/public-pages/public-pages.html.ts:91-94`: "After the new card is saved, the app tries the amount owed on it; once that payment goes through, access continues, or comes back if it was paused." Every v2 client notice links here (DUNNING_UPDATE_CARD_URL), including dispute-cycle notices.
- Counterexample: a client locked in a dispute cycle opens the page; the app never charges a reversed payment and access does not come back after a card update (P1 on #689, run 37220145001).
- Minimal fix rule: add a dispute sentence, e.g. "A payment your bank reversed is not settled by a new card; reply to the email to reach support." (or scope the sentence to an unpaid invoice). Same rule as D12's B-687-5 for the email footer.

## C-690-6 — lock order: subscription.updated takes DunningState before ClientPurchase
- Where: `checkout-webhook-handler.service.ts:891-904` locks DunningState, then writes ClientPurchase. invoice.paid (outer tx) and #689's restoreAfterPayment (client-billing.service.ts:1119 then :1170), endAccessNow (:1780 then :1791) and keepPaidPeriod (:1711 then :1724) take ClientPurchase first.
- Counterexample: a 1A card update pays the invoice; Stripe sends customer.subscription.updated (past_due -> active) within about a second, while restoreAfterPayment's transaction holds the ClientPurchase row and waits for DunningState; the webhook holds DunningState and waits for ClientPurchase. Postgres aborts one after deadlock_timeout. Both sides recover (redelivery, or the card reply says access is still updating and invoice.paid finishes), so no wrong state; cost is a 1 s stall and a degraded reply.
- Minimal fix rule: one order everywhere, ClientPurchase then DunningState: take `SELECT ... FROM "ClientPurchase" WHERE id = ... FOR UPDATE` before the DunningState lock at :891 (same rule as D12's C-688-9 for tryLock).

## C-690-7 — payment_failed stale check and write are not atomic
- Where: `checkout-webhook-handler.service.ts:1328-1333` reads status and clientCancelPending, then `:1355-1364` writes `status: 'past_due'` unconditionally and `:1368` calls v1 recordFailure.
- Counterexample: the handler passes the check, a 2A completes (purchase canceled), then the write flips the ended plan to past_due (display only: entitlement stays false and the abandoned state is not reopened).
- Minimal fix rule: `updateMany({ where: { id, status: { not: 'canceled' } } })` and skip recordFailure when count is 0, as in the subscription.updated fix.

## Belongs to #688 (not counted here; in the operator report)
- W3 (run 37220162681): a won charge.dispute.closed whose purchase lookup fails once (`resolvePurchaseFromCharge`, dunning-v2.service.ts:1626-1690, catch at :1687-1689 returns null) is acknowledged and deduplicated: `first_delivery_threw:false`, `processed_rows:1`, the redelivery is `alreadyProcessed`, the cycle stays locked. This defeats the redelivery contract of C-690-2 / B-690-3 for this one read. Fix rule (#688): return null only on a clean miss; rethrow read errors.
- W4 (run 37220162681): a dispute created during a payment cycle but processed after the cycle resolves opens nothing (`handleLateReversal` previouslyCleared, dunning-v2.service.ts:1100-1106): obligation `open`, `dispute_cycle_open:false`, entitlement allowed. Processed before invoice.paid, the same dispute keeps a dispute cycle (W0). Fix rule (#688): a newly recorded open obligation on a resolved state opens the compressed cycle regardless of the dispute's created time.
