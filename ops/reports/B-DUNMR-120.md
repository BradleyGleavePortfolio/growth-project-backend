# B-DUNMR-120 report (builder, Claude Opus 5.5, T4) — agent 120

Job: backend dunning D1 #687, D2a #688, D2b #704, D2c #705 — verify D1 main refresh f3c7fd37, restack #705 onto #704,
C-680-18 guard (hard obligation), C-680-19 (won dispute restore), probes, one comment per PR, READY FOR AUDIT.

Started 09:28 PDT 10-05. Lock `dunning` taken 09:28 PDT (ops/lanes120/locks/dunning).

## Starting heads (GitHub REST 09:30 PDT)
| Piece | PR | Head | Base | State |
|---|---|---|---|---|
| D1 | #687 | f3c7fd37777ef1cde75ec5fb984edf5cb973f864 | main | clean, +2424/-216 |
| D2a | #688 | 5003e7e6abe87680484658c7f2c7433ab5fef357 | agent115/dunning-split-1-foundation | clean, +1905/-535 |
| D2b | #704 | 32d886bb2f7cb71384b83e5f07adc5c8a7d7fb3b | agent115/dunning-split-2-dunning-service | clean, +615/-79 |
| D2c | #705 | 279ec1677d574b86e773248174eef57c1d2a237d | agent119/dunning-split-2b-v1-marker-fixtures | DIRTY, +907/-380 |

## Log
- 09:28 rules read (_COMMON_120/119/118/116, AGENT_RULES), entry read, lock taken.

- 09:35 step 1 verified: f3c7fd37 (B-DUNR-119) remerge-diff read; both sides kept for D1-D2c (details below). CI green at f3c7fd37.
  #688 5003e7e6 and #704 32d886bb trees equal a fresh `git merge-tree` of their parents (merge-only, clean).
- 09:44 operator mail (owner 09:43 rulings 5/6/7): inquiries pause (verify on #705), failed refund after access ended = coach alert
  only (confirm), full-refund pause NOT in this round. Plan unchanged.
- 09:50 #688: ff3a13a5 (C-680-18 regression, failing before) + 21714f7b (guard) pushed. Lane failing-before run 37343244840.

## Step 1 — f3c7fd37 conflict resolution (D1 main refresh)
- stripe-connect-api.service.ts: main's StripeSubscriptionCheckoutObject/StripeSetupIntentObject/Balance/Charge types,
  on_behalf_of checkout form (S-FEE), listChargeRefunds kept; D1's StripeInvoiceObject, declineCode/idempotentReplayed on
  StripeConnectApiError, setCustomerDefaultPaymentMethod, listOpenInvoices (fail-closed), payInvoice, setCancelAtPeriodEnd kept;
  retrieveInvoice = main's position + D1's payment_intent expand (main's only caller, prefetchFailedInvoice, reads `status` only).
  Duplicates resolved to main: createSetupIntent (requires onBehalfOf + metadata), retrieveSetupIntent,
  setSubscriptionDefaultPaymentMethod (+liftTrialEnd), voidInvoice(invoiceId, key) positional. No caller in D1-D2c (git grep).
- email.types/email.service: COACH_PAYOUT_ADJUSTMENT kept, DUNNING_V2_CLIENT/COACH appended. .env.example, prod-switches,
  privacy list, schema auto-merged; Schema parity + build-and-test green.
- FOR THE D3 RESTACK (#689, not mine): D3 client-billing.service.ts:377 createSetupIntent({customer, metadata, key}) lacks
  onBehalfOf (main requires it; D1's copy deliberately had no on_behalf_of so the card serves every plan) and :1603
  voidInvoice({invoiceId, idempotencyKey}) is the object form; both fail to compile on the refreshed D1. Fix in D3.

## HANDOFF
- #688 pushed 21714f7b (C-680-18 guard). Next: merge-only restack #704, then #705 restack + conflict resolution.
