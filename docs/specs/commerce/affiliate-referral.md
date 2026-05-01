# Spec: Affiliate / Referral System

> **Status:** Draft — docs only. Roadmap row #44. No runtime, schema, env-var, or module-wiring change in this PR.
>
> Read [`payments-checkout.md`](./payments-checkout.md), [`coach-storefronts.md`](./coach-storefronts.md), [`offer-builder.md`](./offer-builder.md), and [`application-funnel.md`](./application-funnel.md) first.

## 1. Cross-references

- **PR #117** AI Program Builder — adjacent, no overlap.
- **PR #118** Team Mode — affiliates may be staff (a setter-share variant) or external (a customer who refers).
- **PR #120** lanes #01 (entitlements), #03 (RBAC), #04 (lifecycle), #05 (billing packaging — affiliate share is reserved column on `Offer`).
- **PR #121** spec #29 (revenue dashboard) — affiliate earnings surface there.
- **PR #122** masterminds — §10 hiring + team support; §11 post-event software adoption loop. The L2/L3 affiliate cohort (former students refer new students) is the largest expected affiliate user.
- **PR #123** spec #36 (messaging) — referral DM auto-templates.

## 2. WHY

Coaches grow primarily through word-of-mouth. The two largest channels:

1. **Existing clients** referring friends after their results.
2. **Coach-of-coaches** (e.g. mastermind alumni from PR #122) referring colleagues.

Today this happens informally: a coach gives a discount code by hand, sends a Stripe coupon, or pays a referral fee via Venmo. Untracked, untaxed, and the customer relationship leaks back to the third-party tool that minted the link.

Building an affiliate / referral system inside TGP makes the channel:

- **Trackable** — every offer purchase carries the referrer.
- **Payable on platform** — referrer earns a `LedgerEntry` on the same charge; payouts ride the same `Payout` rail used in [`payments-checkout.md`](./payments-checkout.md).
- **Tax-clean** — for MoR offers, TGP issues 1099s; for Connect offers, the referrer earns through the coach's account and the coach's 1099 covers it (with caveats below).
- **Abuse-resistant** — self-referral, click farms, and incentive cookies are detectable because the chain is in our DB.

### What "shipped" unlocks

- Coach toggles "Referral / affiliate enabled" on an offer.
- Affiliate (whether external person or staff member) gets a unique link.
- Click → cookie → eventual offer purchase ties back; share computed; ledger entry written; payout queued.
- Affiliate dashboard: clicks, conversions, earnings, payout history.
- Coach dashboard: top referrers, conversion rate by source, override rate.

## 3. WHEN

1. ✅ This spec is reviewed and accepted.
2. ✅ [`payments-checkout.md`](./payments-checkout.md), [`offer-builder.md`](./offer-builder.md) at S1 (so `Offer.affiliate_share_bps` exists).
3. ✅ [`application-funnel.md`](./application-funnel.md) accepted (so `shared_by_affiliate_id` slot lines up).
4. ✅ Open questions §20 closed (default cookie window, default minimum payout, on-the-fly self-referral policy).

## 4. WHERE

- **New module:** `src/commerce/affiliates/`.
- **New tables:** `Affiliate`, `AffiliateLink`, `AffiliateClick`, `AffiliateConversion`, `AffiliatePayoutBatch`.
- **Touches:** `Offer.affiliate_share_bps` (already reserved), `Charge` (joins via `AffiliateConversion.charge_id`), `Application.shared_by_affiliate_id` (already reserved), `LedgerEntry` (writes affiliate share rows).
- **New routes:** `/api/v1/coach/affiliates/*` (coach-side configuration), `/api/v1/affiliate/*` (affiliate self-service portal), `/r/:code` (public click-tracker), `/api/v1/owner/affiliates/*`.

## 5. WHO

| Role             | Responsibility                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Sign-off         | Founder, backend lead, counsel (1099 / tax positioning).                                                                   |
| On the hook      | Backend lead. Frontend specialist for affiliate portal.                                                                    |
| Downstream       | Revenue dashboard (PR #121 #29) reads affiliate earnings; messaging (PR #123 #36) auto-shares links.                       |
| Hard boundaries  | Does **not** own offer pricing (`offer-builder.md` owns), payouts (`payments-checkout.md` owns).                            |

## 6. WHAT

### Already exists

- Nothing affiliate-specific. `Offer.affiliate_share_bps` column reserved by [`offer-builder.md`](./offer-builder.md) §8.

### Net-new

- The five tables in §8.
- Click → conversion attribution engine.
- Affiliate self-service portal (basic; mobile-friendly SSR HTML and a small JSON API).
- Payout-batch runner.

### Non-goals

- **No multi-tier MLM ("recruit affiliates who recruit affiliates").** Hard no — regulatory + abuse risk too high. One-level referral only.
- **No paid acquisition tracking** (Google Ads conversion API, Meta CAPI). Out of scope this wave; can be a follow-up.
- **No coupon code system in S1.** Coupons land later (separate spec slice). Affiliate links are the only mechanism in S1.
- **No off-platform affiliate payouts.** All payouts via the existing `Payout` rail. If an affiliate has no Stripe Connect account, they accrue but don't payout until they create one (Stripe Connect Express minimal onboarding).

## 7. HOW — phases

- **S0 spec.** Accepted.
- **S1 skeleton.** `Affiliate`, `AffiliateLink`, `AffiliateClick`, `AffiliateConversion` tables. `/r/:code` route. Click attribution. Manual payouts (operator releases). Flag default off.
- **S2 private beta.** `AffiliatePayoutBatch` runner; affiliate self-service portal; affiliate Stripe Connect onboarding (delegated to [`payments-checkout.md`](./payments-checkout.md) Express flow).
- **S3 GA.** Flag-on for entitled coaches.

### 7.1 Smallest first runtime PR

PR-1: `Affiliate` + `AffiliateLink` + `AffiliateClick` + `/r/:code` route only. No conversions yet. ~400 LOC.

### 7.2 Kill-switch

`AFFILIATE_ENABLED=false`: `/r/:code` returns 410 (link broken); affiliate portal returns 503; existing accrued payouts still readable.

## 8. Data model sketch (additive, **not** committed)

```prisma
model Affiliate {
  id                       String                     @id @default(cuid())
  coach_user_id            String                     // FK → User.id (the coach this affiliate refers FOR)
  // The affiliate themselves
  affiliate_user_id        String?                    // FK → User.id; null if external (just an email)
  external_email           String?                    // present iff affiliate_user_id null
  external_name            String?
  // Connect account for payouts (delegates to CoachStripeAccount-style row but tagged for affiliate use)
  stripe_account_id        String?                    // acct_xxx
  status                   AffiliateStatus            @default(PENDING)
  // Default share (overridable per AffiliateLink)
  default_share_bps        Int                        // basis points of gross
  // Operator gates
  hold_payouts             Boolean                    @default(false)
  hold_reason              String?                    @db.Text
  // Forward-compat
  acted_by_member_user_id  String?
  created_at               DateTime                   @default(now())
  updated_at               DateTime                   @updatedAt
  coach                    User                       @relation("AffiliateCoach", fields: [coach_user_id], references: [id])
  affiliate                User?                      @relation("AffiliateUser", fields: [affiliate_user_id], references: [id])
  links                    AffiliateLink[]
  conversions              AffiliateConversion[]
  payout_batches           AffiliatePayoutBatch[]
  @@unique([coach_user_id, affiliate_user_id])     // one row per coach×affiliate-user
  @@unique([coach_user_id, external_email])         // one row per coach×external email
  @@index([affiliate_user_id, status])
}

enum AffiliateStatus {
  PENDING                  // invited, not yet onboarded
  ACTIVE
  PAUSED                   // affiliate or coach paused
  SUSPENDED                // operator suspended (abuse)
  REVOKED                  // hard-removed; links 410
}

model AffiliateLink {
  id                       String                     @id @default(cuid())
  affiliate_id             String
  // Optional offer-scope. Null = applies to any offer of the coach (coach-wide).
  offer_id                 String?
  // Slug is the public part — short and shareable
  code                     String                     @unique  // e.g. "joey-123"
  // Override default share when present
  share_bps_override       Int?
  // Cookie window (override of platform default)
  cookie_window_days       Int?
  // Lifecycle
  status                   AffiliateLinkStatus        @default(ACTIVE)
  created_at               DateTime                   @default(now())
  archived_at              DateTime?
  affiliate                Affiliate                  @relation(fields: [affiliate_id], references: [id])
  clicks                   AffiliateClick[]
  conversions              AffiliateConversion[]
  @@index([affiliate_id, status])
  @@index([offer_id])
}

enum AffiliateLinkStatus {
  ACTIVE
  ARCHIVED
  REVOKED                   // operator + abuse-related
}

model AffiliateClick {
  id                       String                     @id @default(cuid())
  link_id                  String
  occurred_at              DateTime                   @default(now())
  // Anonymous; rotated 30d like StorefrontVisit
  visitor_anonymous_id     String
  ip_country               String?
  device_kind              String?
  user_agent_family        String?
  referrer                 String?
  utm_source               String?
  utm_medium               String?
  utm_campaign             String?
  // For abuse triage
  is_bot_score             Float?                     // 0..1; from server-side heuristics
  link                     AffiliateLink              @relation(fields: [link_id], references: [id], onDelete: Cascade)
  @@index([link_id, occurred_at])
  @@index([visitor_anonymous_id])
}

model AffiliateConversion {
  id                       String                     @id @default(cuid())
  affiliate_id             String
  link_id                  String                     // the click that converted
  charge_id                String                     @unique  // FK → Charge.id
  // Snapshot at conversion time (the share rate is fixed at conversion, never retroactive)
  share_bps_snapshot       Int
  share_amount_cents       Int
  currency                 String
  // Lifecycle
  status                   AffiliateConversionStatus  @default(PENDING_HOLD)
  hold_until               DateTime                   // = charge.paid_at + refund_window_days
  available_at             DateTime?
  paid_out_in_batch_id     String?                    // FK → AffiliatePayoutBatch.id
  reversed_at              DateTime?
  reversed_reason          String?
  affiliate                Affiliate                  @relation(fields: [affiliate_id], references: [id])
  link                     AffiliateLink              @relation(fields: [link_id], references: [id])
  payout_batch             AffiliatePayoutBatch?      @relation(fields: [paid_out_in_batch_id], references: [id])
  @@index([affiliate_id, status, hold_until])
}

enum AffiliateConversionStatus {
  PENDING_HOLD             // awaiting refund window to elapse
  AVAILABLE                // ready to be batched
  PAID                     // included in a payout
  REVERSED                 // refund/dispute clawback
}

model AffiliatePayoutBatch {
  id                       String                     @id @default(cuid())
  affiliate_id             String
  status                   PayoutBatchStatus          @default(BUILDING)
  total_amount_cents       Int
  currency                 String
  scheduled_for            DateTime
  stripe_transfer_id       String?                    // post-Stripe call
  created_at               DateTime                   @default(now())
  released_at              DateTime?
  affiliate                Affiliate                  @relation(fields: [affiliate_id], references: [id])
  conversions              AffiliateConversion[]
}

enum PayoutBatchStatus {
  BUILDING
  READY
  IN_TRANSIT
  PAID
  FAILED
  CANCELED
}
```

### 8.1 Retention

| Table                  | Retention                       | GDPR scrub                                                                 |
| ---------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| `Affiliate`            | Lifetime + 7y for tax records   | Pseudonymise email/name on RTBE; keep aggregate.                           |
| `AffiliateLink`        | Lifetime                        | None.                                                                      |
| `AffiliateClick`       | **30 days** rolling             | Anonymous; keep counts, drop fingerprint.                                  |
| `AffiliateConversion`  | 7y (tax)                        | None on PII (no PII present); preserve for ledger.                          |
| `AffiliatePayoutBatch` | 7y                              | None.                                                                      |

## 9. API sketch + payment routing

### 9.1 Coach-facing — affiliate management

```
POST   /api/v1/coach/affiliates                       → invite an affiliate (email or by user id)
GET    /api/v1/coach/affiliates                       → list
GET    /api/v1/coach/affiliates/:id                   → single + links + recent conversions
POST   /api/v1/coach/affiliates/:id/pause             → status=PAUSED
POST   /api/v1/coach/affiliates/:id/resume            → status=ACTIVE
POST   /api/v1/coach/affiliates/:id/revoke            → status=REVOKED (links 410)
POST   /api/v1/coach/affiliates/:id/links             → mint a new link (per-offer or coach-wide)
PATCH  /api/v1/coach/affiliates/:id/links/:lid        → update share_bps_override / cookie_window
DELETE /api/v1/coach/affiliates/:id/links/:lid        → archive
GET    /api/v1/coach/affiliates/dashboard             → top referrers, conversions, ROI
```

Throttle: 30/min/coach. RBAC: `team.affiliates.manage`.

### 9.2 Affiliate self-service

```
GET    /api/v1/affiliate/me                           → my coach×affiliate rows
GET    /api/v1/affiliate/me/links                     → my links across all coaches
GET    /api/v1/affiliate/me/conversions               → list with status
GET    /api/v1/affiliate/me/earnings                  → pending / available / paid totals per currency
POST   /api/v1/affiliate/me/payouts/request           → ad-hoc payout request (S2)
POST   /api/v1/affiliate/me/connect/onboard           → reuse Connect Express flow from payments-checkout.md
```

Authentication: same as the rest of the app (the affiliate is a `User`).

### 9.3 Public click tracker

```
GET   /r/:code                                        → 302 to either the offer page, the storefront, or the application form
                                                         Sets a `tgp_aff_<coach_id>` cookie carrying the click_id (HttpOnly, SameSite=Lax, 30d default)
```

Throttle: 60/min/IP.

Cookie carries `(click_id, link_id, expires_at)`. On checkout, the cookie is read and `AffiliateConversion` is created in the same DB tx as `Charge`. Two cookies for the same coach prefer the **last-touch** by default (open question OQ-1).

Cross-device: registered users (logged in) attribute even without the cookie if they clicked the link from an authenticated session within the cookie window.

### 9.4 Operator

```
GET   /api/v1/owner/affiliates                        → cross-coach search
POST  /api/v1/owner/affiliates/:id/suspend            → status=SUSPENDED, reason
GET   /api/v1/owner/affiliates/payout-batches         → list, release, cancel
POST  /api/v1/owner/affiliates/payout-batches/:id/release → trigger Stripe transfer
POST  /api/v1/owner/affiliates/conversions/:id/reverse  → forced clawback (e.g. fraud)
```

### 9.5 Payment routing for affiliate share

| Offer routing                                | Affiliate share booked from                                                                  | Affiliate paid by                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `CONNECT_DESTINATION_CHARGE`                 | **Coach's** net (after platform fee + processor fee). Coach earnings drop by the share.       | Stripe transfer from coach's connected account to affiliate's. |
| `CONNECT_DIRECT_CHARGE`                      | Coach's net.                                                                                  | Same as above.                                                  |
| `PLATFORM_MOR`                               | TGP's gross (before coach revenue-share). Coach's revenue-share is computed on net of affiliate share. | Stripe transfer from TGP platform account.                     |
| `PLATFORM_MOR_DEFERRED_PAYOUT`               | Reserved against TGP's `PLATFORM_RESERVE` ledger account; same release trigger as the coach's main payout. | Same as `PLATFORM_MOR`.                                          |

Ledger row pattern on Connect destination charge:

| account            | coach_user_id | amount_cents | category    |
| ------------------ | ------------- | ------------ | ----------- |
| `COACH_REVENUE`    | <coach>       | +10000       | CHARGE      |
| `PLATFORM_FEE`     | null          | +500         | CHARGE      |
| `PROCESSOR_FEE`    | null          | -320         | CHARGE      |
| `COACH_RECEIVABLE` | <coach>       | -8180        | CHARGE      |
| `COACH_REVENUE`    | <coach>       | -1000        | AFFILIATE_SHARE  *(carved out of coach's net)* |
| `AFFILIATE_PAYABLE`| <affiliate>   | +1000        | AFFILIATE_SHARE |

A new `LedgerAccount.AFFILIATE_PAYABLE` value is added (extends the enum from [`payments-checkout.md`](./payments-checkout.md) §8).

## 10. Tax, refund, chargeback, dispute

- **Refund clawback.** A refund within the conversion's `hold_until` reverses the conversion before payout. Reversal after payout creates a debit on the affiliate's next payout batch. If the affiliate has no future earnings, the negative balance is held; operator can write off after 90 days per the operator runbook.
- **Chargeback.** Same as refund clawback. Loss is on whoever the offer's `dispute_liability_owner` says.
- **1099 / tax reporting.** TGP files 1099-NEC for affiliates earning > $600/yr off MoR offers (via Stripe Connect 1099 service). For Connect destination offers, the **coach's** Stripe account already files 1099-NEC for transfers it made — the affiliate gets a 1099 from the coach's account, not from TGP. Documented; counsel review at first GA.

## 11. Ledger and reconciliation

- Conversion creation writes the affiliate-share `LedgerEntry` rows in the same tx as the originating `Charge`.
- Payout-batch release writes the standard payout pair (`AFFILIATE_PAYABLE` debit, `CASH` credit) and writes a `Payout` row for Stripe transfer.
- Reconciliation cron compares `AFFILIATE_PAYABLE` open balance against pending Stripe transfers; drift alarms.

## 12. RBAC, privacy, GDPR scrub

- **Tenant boundary.** `coach_user_id` on every row. Affiliate self-service is scoped by `affiliate_user_id == self`.
- **External affiliates** (no `affiliate_user_id`) — email is the identity. RTBE on registered user pseudonymises but preserves IDs for tax integrity.
- **Click data is anonymous.** No raw IP, no full UA. Country + device-kind only.
- **Coach cannot see another coach's affiliate roster.** Operator can.

### 12.1 Audit log additions

```
AFFILIATE_INVITED
AFFILIATE_ONBOARDED
AFFILIATE_PAUSED
AFFILIATE_REVOKED
AFFILIATE_SUSPENDED                  // operator
AFFILIATE_LINK_CREATED
AFFILIATE_LINK_REVOKED
AFFILIATE_CONVERSION_REVERSED
AFFILIATE_PAYOUT_BATCH_RELEASED
AFFILIATE_PAYOUT_HELD
```

## 13. Abuse, fraud, moderation

- **Self-referral.** Block at attribution time: if `Charge.customer_user_id == Affiliate.affiliate_user_id` (or the same email), conversion is created with `status=REVERSED` and reason `SELF_REFERRAL`. The attribution still records for analytics. (Open question OQ-3 — should we accept self-referrals on the basis of "I told my partner to use my code"? Default: no.)
- **Click farms.** Bot score on `AffiliateClick.is_bot_score`. Conversions tied to clicks above 0.85 bot score are auto-paused for review (review queue entry).
- **Cookie-stuffing.** Click without referrer + headless UA flag → bot-score 1.0; conversion ineligible.
- **Velocity.** New affiliate with > $5k pending earnings inside 7d of `status=ACTIVE` is auto-held for review.
- **Refund abuse.** Affiliate whose 30d conversion-reversal rate > 30% triggers a queue entry; suspension threshold > 50%.

## 14. Feature flags + entitlements

| Flag                                | Default | Effect                                                     |
| ----------------------------------- | ------- | ---------------------------------------------------------- |
| `AFFILIATE_ENABLED`                 | `false` | `/r/:code` 410; portal 503; existing earnings readable.   |
| `AFFILIATE_AUTOPAYOUT_ENABLED`      | `false` | S2 — block automatic batch release; manual only.           |
| `AFFILIATE_SELF_REFERRAL_ALLOWED`   | `false` | Default to OFF; per-coach override (OWNER) per OQ-3.       |

Entitlements:

- `affiliate.basic` — coach-wide affiliate links, manual payouts. L1.
- `affiliate.advanced` — per-offer overrides, custom cookie windows, automatic payouts. L2.

## 15. Tests

### 15.1 Unit

- `attribution.service.spec.ts` — last-touch wins; stale cookie ignored; cross-device authenticated path.
- `share.calculator.spec.ts` — bps math at every routing; rounding edges; affiliate-share-greater-than-coach-net rejected at offer publish.
- `payout-batch.builder.spec.ts` — only `AVAILABLE` conversions included; minimum-payout threshold enforced; multi-currency split.
- `clawback.service.spec.ts` — refund reverses pending; refund post-payout creates debit on next batch.
- `fraud.signals.spec.ts` — self-referral block; bot-score gate; velocity hold.

### 15.2 Integration

- Click → cookie → checkout → conversion → ledger pair → hold → release.
- Refund within hold reverses conversion (no payout).
- Refund post-payout creates negative-balance carryover.
- Operator suspend → links 410 → existing pending earnings preserved.

### 15.3 Smoke

- Daily synthetic click on staging `/r/<canary>` with test card; conversion appears with correct share.

## 16. Risks

| Risk                                         | Mitigation                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Click farms / bot fraud                      | Bot score; velocity hold; review queue.                                                                  |
| Self-referral abuse                          | Default block; per-coach OWNER override per OQ-3.                                                        |
| Negative-balance carryover persists          | 90d operator write-off SOP; low-water-mark threshold for forced reversal.                                |
| 1099 misclassification                       | Counsel review pre-GA; documented matrix per routing.                                                    |
| Cookie loss / Safari ITP                     | Cross-device authenticated attribution; persistent log-in fallback; document the conversion shortfall.   |
| Multi-coach affiliate clashes (one user is affiliate for two coaches that compete) | Default OK; cookie scoped per-coach (`tgp_aff_<coach_id>`).                  |
| Affiliate share > coach net (loss)           | Block at offer publish: `affiliate_share_bps + platform_fee_bps + radar reserve` capped at 50% of gross. |
| Operator footgun on payout batch release     | Two-OWNER ack required for batches > $10k.                                                               |

## 17. Dependencies

- **Internal:** [`payments-checkout.md`](./payments-checkout.md) (Connect onboarding, ledger, payouts), [`offer-builder.md`](./offer-builder.md) (`affiliate_share_bps` column), [`application-funnel.md`](./application-funnel.md) (attribution chain), PR #118 (setter role), PR #121 #29 (revenue dashboard).
- **External:** Stripe Connect Express for affiliates, hCaptcha (existing).
- **Human:** Counsel sign-off on 1099 positioning per routing. Founder closes §20 OQs.

## 18. Acceptance criteria

1. Coach can invite an affiliate, get a unique link, and the affiliate sees a click + conversion within 5 min in staging.
2. Conversion ledger pair sums to zero in tests.
3. Refund within hold reverses; refund after payout creates negative balance.
4. Self-referral blocked by default.
5. Two-OWNER ack required for batch payouts > $10k.
6. PR #118 forward-compat columns present.
7. PR #120 lane #04 retention contract met (30d click TTL).
8. Operator runbook merged.
9. Counsel sign-off on 1099 positioning logged.

## 19. Operator handoff

- **Kill-switches:** flags above; per-affiliate `status='paused' | 'suspended'`; per-link `status='revoked'`.
- **Dashboards:** Grafana — clicks, conversion rate, share-of-revenue, top affiliates by 30d earnings, fraud signals (bot score histogram). PostHog — affiliate funnel `click → checkout-start → checkout-complete`.
- **Runbook:** `docs/commerce/affiliate-runbook.md` — invite/suspend SOP, payout-batch release SOP, fraud triage, 1099 export.
- **Alerts:** conversion-reversal rate > 20% over 24h on a single affiliate; payout-batch failure; pending payable > $50k for any affiliate.

## 20. Open questions

- **OQ-1** Attribution model: last-touch (default) vs. first-touch vs. configurable per coach. **Owner: founder.**
- **OQ-2** Default cookie window: 30d (default) vs. 60d vs. 90d. **Owner: founder.**
- **OQ-3** Self-referral default. Bias: blocked. **Owner: founder.**
- **OQ-4** Default minimum payout threshold (e.g. $50). **Owner: backend lead.**
- **OQ-5** S2: ad-hoc affiliate payout requests vs. fixed monthly batches only. **Owner: founder.**
