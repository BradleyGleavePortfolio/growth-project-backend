# Spec: Payments + Checkout (Stripe Connect + future MoR)

> **Status:** Draft — docs only. Roadmap row #41. No runtime, schema, env-var, or module-wiring change in this PR.
>
> **Reading order:** This is the **foundational** spec for the commerce wave. Read it first. Every other commerce spec (#40, #42, #43, #44, #45) depends on the connected-account model, the platform-fee shape, the ledger contract, and the refund / chargeback / tax conventions defined here.

## 1. Cross-references

- **PR #117** (AI Program Builder RFC) — adjacent; offer fulfilment may publish a draft.
- **PR #118** (Team Mode foundation ADR) — every commerce table reserves `acted_by_member_user_id` for setter attribution.
- **PR #120** (platform readiness) — lane #05 (billing packaging) reserves the Stripe Connect revenue-share shape; this spec is the runtime shape behind that reservation.
- **PR #122** (masterminds operating model) — §7 commercial model. The MoR path in §5 below is the runtime shape that backs deposits + balances on $30k IRL seats.
- **PR #123** (coach-experience wave) — #37 (tiering L2/L3) defines the entitlement axis that gates which commerce surfaces a coach unlocks.
- **Existing runtime:** `src/billing/` (Stripe-mirror tables for the per-seat coach SaaS plan; `CoachSubscription`, `Invoice`, `PaymentFailure`, `StripeProcessedEvent`). `docs/stripe-setup.md` operator runbook. **This spec does not modify the per-seat plan.** It adds a parallel commerce surface for coach→client charges; the per-seat plan remains TGP-direct, MoR=TGP, on the existing prices.

## 2. WHY

### Coach-side problem

A coach today bridges TGP to outside tools to take money: Stripe Atlas to incorporate, Kajabi or Stan Store to host the checkout, ClickFunnels for the high-ticket page, a separate Stripe account they themselves manage, a manual invoice for IRL deposits, a hand-rolled refund spreadsheet. Each tool is a leak: a place where the coach's customer leaves TGP's surface, a place where TGP can't attribute revenue, a place where the support burden falls on the coach.

The reality even worse than the leak: **most coaches do not want to think about Stripe.** They open a Stripe dashboard once, see the words "1099-K", "chargeback rate", "radar rules", "tax behavior: inclusive vs. exclusive", and outsource the entire problem to a VA or a launch-agency that charges 10% of revenue. That 10% is the wedge TGP captures by making payments **invisible to the coach** until they want them visible.

### TGP-side problem

The platform monetisation today is one SKU: `$300/mo flat per coach`. To become a Whop-for-coaches, TGP needs a **second money flow**: a take-rate on coach→client revenue that scales with coach success rather than coach headcount. Without a payments lane, no other commerce surface (storefront, offers, applications, affiliate, marketplace) can move money — they remain marketing toys.

### What "shipped" unlocks

- A coach onboards payments in **one click + KYC** (Stripe Connect Express). They never see a price ID, a webhook secret, a tax-behavior toggle.
- A client checks out **on a TGP-owned URL** (`coach.tgp.app/<offer>` or in-app). Receipts, refunds, dispute notices all flow through TGP — the coach gets a unified inbox, not seven Stripe-account dashboards.
- TGP earns a **platform fee** (basis-point + flat per transaction) on every coach→client charge, recorded to a TGP ledger and reconciled nightly against Stripe.
- **Future-flip ready:** any product (mastermind seat, marketplace template, group cohort) can be moved from coach-direct (Connect) to TGP-as-MoR by changing one column on `Offer` — no redeploy, no schema migration. This is how the L2/L3/mastermind path in PR #122 reaches scale.

## 3. WHEN

Gating conditions before the first runtime PR can open:

1. ✅ This spec is reviewed and accepted by founder + backend lead.
2. ✅ PR #120 lane #05 (billing packaging) accepted — confirms the take-rate shape (`platform_fee_bps`, `platform_fee_flat_cents`) is the right knob.
3. ✅ PR #118 (Team Mode foundation ADR) at least at "first runtime PR opened" — confirms the `acted_by_member_user_id` forward-compat shape so this spec can reserve the column without colliding.
4. ✅ A Stripe Connect platform application is filed, reviewed, and approved for TGP. **This is a multi-week external dependency** and is the actual long-pole. Filing happens in parallel with this spec's review; first runtime PR should not open until Stripe approves the platform.
5. ✅ A KYC/AML risk owner is named on TGP's side (defaults to founder until a finance ops hire is made; documented in §17 dependencies).
6. ✅ The two open questions in §20 are answered (refund window default, dispute liability default).

## 4. Account model — Stripe Connect Express (default)

### 4.1 Why Express, not Custom and not Standard

| Option       | Coach effort                                                                | TGP effort                                                                                  | Pick |
| ------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---- |
| **Standard** | Coach owns a Stripe account, sees Stripe dashboard, gets emails from Stripe. | Lowest. TGP doesn't own KYC or disputes.                                                    | ❌    |
| **Express**  | One-page Stripe-hosted onboarding (email + DOB + bank). No dashboard by default. KYC handled by Stripe with TGP-branded UI. | Medium. TGP owns the experience but Stripe owns the regulatory burden. **This is what Whop, Substack, and Patreon all use.** | ✅ default |
| **Custom**   | Coach sees nothing. TGP collects every KYC field via Stripe API and presents its own UI. Full control. | Highest. TGP owns every regulatory disclosure, every dispute UI, every tax form. | 🔮 future, only if a high-ticket-only product line demands it |

**Decision:** Default to **Connect Express**. This is the lowest-coach-effort path that still meets the strategic goal "coaches do not think about Stripe" and does not push the regulatory burden onto TGP.

### 4.2 What lives where

- **Stripe** owns: KYC/AML, the bank-account on file, the settlement balance, 1099-K filing, the dispute-evidence portal (TGP relays into it), the chargeback liability default.
- **TGP** owns: the checkout surface (UI + URL), the offer catalog, the customer record (`User`, `Client`), the refund button (TGP issues the refund via Stripe API), the receipts (TGP-branded email), the unified support inbox, the ledger.
- **Coach** owns: their offers, their pricing, their refund decisions inside the policy TGP enforces, their public storefront content.

### 4.3 Onboarding flow (in-app)

```
Coach taps "Start accepting payments" in console
   │
   ▼
TGP creates Stripe Connect Express account (POST /v1/accounts, type=express)
   │  account_id stored on CoachStripeAccount row, status='pending'
   ▼
TGP creates an Account Link (POST /v1/account_links, type=account_onboarding)
   │  refresh_url = TGP /coach/payments/refresh
   │  return_url  = TGP /coach/payments/complete
   ▼
Coach completes Stripe-hosted KYC (email, DOB, SSN last-4 in US, bank account)
   │
   ▼
TGP polls account.charges_enabled on return; status →
   'verified' (charges_enabled=true && payouts_enabled=true)
   'pending'  (still waiting on Stripe verification)
   'restricted' (Stripe needs more docs)
   ▼
On 'verified', the coach's Offers can be set to status='active'.
```

The coach **never** sees the Stripe dashboard URL inside this flow. We expose a "View in Stripe" link only on the coach-payments page, behind a 3-second click delay (so it isn't the default action), and only after onboarding is verified.

### 4.4 Charge type

Default to **destination charges** (`payment_intent.transfer_data[destination]=<connected_account>`, `application_fee_amount=<platform fee>`).

| Charge type             | Statement descriptor                  | Refund authority                | Dispute liability  | Pick                                  |
| ----------------------- | ------------------------------------- | ------------------------------- | ------------------ | ------------------------------------- |
| Direct charge           | Coach's name on customer's card statement | Coach (TGP-as-API-caller works) | Coach              | ❌ (we want TGP-branded statements)     |
| **Destination charge**  | TGP's name on customer's card statement, coach's name as soft-descriptor extension | TGP (via API; coach gets a UI button) | Coach by default; TGP can opt-in to liability per-offer | ✅ default                              |
| Separate charges + transfer | TGP's name; transfer to coach is decoupled | TGP                             | TGP                | 🔮 future, used by the MoR path in §5 |

Why destination charge: customer recognises **TGP** on their card statement (lower chargeback rate; familiar brand), the coach gets the funds via the destination, and TGP can issue the refund button without the coach having to log in to a Stripe dashboard.

## 5. Merchant-of-record (MoR) path

### 5.1 Why MoR optionality is a hard requirement

Three classes of product cannot live on coach-direct Connect:

1. **L2 / L3 / mastermind seats** (PR #122 §2, §7). $30k IRL seats. The customer expects an invoice from "The Growth Project, Inc." — not from "Coach J's S-Corp." Tax compliance for a 50-state and EU/UK customer base is non-trivial; we centralise it.
2. **Templates marketplace** (PR #120 lane #05; future row in PR #123 follow-up wave). When a buyer purchases a template from a coach, the buyer's relationship is with the marketplace, not with the seller.
3. **Coach-of-coaches funnels** (Bradley sells L2 to Coach J; Coach J then sells L1 to clients). The chain of liability gets ugly fast under coach-direct.

For these, **TGP is the merchant of record**: TGP's Stripe account takes the charge, TGP files the 1099, TGP carries the dispute liability, TGP remits sales tax in jurisdictions where it has nexus. TGP then **pays the coach** a revenue-share via Stripe transfer (or off-platform if the coach has no Connect account at all).

### 5.2 The flip is a column, not a redeploy

```prisma
// On the Offer table (sketched in §8 of offer-builder.md)
payment_routing  PaymentRouting  @default(CONNECT_DESTINATION_CHARGE)

// New enum
enum PaymentRouting {
  CONNECT_DESTINATION_CHARGE   // §4 default. Coach is merchant; TGP is platform.
  CONNECT_DIRECT_CHARGE        // Reserved; coach is merchant fully (statement = coach).
  PLATFORM_MOR                 // §5. TGP is merchant; coach is paid via revenue-share.
  PLATFORM_MOR_DEFERRED_PAYOUT // §5. TGP is merchant; coach payout is held until milestone (e.g., event delivered).
}
```

The checkout service reads this column and picks the Stripe call shape at request time. **Migration to MoR for an existing offer is a single `UPDATE` plus a new revenue-share row; no schema migration, no redeploy.**

### 5.3 What MoR adds operationally

- **Tax engine.** Stripe Tax on the platform account (TGP). Sales-tax nexus map maintained by the finance owner (§17). Spec assumes Stripe Tax is the engine; an Avalara replacement is out of scope and not blocking.
- **Invoicing.** TGP-branded invoices (PDF) are generated by Stripe Invoicing on the platform account.
- **1099 filing.** TGP files for coaches paid >$600/yr off the MoR pool. Stripe Connect handles 1099-K for the Connect path automatically; the MoR path needs a 1099-NEC issued by TGP (handled by Stripe 1099 service; documented in operator runbook).
- **Dispute liability.** TGP carries the chargeback risk on MoR products. We mitigate via §13 fraud rules + payout holds.

### 5.4 Deferred payout (escrow-lite)

For mastermind seats specifically (PR #122 §7 refund window: 14 days before event), the payout to the coach is **held by TGP** until the event-delivered milestone. Implemented as `PLATFORM_MOR_DEFERRED_PAYOUT`: TGP takes the charge, holds the funds in TGP's Stripe account, and only fires the transfer to the coach after `Cohort.event_delivered_at` is set. If the event is cancelled, refund is one-step and TGP is never out-of-pocket.

This is **not** a money-services-business activity (no third-party balance, no on-platform balance held for an arbitrary user). TGP holds its own funds until it elects to pay an internal vendor (the coach). Document the position with counsel before flipping the first mastermind to this routing.

## 6. WHERE — modules + tables touched

- **New module:** `src/commerce/` (sibling to `src/billing/`). Subdirectories: `connect/`, `checkout/`, `ledger/`, `webhooks/`.
- **New tables (schema sketch in §8):** `CoachStripeAccount`, `Charge`, `Refund`, `Dispute`, `Payout`, `LedgerEntry`, `CoachPayoutPolicy`. (`Offer` is owned by [`offer-builder.md` §8](./offer-builder.md#8-data-model-sketch); commerce reads from it.)
- **New routes:** `/api/v1/coach/payments/*` (coach-side), `/api/v1/checkout/*` (public client-side), `/api/v1/webhooks/stripe-connect` (separate from existing platform webhook), `/api/v1/owner/commerce/*` (operator).
- **Touches existing:** `src/billing/` only for shared `stripe-signature.ts` helper (extract to `src/common/stripe/`). The per-seat plan stays unchanged.
- **Public pages:** `src/public-pages/` extends with checkout-success, checkout-cancelled, public receipt view.
- **Audit log:** new `AuditLog.action` values enumerated in §11.

## 7. WHO

| Role                  | Responsibility                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sign-off**          | Founder (commercial / risk posture). Backend lead (architectural fit). Counsel (MoR positioning before §5 first-flip).                          |
| **On the hook**       | Backend lead during S1–S2. Founder + backend lead jointly during S3 GA and ongoing.                                                            |
| **Downstream**        | Storefront, offer-builder, application-funnel, affiliate, marketplace specs all depend on this lane being live.                                |
| **Hard boundaries**   | This spec does **not** own: per-seat coach SaaS billing (`src/billing/` keeps it). Marketing copy on `new-website`. Mobile UI for checkout (the route exists; the surface is a follow-up). |
| **Pager owner**       | Backend lead (default). Escalation to founder for any payout hold > $10k or any disputed transaction with no clear resolution.                  |
| **Risk owner (KYC/AML)** | Founder, until finance-ops hire. Named in operator runbook entry on first deploy.                                                              |

## 8. Data model sketch (additive, **not** committed in this PR)

All FKs are concrete; no string-typed pointers. Every coach-scoped table reserves `acted_by_member_user_id` (PR #118 forward-compat).

```prisma
// One per coach, created on first "Start accepting payments" tap.
model CoachStripeAccount {
  id                       String                  @id @default(cuid())
  coach_user_id            String                  @unique  // FK → User.id
  stripe_account_id        String                  @unique  // acct_xxx
  account_type             ConnectAccountType      @default(EXPRESS)
  status                   ConnectStatus           @default(PENDING)
  charges_enabled          Boolean                 @default(false)
  payouts_enabled          Boolean                 @default(false)
  details_submitted        Boolean                 @default(false)
  requirements_currently_due Json?                  // mirror of Stripe `requirements`
  default_currency         String                  @default("usd")
  country                  String                  // ISO-3166-1 alpha-2
  created_at               DateTime                @default(now())
  verified_at              DateTime?
  last_synced_at           DateTime?
  // Forward-compat
  acted_by_member_user_id  String?
  coach                    User                    @relation(fields: [coach_user_id], references: [id], onDelete: Cascade)
  charges                  Charge[]
  payouts                  Payout[]
}

enum ConnectAccountType {
  EXPRESS
  CUSTOM        // reserved; not used in S1
}

enum ConnectStatus {
  PENDING
  VERIFIED
  RESTRICTED    // Stripe wants more info
  REJECTED      // KYC failed; cannot accept payments
  DISABLED      // operator-suspended
}

// One per successful PaymentIntent. Always written inside the same DB tx that
// records the LedgerEntry. Stripe is source of truth on amounts, but the row
// is written first (idempotency_key = PaymentIntent.id).
model Charge {
  id                       String                  @id @default(cuid())
  stripe_payment_intent_id String                  @unique
  stripe_charge_id         String?                 @unique
  coach_user_id            String                  // FK → User.id
  customer_user_id         String?                 // FK → User.id; null for anonymous checkout
  customer_email           String                  // captured even for User-rows (replay)
  offer_id                 String?                 // FK → Offer.id (offer-builder spec)
  payment_routing          PaymentRouting          // CONNECT_* | PLATFORM_MOR* (§5.2)
  amount_gross_cents       Int                     // what customer paid
  amount_platform_fee_cents Int                    // TGP take
  amount_processor_fee_cents Int                    // Stripe processing fee, mirrored from Stripe
  amount_tax_cents         Int                     @default(0)
  amount_coach_net_cents   Int                     // = gross − platform_fee − processor_fee − tax_remitted_by_TGP
  currency                 String                  // lowercased ISO-4217
  status                   ChargeStatus
  failure_code             String?
  failure_message          String?
  paid_at                  DateTime?
  created_at               DateTime                @default(now())
  // Forward-compat
  acted_by_member_user_id  String?
  coach                    User                    @relation("ChargeCoach", fields: [coach_user_id], references: [id])
  customer                 User?                   @relation("ChargeCustomer", fields: [customer_user_id], references: [id])
  refunds                  Refund[]
  disputes                 Dispute[]
  ledger_entries           LedgerEntry[]
  @@index([coach_user_id, created_at])
  @@index([offer_id])
  @@index([customer_user_id])
}

enum ChargeStatus {
  REQUIRES_ACTION   // 3DS, etc.
  PROCESSING
  SUCCEEDED
  FAILED
  REFUNDED
  PARTIALLY_REFUNDED
  DISPUTED
}

enum PaymentRouting {
  CONNECT_DESTINATION_CHARGE
  CONNECT_DIRECT_CHARGE
  PLATFORM_MOR
  PLATFORM_MOR_DEFERRED_PAYOUT
}

model Refund {
  id                       String                  @id @default(cuid())
  stripe_refund_id         String                  @unique
  charge_id                String                  // FK → Charge.id
  initiated_by_user_id     String                  // FK → User.id (who clicked refund)
  reason                   RefundReason
  amount_cents             Int
  currency                 String
  status                   RefundStatus
  external_note            String?                 @db.Text  // shown to customer
  internal_note            String?                 @db.Text  // operator-only
  created_at               DateTime                @default(now())
  resolved_at              DateTime?
  charge                   Charge                  @relation(fields: [charge_id], references: [id])
}

enum RefundReason {
  REQUESTED_BY_CUSTOMER
  DUPLICATE
  FRAUDULENT
  COACH_GOODWILL
  CHARGEBACK_LOST
  OPERATOR_OVERRIDE
}

enum RefundStatus {
  PENDING
  SUCCEEDED
  FAILED
  CANCELED
}

model Dispute {
  id                       String                  @id @default(cuid())
  stripe_dispute_id        String                  @unique
  charge_id                String                  // FK → Charge.id
  reason                   String                  // Stripe reason code
  status                   DisputeStatus
  amount_cents             Int
  currency                 String
  evidence_due_by          DateTime?
  evidence_submitted_at    DateTime?
  outcome                  String?                 // 'won' | 'lost' | 'warning_closed' | etc.
  liability_owner          DisputeLiabilityOwner   // who pays if we lose
  created_at               DateTime                @default(now())
  charge                   Charge                  @relation(fields: [charge_id], references: [id])
}

enum DisputeStatus {
  WARNING_NEEDS_RESPONSE
  WARNING_UNDER_REVIEW
  WARNING_CLOSED
  NEEDS_RESPONSE
  UNDER_REVIEW
  WON
  LOST
}

enum DisputeLiabilityOwner {
  COACH        // CONNECT_DESTINATION_CHARGE default
  PLATFORM     // PLATFORM_MOR; opt-in for high-ticket destination charges
}

// Pure double-entry-style ledger. Every money event writes a pair (or more) of rows.
model LedgerEntry {
  id                       String                  @id @default(cuid())
  occurred_at              DateTime                @default(now())
  charge_id                String?                 // FK → Charge.id
  refund_id                String?                 // FK → Refund.id
  payout_id                String?                 // FK → Payout.id
  account                  LedgerAccount           // see enum
  coach_user_id            String?                 // null for platform-side rows
  amount_cents             BigInt                  // positive = credit, negative = debit, in 'currency'
  currency                 String
  category                 LedgerCategory
  description              String                  @db.Text
  external_ref             String?                 // stripe id, etc.
  charge                   Charge?                 @relation(fields: [charge_id], references: [id])
  refund                   Refund?                 @relation(fields: [refund_id], references: [id])
  payout                   Payout?                 @relation(fields: [payout_id], references: [id])
  @@index([coach_user_id, occurred_at])
  @@index([account, occurred_at])
}

enum LedgerAccount {
  COACH_REVENUE
  COACH_RECEIVABLE       // recognised before payout settles
  COACH_REFUNDS
  COACH_CHARGEBACKS
  PLATFORM_FEE
  PROCESSOR_FEE
  TAX_REMITTED
  PLATFORM_RESERVE       // held for deferred payout (§5.4)
  CASH                   // money in/out of TGP's Stripe account
}

enum LedgerCategory {
  CHARGE
  REFUND
  CHARGEBACK
  PAYOUT
  TAX
  ADJUSTMENT
  RECONCILIATION
}

// Mirror of Stripe payouts to the coach's bank.
model Payout {
  id                       String                  @id @default(cuid())
  stripe_payout_id         String                  @unique
  coach_stripe_account_id  String                  // FK
  amount_cents             Int
  currency                 String
  status                   PayoutStatus
  arrived_at               DateTime?
  failure_code             String?
  failure_message          String?
  created_at               DateTime                @default(now())
  account                  CoachStripeAccount      @relation(fields: [coach_stripe_account_id], references: [id])
  ledger_entries           LedgerEntry[]
}

enum PayoutStatus {
  PENDING
  IN_TRANSIT
  PAID
  FAILED
  CANCELED
}

// Coach-level operator overrides on payout cadence + holds.
model CoachPayoutPolicy {
  coach_user_id            String                  @id   // FK → User.id
  hold_payouts             Boolean                 @default(false)  // operator kill-switch
  hold_reason              String?                 @db.Text
  payout_schedule          PayoutSchedule          @default(STRIPE_DEFAULT)
  reserve_pct              Int                     @default(0)      // basis-point reserve held by platform
  updated_by_user_id       String?
  updated_at               DateTime                @updatedAt
}

enum PayoutSchedule {
  STRIPE_DEFAULT       // weekly, Stripe-managed
  MANUAL               // operator releases each payout
  DAILY
  WEEKLY
  MONTHLY
}
```

### 8.1 Retention

| Table                | Retention                      | GDPR scrub?                                                                 |
| -------------------- | ------------------------------ | --------------------------------------------------------------------------- |
| `CoachStripeAccount` | Lifetime of coach + 7y         | Pseudonymise email; keep `stripe_account_id` for audit. (Tax-record minimum) |
| `Charge`             | 7y (US tax + AML retention)    | Drop `customer_email` on right-to-erasure; keep amounts + IDs.              |
| `Refund`             | 7y                             | Drop `external_note` if PII; keep amounts.                                  |
| `Dispute`            | 7y                             | Drop free-text evidence if PII-rich; keep outcome.                          |
| `LedgerEntry`        | **Never deleted**              | Pseudonymise `description`. Ledger integrity > GDPR for tax records (consult counsel). |
| `Payout`             | 7y                             | No customer PII present; keep as-is.                                        |
| `CoachPayoutPolicy`  | Lifetime of coach              | Drop `hold_reason` if PII.                                                  |

The retention rules slot into the per-table matrix PR #120 lane #04 reserved.

## 9. API sketch + payment routing

> Conventions: snake_case fields. JSON envelopes follow `docs/api-conventions.md`. Throttle tier "L4" (read), "L5" (write money) per PR #120 lane #02.

### 9.1 Coach-facing — onboarding

```
POST /api/v1/coach/payments/account                  → { stripe_account_id, status }
GET  /api/v1/coach/payments/account                  → CoachStripeAccount shape
POST /api/v1/coach/payments/account/onboarding-link  → { url, expires_at }
POST /api/v1/coach/payments/account/refresh          → resync from Stripe
```

Throttle: 6/min/coach. RBAC: `team.payments.manage` (PR #118 permission matrix).

### 9.2 Coach-facing — money

```
GET  /api/v1/coach/payments/charges?cursor=...       → list of recent Charge
GET  /api/v1/coach/payments/charges/:id              → single Charge + ledger trail
POST /api/v1/coach/payments/charges/:id/refund       → body { amount_cents, reason, external_note? }
GET  /api/v1/coach/payments/payouts                  → recent Payout list
GET  /api/v1/coach/payments/balance                  → { available_cents, pending_cents, currency }
GET  /api/v1/coach/payments/disputes                 → list disputes the coach must respond to
POST /api/v1/coach/payments/disputes/:id/evidence    → submit evidence (multipart upload)
```

Throttle: 30/min/coach (read), 6/min/coach (write).

Refund authority rules (enforced at controller):

- Coach can refund within **N days of charge** where N = `Offer.refund_window_days` (default 14, configurable per offer; founder closes the platform default in §20 OQ-1).
- Beyond N days, refund requires OWNER role.
- Coach cannot refund a charge that is already `DISPUTED` — that flows through dispute evidence.

### 9.3 Public client-side — checkout

```
GET  /api/v1/checkout/offer/:slug                    → { offer summary, price, currency, requires_application }
POST /api/v1/checkout/sessions                       → { client_secret | url }
POST /api/v1/checkout/confirm                        → { charge_id, status }
GET  /api/v1/checkout/receipt/:charge_id             → public, link-token-protected receipt JSON
```

Throttle: 30/min/IP (anonymous), 60/min/user (authed). Captcha required on `POST /sessions` for offers with `requires_captcha=true` (default true above $500).

Per-route Stripe call shape (informational):

| Route                   | Connect destination charge                          | Platform MoR                                                |
| ----------------------- | --------------------------------------------------- | ----------------------------------------------------------- |
| `POST /sessions`        | `paymentIntents.create({ transfer_data: { destination: acct }, application_fee_amount: f })` | `paymentIntents.create({ ... })` on platform; transfer to coach is decoupled and lives on `Payout`. |
| `POST /charges/:id/refund` | `refunds.create({ payment_intent, refund_application_fee: true })` | `refunds.create` on platform; `LedgerEntry` clawback against `COACH_RECEIVABLE`. |

### 9.4 Operator-facing

```
GET  /api/v1/owner/commerce/charges                  → cross-coach search
POST /api/v1/owner/commerce/coach/:id/hold-payouts   → set CoachPayoutPolicy.hold_payouts
POST /api/v1/owner/commerce/coach/:id/release-payouts→ clear hold + reason
POST /api/v1/owner/commerce/charges/:id/refund       → operator-override refund (any age)
GET  /api/v1/owner/commerce/ledger?since=...         → ledger export (CSV)
GET  /api/v1/owner/commerce/reconciliation/:date     → drift report vs. Stripe
```

RBAC: `OWNER` only. Audited (§11).

### 9.5 Webhooks

```
POST /api/v1/webhooks/stripe-connect
```

Separate from the existing `/api/v1/webhooks/stripe` (per-seat plan). Different signing secret. Different routing table. Events listened to:

- `account.updated` (KYC progress on coach Connect accounts)
- `payment_intent.succeeded` / `.payment_failed`
- `charge.refunded`
- `charge.dispute.created` / `.updated` / `.closed`
- `payout.created` / `.paid` / `.failed`
- `radar.early_fraud_warning.created`

Idempotency via `StripeProcessedEventConnect` (mirror of existing `StripeProcessedEvent` shape; separated to keep tables small).

## 10. Ledger and reconciliation

### 10.1 Why a TGP-owned ledger

Stripe is **not** a finance system. Stripe gives us facts about money movement, but it does not give us:

- A row keyed by our `Offer.id` we can join against the rest of our schema.
- A view of platform fees by coach for a custom period without paginating thousands of `application_fee` records.
- Idempotency tied to our database transactions (we want "charge succeeded" and "ledger entry written" to commit together or not at all).

The TGP ledger is the system of record for our P&L, coach earnings, take-rate analytics, and reconciliation. Stripe is the system of record for **what actually settled at the bank**. They must agree.

### 10.2 Double-entry-style row pairs

Every money event writes a balanced set of rows. Examples:

**A successful $100 charge with $5 platform fee, $3.20 processor fee, $0 tax (CONNECT_DESTINATION_CHARGE):**

| account            | coach_user_id | amount_cents | category |
| ------------------ | ------------- | ------------ | -------- |
| `CASH`             | null          | +10000       | CHARGE   |
| `COACH_REVENUE`    | <coach>       | +10000       | CHARGE   |
| `PLATFORM_FEE`     | null          | +500         | CHARGE   |
| `PROCESSOR_FEE`    | null          | -320         | CHARGE   |
| `COACH_RECEIVABLE` | <coach>       | -9180        | CHARGE   |

Sum across rows = 0 in CASH minus payable; the receivable resolves on payout.

**On Stripe payout of $9180 to coach:**

| account            | coach_user_id | amount_cents | category |
| ------------------ | ------------- | ------------ | -------- |
| `COACH_RECEIVABLE` | <coach>       | +9180        | PAYOUT   |
| `CASH`             | null          | -9180        | PAYOUT   |

### 10.3 Reconciliation

Nightly job (`commerce.reconcile.daily` BullMQ task):

1. Pull Stripe `BalanceTransaction` list for `now() - 25h`.
2. Match each `BalanceTransaction.id` against `LedgerEntry.external_ref`.
3. Drift cases (any of):
   - Stripe row exists, ledger row does not.
   - Ledger row exists, Stripe row does not.
   - Amounts disagree by >0 cents.
4. Write `LedgerEntry` rows with category `RECONCILIATION` for each drift, alarm to PagerDuty if drift > $50 in a 24h window.
5. Daily drift report appended to `docs/admin-reports.md` mechanism (existing).

### 10.4 Replay tooling

Operator script `npx ts-node scripts/commerce/replay-stripe-event.ts <stripe_event_id>` re-fetches the event from Stripe and re-runs the webhook handler idempotently. Used when a webhook was missed (network blip) or for backfilling.

## 11. Tax, refund, chargeback, dispute

### 11.1 Tax

- **Connect destination charges (default):** Coach is merchant of record. Sales tax is the coach's problem. We surface a "Tax behavior" knob on `Offer.tax_behavior` (`inclusive` | `exclusive` | `unspecified`) and pass through to Stripe but **we do not file**.
- **Platform MoR:** TGP files. Stripe Tax on the platform account computes destination-based US sales tax and EU VAT. Nexus map maintained by finance owner.
- **Tax IDs:** Customer can provide a tax ID (VAT, ABN, etc.) on the checkout page; stored encrypted on `Charge.tax_id_encrypted` (out of S1; reserve column).

### 11.2 Refund rules

| Path                               | Window default        | Coach can refund?           | Operator can override? |
| ---------------------------------- | --------------------- | --------------------------- | ---------------------- |
| Connect destination, normal offer  | 14d (configurable)    | Yes, within window          | Yes, any age           |
| Connect destination, application-required offer | Per-offer       | Yes, within window          | Yes                    |
| Platform MoR, mastermind seat      | Per PR #122 §7        | Coach **requests**; OWNER approves | Yes                |
| Platform MoR, marketplace template | 7d, no questions      | N/A (TGP self-serves)       | Yes                    |

Application-fee handling: by default the platform fee is also refunded pro-rata (`refund_application_fee: true`). Operator can override per-refund.

### 11.3 Chargebacks

- **Connect destination:** liability is on the **coach**. We deduct the disputed amount + Stripe dispute fee from the coach's `COACH_RECEIVABLE` immediately. If the coach has insufficient balance, we flip `CoachPayoutPolicy.hold_payouts=true` and surface a "negative balance" banner in their console until resolved.
- **Platform MoR:** liability is on **TGP**. Operator owns the response.
- **Evidence flow:** TGP UI lets the coach (Connect path) or operator (MoR path) submit text + receipts to the dispute. The submission is forwarded to Stripe before `evidence_due_by`. We never auto-submit blank evidence.

### 11.4 Chargeback fee schedule

Stripe charges $15 per dispute regardless of outcome. We pass it through to the coach on Connect path; absorb it on MoR path.

## 12. RBAC, privacy, GDPR scrub

- **Tenant boundary:** every commerce table joins to `coach_user_id` (or for ledger, `coach_user_id` is sometimes null for platform rows). Row-level guard enforces `coach.id == request.coach.id` unless OWNER. PR #120 lane #03 boundary contract.
- **Customer privacy:** `Charge.customer_email` is the only PII row. On right-to-erasure, the email is pseudonymised (`deleted-customer-{hash}@deleted.tgp.app`), the `customer_user_id` is nulled. The `Charge` row itself is preserved for tax retention.
- **Coach privacy from operator:** OWNER can read all commerce data without per-coach approval (operational necessity). Reads against another coach's data write `AuditLog` rows.
- **GDPR scrub coverage:** scrub job adds a per-table handler for the four PII-bearing tables. PR #120 lane #04 retention matrix entries above are the contract.
- **Data export:** coach can export their charges + ledger as CSV from the console, signed link, scoped to their `coach_user_id`. Throttle: 1 export / 5 min.

### 12.1 Audit log additions

New `AuditLog.action` values (added to the vocab when this lane lands):

```
COMMERCE_ACCOUNT_CREATED
COMMERCE_ACCOUNT_VERIFIED
COMMERCE_CHARGE_SUCCEEDED
COMMERCE_REFUND_INITIATED
COMMERCE_REFUND_OPERATOR_OVERRIDE
COMMERCE_DISPUTE_OPENED
COMMERCE_DISPUTE_EVIDENCE_SUBMITTED
COMMERCE_DISPUTE_RESOLVED
COMMERCE_PAYOUT_HELD
COMMERCE_PAYOUT_RELEASED
COMMERCE_LEDGER_RECONCILE_DRIFT
COMMERCE_OFFER_ROUTING_CHANGED
```

## 13. Abuse, fraud, moderation

Concrete primitives, not aspirations.

### 13.1 At-checkout

- **Stripe Radar.** Default rule set on the platform account; allowlist explicit whales. On Connect path the coach's account inherits.
- **3DS for cards over $500.** Default-on; coach cannot disable.
- **CAPTCHA.** Default on offers > $500 or with `requires_captcha=true`. hCaptcha; existing infra.
- **Rate limit per IP per offer.** 5 checkout sessions / 10 min / IP / offer. 429 with retry-after.
- **Email-domain blocklist.** Disposable email domains rejected by default; can be allowlisted per coach by OWNER.

### 13.2 At-payout

- **Velocity hold.** New coaches with no payment history have a 7-day rolling hold on their first $5k of payouts. Auto-released after 7 days clean.
- **Reserve.** OWNER can set `CoachPayoutPolicy.reserve_pct` to hold a basis-point fraction of every payout for N days as a chargeback buffer.
- **Hard hold.** OWNER click flips `hold_payouts=true`. Coach sees a banner; payouts resume on release.

### 13.3 Refund-abuse signal

A coach with a 30-day refund rate >25% triggers a review queue entry. Refund rate is `count(refunds_30d) / count(charges_30d)`. Threshold tunable by OWNER.

### 13.4 Chargeback rate

Coach with 30-day chargeback rate >0.75% is auto-flagged; >1.5% triggers automatic `hold_payouts=true` until manual review. Stripe disables accounts at 1%; we want a buffer.

## 14. Feature flags + entitlements

| Flag                      | Default | Scope                                        | Kill-switch effect                                                                   |
| ------------------------- | ------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `COMMERCE_CHECKOUT_ENABLED` | `false` | Global. Per-coach override via entitlement.  | All `/api/v1/checkout/*` and `/api/v1/coach/payments/*` return 503. Webhook continues to log. |
| `COMMERCE_CONNECT_ONBOARDING_ENABLED` | `false` | Global.                          | Coach onboarding link returns 503; existing accounts continue to operate.            |
| `COMMERCE_MOR_ROUTING_ENABLED` | `false` | Global. Per-`Offer.payment_routing` row.     | New offers with `PLATFORM_MOR*` routing are blocked at create time; existing rows continue. |
| `COMMERCE_PAYOUTS_GLOBAL_HOLD` | `false` | Operator emergency knob.                  | All payouts pause; charges continue; reconciliation continues.                       |

Entitlement gate (PR #120 lane #01 + PR #123 row #37):

- `commerce.checkout.basic` — Connect destination, single offer, no MoR. Granted at L1.
- `commerce.checkout.advanced` — multi-offer, application-required, affiliate. Granted at L2.
- `commerce.checkout.mor` — MoR routing for high-ticket / mastermind. Granted at L3 + manual OWNER flip per coach.

## 15. Tests

Test names below are concrete; runtime PR adds them.

### 15.1 Unit (Jest)

- `connect.service.spec.ts` — onboarding link expiry, status transitions, Stripe error mapping.
- `checkout.service.spec.ts` — destination vs. MoR routing pick, fee math (with rounding edge cases), 3DS path, idempotency on duplicate `POST /sessions`.
- `ledger.service.spec.ts` — every category writes a balanced row set; refund clawbacks balance; deferred payout transitions release.
- `webhook.handler.spec.ts` — 401 on bad signature, idempotent on duplicate event id, replay produces zero-side-effect.
- `refund.policy.spec.ts` — within-window pass, beyond-window OWNER-only, dispute-blocks-refund.
- `fraud.signal.spec.ts` — refund-rate threshold, chargeback-rate threshold, velocity hold release.

### 15.2 Integration (real DB, Stripe mock)

- Full destination charge happy path, including `payment_intent.succeeded` webhook + `LedgerEntry` writes.
- Full refund happy path with application-fee refund.
- Dispute opened → evidence submitted → won/lost paths each branch.
- Operator hold-payouts blocks a payout the next day.
- Reconciliation job with intentional drift produces a drift report and PagerDuty.
- MoR routing — full charge → no immediate transfer → manual transfer triggers payout row.

### 15.3 Contract (against pinned Stripe API version)

- Replay the recorded webhook fixtures from PR #53 (per-seat plan) — proves we did not break the existing webhook.
- New fixtures: account.updated, payment_intent.succeeded (Connect), charge.dispute.created, payout.paid.

### 15.4 Smoke (staging)

- End-to-end via Stripe test cards: `4242…` succeeds, `4000…0341` requires 3DS, `4000…0259` triggers dispute, `4000…0119` charge succeeds then disputes 5 min later via Radar.
- Verify a charge in staging: ledger row, Stripe API agrees, reconciliation report shows zero drift the next morning.

### 15.5 Load

- 100 concurrent checkout sessions / minute against staging — assert p95 < 600ms, no row-level lock contention on ledger.

## 16. International + multi-currency readiness

S1 ships **USD only**. Schema supports `currency` from day 0 (already on `Charge`, `LedgerEntry`, `Payout`). To add a new currency:

1. Stripe Connect must support payouts in the coach's country. Maintained matrix in operator runbook.
2. New offers can be priced in the new currency; existing offers do not auto-migrate.
3. Reconciliation report becomes per-currency.
4. Tax engine rule set extended (Stripe Tax handles automatically for standard cases).

VAT / GST handling for EU/UK/AU buyers on **MoR** offers is an S2 deliverable, blocked on counsel review of nexus position.

## 17. Risks

| Risk                                          | Mitigation                                                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Stripe denies the platform application        | Multi-week external. File early. Have a back-pocket plan: ship per-seat-only path until approval (current state).                              |
| Coach KYC fails                               | Surface clear error + retry path; OWNER can also escalate to Stripe support on coach's behalf.                                                |
| Webhook race / replay                         | Idempotency on `StripeProcessedEventConnect.event_id`; replay tool documented (§10.4).                                                        |
| Ledger drift                                  | Nightly reconciliation; PagerDuty if drift > $50/24h; replay tool.                                                                            |
| Refund / chargeback abuse                     | §13 fraud signals; coach must ack policy before activation; evidence bot files default response if coach is unresponsive 48h before deadline. |
| Coach negative balance                        | `hold_payouts=true` auto on negative; banner + reconciliation flow; OWNER can clear or write off.                                              |
| Stripe API breakage on version bump           | Pinned API version; contract tests; no auto-bump in CI; operator runbook covers the bump.                                                     |
| Currency rounding error                       | `BigInt` ledger amounts in cents; never floats; per-row test for rounding edges.                                                              |
| MoR tax exposure (sales tax nexus)            | Stripe Tax + finance owner maintains nexus map; counsel review before flipping first MoR offer.                                                |
| Money-services-business (MSB) classification  | Deferred-payout (§5.4) **never** holds third-party balances; counsel review before first deferred flip.                                       |
| GDPR vs. tax retention conflict               | Pseudonymise on RTBE; never delete `LedgerEntry`; documented in §8.1 and PR #120 lane #04.                                                    |
| Operator footgun on `COMMERCE_PAYOUTS_GLOBAL_HOLD` | Two-OWNER acknowledgement required to flip; documented in operator runbook.                                                              |

## 18. Dependencies

### Internal (other roadmap rows)

- **#41 (this) → #40, #42, #43, #44, #45.** All five depend on the connected-account model and the platform-fee shape.
- **#37 tiering L2/L3 (PR #123)** for entitlement gating.
- **#20 platform-readiness lane #05 (billing packaging)** for take-rate shape.
- **#02 Team Mode (PR #118)** for `acted_by_member_user_id` setter attribution.

### External

- **Stripe Connect platform approval.** Long-pole, external.
- **Stripe Tax** account-level activation (MoR path only, S2).
- **hCaptcha** (existing infra) for checkout abuse.
- **PagerDuty** for reconciliation drift alerts (existing).

### Human

- Founder closes §20 OQ-1 (default refund window) and §20 OQ-2 (dispute liability default for >$2k destination charges).
- Counsel reviews MoR positioning before §5 first-flip.
- Finance ops hire (or founder placeholder) named as KYC/AML risk owner.

## 19. Acceptance criteria

A future runtime PR series can call this lane "shipped" when **all** of:

1. Coach can complete onboarding from "Start accepting payments" tap to `status='verified'` in ≤2 minutes for a US-based individual on a happy path (smoke test).
2. A test charge against `4242 4242 4242 4242` writes a `Charge` row, a balanced `LedgerEntry` set, and lands in coach's Stripe Express dashboard.
3. Coach can refund within window with one button-click; refund writes its `Refund` row and balanced ledger clawback.
4. Operator can hold + release payouts on a coach with one button-click; the action writes `AuditLog`.
5. Webhook `/api/v1/webhooks/stripe-connect` is idempotent on duplicate events; a replayed event produces zero side-effects.
6. Nightly reconciliation runs in staging for 7 consecutive nights with zero drift > $0.
7. Per-route Stripe API version pinned + contract tests green.
8. PR #118 forward-compat column `acted_by_member_user_id` present on every new coach-scoped table.
9. PR #120 lane #03 RBAC contract green; PR #120 lane #04 retention contract green.
10. Operator runbook entry merged: kill-switches, replay tool, drift dashboard, MoR-flip checklist.
11. Founder + backend lead sign-off on §20 OQs.
12. Counsel sign-off on §5 MoR positioning before first MoR offer is created.

## 20. Operator handoff

### 20.1 Kill-switches

| Knob                                       | Effect                                                                                  | Authority         |
| ------------------------------------------ | --------------------------------------------------------------------------------------- | ----------------- |
| `COMMERCE_CHECKOUT_ENABLED=false`          | All checkout + coach payments routes 503. Webhooks still log.                          | OWNER, redeploy.  |
| `COMMERCE_CONNECT_ONBOARDING_ENABLED=false`| Onboarding link returns 503; existing verified accounts continue.                       | OWNER, redeploy.  |
| `COMMERCE_PAYOUTS_GLOBAL_HOLD=true`        | All payouts pause; charges continue.                                                    | Two-OWNER ack.    |
| `CoachPayoutPolicy.hold_payouts=true`      | This coach's payouts pause; charges continue.                                           | OWNER, one click. |
| `Offer.status='paused'`                    | One offer's checkout returns 410; existing customers untouched.                          | Coach or OWNER.   |

### 20.2 Dashboards

- **Grafana / commerce overview.** GMV by coach, take-rate, refund rate, chargeback rate, p95 webhook latency, p95 reconciliation lag.
- **PostHog / commerce funnel.** offer view → checkout start → checkout complete → activated. Drop-off chart per coach.
- **Drift dashboard.** Per-day drift > $0 ledger entries; alarm > $50/24h.

### 20.3 Runbook entries (added under `docs/`)

- `docs/commerce/operator-onboarding.md` — first-time platform setup, Stripe Connect platform application, env vars, smoke-charge.
- `docs/commerce/refund-runbook.md` — refund authority matrix, chargeback evidence flow, MoR refund approval gate.
- `docs/commerce/reconciliation-runbook.md` — drift triage, replay tool, end-of-month close.
- `docs/commerce/mor-flip-checklist.md` — counsel sign-off, tax engine, 1099 service, deferred-payout setup.
- `docs/commerce/incident-runbook.md` — webhook outage, Stripe outage, Connect platform suspension.

### 20.4 Alerts (PagerDuty)

| Alert                                             | Threshold                                              | On-call action                                                                |
| ------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `commerce.webhook.failure.5xx`                    | >2% over 10 min                                        | Check Stripe status; redeploy if app-side; replay missed events post-recovery. |
| `commerce.reconcile.drift`                        | >$50 in 24h                                            | Open drift report; replay missing events; if structural, escalate to founder.  |
| `commerce.coach.chargeback_rate`                  | Coach 30d > 1.5%                                       | Auto: hold_payouts=true. Operator: notify coach, manual review.                |
| `commerce.account.kyc_restricted_burst`           | >5 coaches restricted in 24h                           | Likely Stripe-side issue; escalate to Stripe support.                          |
| `commerce.payout.failed`                          | Single failed payout > $10k                            | Operator confirms with coach (bank closure, etc.); reissue or hold.            |

## 20-bis. Open questions (must close before first runtime PR)

- **OQ-1** Default refund window for a Connect destination offer. Founder bias: 14d. Operator bias: 7d. **Owner: founder.**
- **OQ-2** Dispute liability default for Connect destination charges > $2k. Liability stays on coach (default Connect behaviour) vs. opt-in PLATFORM liability for the coach's protection at a higher take-rate. **Owner: founder + backend lead jointly.**

## 21. The smallest first runtime PR

(Sketch — runtime PR opens after this spec is accepted.)

**S1 PR-1: scaffolding only.** New `src/commerce/` module, `CoachStripeAccount` migration, Connect onboarding endpoints (no charges yet). All other commerce routes return 503 behind `COMMERCE_CHECKOUT_ENABLED=false`. ~600 LOC, reviewable in <1h. Tests: connect.service.spec.ts.

**S1 PR-2:** `Charge` + `LedgerEntry` tables; checkout sessions for a single hard-coded test offer; webhook routing. `COMMERCE_CHECKOUT_ENABLED=false`; OWNER-only entitlement to use it.

**S1 PR-3:** Refund flow + dispute mirror.

**S1 PR-4:** Reconciliation job + drift dashboard.

**S2 PR-5:** First flip of `COMMERCE_CHECKOUT_ENABLED=true` for a small set of pilot coaches. Per-coach entitlement gate. Smoke charges in production.

**S2 PR-6+:** MoR routing column + first MoR offer (mastermind seat).

Each PR is independently mergeable, deployable, and revertable. Each lands behind its own narrow scope.
