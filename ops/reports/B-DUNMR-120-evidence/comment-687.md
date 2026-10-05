MAIN REFRESH (B-DUNMR-120, agent 120) — growth-project-backend#687 @ f3c7fd37777ef1cde75ec5fb984edf5cb973f864

This round checks the B-DUNR-119 main refresh (merge `f3c7fd37` = `c260a849` + main `ee55f814`). No code changed.

**Size:** 2,640 changed lines (2,424+/216-), from `gh api pulls/687`. This PR is grandfathered and stays under 3,000.

**How the merge conflicts were resolved: both sides kept** (remerge diff read one file at a time)

| File | Kept from main | Kept from D1 |
|---|---|---|
| `src/connect/stripe-connect-api.service.ts` | S-FEE and recurring types (subscription checkout, setup intent, balance, charge), the `on_behalf_of` checkout form, `listChargeRefunds`, `createSetupIntent` (onBehalfOf + metadata), `retrieveSetupIntent`, `setSubscriptionDefaultPaymentMethod` (+ liftTrialEnd), `voidInvoice(invoiceId, key)` | `StripeInvoiceObject`, `declineCode` / `idempotentReplayed` on `StripeConnectApiError`, `setCustomerDefaultPaymentMethod`, `listOpenInvoices` (fails closed on a malformed or incomplete list), `payInvoice`, `setCancelAtPeriodEnd`, the `payment_intent` expand on `retrieveInvoice` |
| `src/email/email.types.ts`, `email.service.ts` | `COACH_PAYOUT_ADJUSTMENT` | `DUNNING_V2_CLIENT`, `DUNNING_V2_COACH` |
| `.env.example`, `prod-switches.yml`, `prisma/schema.prisma`, `test/privacy/no-pii-in-logs.spec.ts` | auto-merged; both sides' entries present | same |

When main and D1 both had a method, the merge kept main's signature. A `git grep` across D1-D2c finds no caller of the dropped D1 copies. Main has one caller of `retrieveInvoice` (`prefetchFailedInvoice`), and it reads only `status`, so the added expand is safe.

**Note for the D3 #689 restack (that PR is not touched here):** `client-billing.service.ts:377` calls `createSetupIntent` without `onBehalfOf`, and `:1603` calls `voidInvoice({ invoiceId, idempotencyKey })`. Neither compiles against this D1, so both need fixing in the D3 restack.

**Probe replay:** CI lane [37344902060](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37344902060) at this head: 10 passed, 0 failed.

| Probe (lens) | Result |
|---|---|
| Opus 118 aud-opus-d12-118-687 | pass |
| Sol 116 aud-sol-d12-116-d1 | pass |
| Sol 118 687-probe (R-DISPUTE-PAUSE copy adaptation, B-DUNSPLIT-119) | pass |

**Money self-check** (D1 is inert: flag off, no handler wiring)
- Webhook order/redelivery: D1 changes no handler.
- Concurrency/lock order: D1 adds no lock.
- Terminal states (refunded/disputed/canceled/deleted): D1 writes none of them.
- Pagination fail-closed: `listOpenInvoices` throws on a malformed page and on `has_more` without a cursor (kept).
- Currency/minor units/zero-decimal: invoice amounts are Stripe minor units, with no conversion.
- Copy truth: the dispute copy says access has ended and billing is paused. D2c #705 builds the pause, and FEATURE_DUNNING_V2 stays off until the stack lands.

**Required checks at this head:** all green (18 checks; deploy-readiness-gate is skipped by design).

READY FOR AUDIT
