# Featured Placements & Monetization

Status: DRAFT spec. Docs only. Schema deltas illustrative.

This file owns paid featured-slot placement: tier definitions, anti-spam, pricing model (OWNER_DECISION 3), Stripe billing path, refund handling, and disclosure rules.

## Table of contents

1. Tier definitions
2. Pricing model (OWNER_DECISION 3)
3. Anti-spam + integrity
4. Stripe billing
5. Refund handling
6. Disclosure rules
7. State-transition table — `FeaturedSlot`
8. Failure modes
9. Performance budget
10. Test plan
11. Schema deltas
12. Day-1 implementation order

---

## 1. Tier definitions

Three tiers with diminishing visibility lift and increasing price:

### 1.1 Bronze

- Rotational presence in the second half of page 1 (positions 13-24) at archetype-level granularity.
- 1 archetype + up to 2 niches scoped per slot.
- Daily capped at 4 Bronze slots per archetype/niche combo.
- Min commitment: 1 week. Max: 4 weeks.

### 1.2 Silver

- Guaranteed 1 position in the first 12 slots, rotational with peers.
- 1 archetype + up to 3 niches scoped per slot.
- Daily capped at 2 Silver slots per archetype/niche combo.
- Min commitment: 1 week. Max: 8 weeks.
- Sponsored badge required.

### 1.3 Gold

- Guaranteed up to 2 positions per page in first 12 slots; positions 1 and 6 by default (controlled rotation).
- Cross-niche scope allowed (1 archetype + up to 5 niches).
- Capped at 2 Gold slots per archetype overall.
- Min commitment: 1 week. Max: 4 weeks (anti-monopoly cap).
- Sponsored badge required.
- Featured-coach editorial spotlight on `/discover` landing if curated.

### 1.4 Editorial picks (non-paid)

- Curated by ADMIN team, no payment.
- Distinct visual treatment from sponsored.
- Labeled "Editor's Pick" — never confused with sponsored.
- Up to 4 editorial picks on `/discover` landing.
- Editorial picks have NO ranking lift on `/discover/coaches` filter views; they only appear on landing.

---

## 2. Pricing model

OWNER_DECISION 3: flat tier with cap (recommended).

### 2.1 Recommended pricing (USD baseline)

| Tier   | Weekly price | Min weeks | Max weeks | Anti-monopoly cooldown |
| ------ | ------------ | --------- | --------- | ---------------------- |
| Bronze | $99          | 1         | 4         | 0                      |
| Silver | $299         | 1         | 8         | 1 week per 8 weeks held |
| Gold   | $799         | 1         | 4         | 2 weeks per 4 weeks held |

Currency: USD. Price stored on row. Multi-currency surfacing: priced in coach's billing currency at platform daily ECB FX rate; FX rate stored on transaction row for refund integrity.

All prices `Decimal(14, 2)`.

### 2.2 Why flat (not auction)

- Predictability for coaches (essential at small scale).
- No auction infrastructure to maintain.
- Anti-monopoly easier to enforce (can't outbid).
- Caps capacity → preserves organic discoverability.

### 2.3 OWNER_DECISION 3 — alternatives if owner overrides

- **CPM auction**: requires bid manager, fraud detection, real-time clearing. Out of v1.
- **Hybrid auction-with-floor**: floor at flat tier; auction for above-floor positions. Adds complexity. Out of v1.
- **Flat tier (recommended)**: implement.

### 2.4 Promo + first-time discount

- 30% off first slot for coaches with no prior featured-slot purchase.
- Promo code validated against `PromoCode` table.
- One promo per coach lifetime, per tier family.

---

## 3. Anti-spam + integrity

### 3.1 Eligibility

A coach is eligible to purchase a featured slot only if ALL of:

- `CoachListing.state = ACTIVE`.
- `CoachListing.publicListingEnabled = true`.
- `Coach` has no open ADMIN moderation case > 0 days.
- `Coach.refundRateTrailing90 < 8%` (OWNER_DECISION 4).
- `Coach.identityVerified = true` (Wave 1 KYC; Stripe Connect onboarding completed).
- At least one verified achievement chip OR at least 3 trust badges.
- Account age >= 30 days OR coach has > 5 active client engagements (sub-coach allowed).

### 3.2 Manual review for first purchase

- First Bronze purchase: automatic.
- First Silver / Gold purchase: ADMIN manual review SLA 24h business hours.
- Subsequent purchases of same tier: automatic if eligibility maintained.

### 3.3 Banned-claim scan

- Card text and profile re-scanned at slot-purchase time against banned-claim regex.
- If any banned-claim hit: purchase blocked; coach notified.
- See `trust-and-safety.md` Section 6.

### 3.4 Disclosure compliance

- Sponsored card MUST display "Sponsored" badge in the same visual cluster as the avatar.
- Badge implementation is server-side (cannot be hidden via CSS).
- Sponsored badge is NOT clickable to disclosure page in v1; mouse-over tooltip says "Paid placement; ranking signals are not for sale."
- Crawler-visible: `<meta name="sponsored">` analogue is impractical; instead, JSON-LD `Advertisement` schema attached to sponsored cards.

### 3.5 Anti-circumvention

- No "boost API" exposed.
- No paid lift in `recommended` ranking signals.
- Featured slot is a SLOT, not a SCORE.
- Internal API for slot allocation is `coach.console:write` capability; never exposed to end-coach client outside admin console.

### 3.6 Rate limits

- Featured-slot purchase API: 5 attempts / hour per coach. 20 attempts / day per IP.
- Purchase abuse (charge → refund cycle): if pattern detected, eligibility revoked.

---

## 4. Stripe billing

### 4.1 Connect path

- Featured-slot revenue goes to PLATFORM (TGP), not to coach.
- Stripe Customer = coach. Stripe PaymentIntent confirms payment.
- Platform fee = 100% of featured-slot price (no Connect transfer).
- Wave 5 sub-coach billing path is unaffected.

### 4.2 Payment flow

```
Coach clicks "Buy Slot"
   ↓
Backend creates FeaturedSlot row in PENDING_PAYMENT
   ↓
Backend creates Stripe PaymentIntent with metadata { featuredSlotId }
   ↓
Coach completes payment (Stripe Checkout)
   ↓
Webhook payment_intent.succeeded → FeaturedSlot.state = ACTIVE
   ↓
Slot starts at next UTC hour boundary
```

Idempotency:
- Payment intent client_reference_id = `featured_slot_${id}`.
- Webhook handler is idempotent on `event.id`.

### 4.3 Currency

- Coach billed in their default Stripe currency.
- Price computed at purchase from USD baseline using daily ECB FX rate stored on `FeaturedSlot.fxRate`.

### 4.4 Receipts + invoicing

- Stripe receipt sent to coach email.
- Platform-side invoice with `invoiceNumber` generated for coach records.
- Tax: handled by Stripe Tax if configured per Wave 5 finance.

---

## 5. Refund handling

### 5.1 Pro-rata refund on suspension

If a slot is suspended (refund-rate breach OR ADMIN suspension OR moderation):

```
refund_amount = (remaining_days / total_days) * slot_price
```

Computed in coach's billing currency at the original FX rate (`FeaturedSlot.fxRate`), not current FX. Refund issued via Stripe.

### 5.2 Refund timing

- Suspended within 24h of activation: full refund.
- Suspended after 24h: pro-rata.

### 5.3 Coach-initiated refund

- Coach may cancel within 24h of activation: full refund.
- After 24h: NO partial refund unless ADMIN approves.
- Cancel by ending slot early: slot ends at next UTC hour boundary; no refund unless suspension cause is platform-side.

### 5.4 Failed payment

- 3 retry attempts at Stripe default cadence.
- After 3 failures, slot moved to FAILED_PAYMENT; coach notified.
- Slot auto-cancelled after 7 days in FAILED_PAYMENT.

### 5.5 Chargeback handling

- Chargeback opened: slot suspended; coach notified.
- Chargeback won by platform: slot resumes for remaining days; chargeback fee surfaced to coach console.
- Chargeback won by coach: slot remains cancelled; coach loses featured-slot eligibility for 90 days; ADMIN review.

### 5.6 Refund audit

Every refund recorded in `FeaturedSlotRefundLedger` with original price, refund amount, FX rate, currency, reason, actor, timestamp.

---

## 6. Disclosure rules

### 6.1 Visual badge

- "Sponsored" badge required on every featured card.
- Badge color: high-contrast, accessible WCAG AA.
- Badge text: "Sponsored". Localised translations: `Patrocinado` (es), `Sponsorisé` (fr), etc. Translation table in `locale-discovery.json`.
- Position: same visual cluster as avatar, above headline.

### 6.2 Tooltip / hover

- Mouse-over (or tap on mobile): "Paid placement. Ranking signals are not for sale."
- Source: `Federal Trade Commission disclosure guidelines for native advertising`.

### 6.3 Programmatic disclosure

- Card response includes `featuredSlot.sponsoredLabel = "Sponsored"`.
- Frontend MUST render the label as visible text (not hidden via CSS).
- E2E test asserts visibility.

### 6.4 Editorial picks

- Editorial picks labeled "Editor's Pick" with distinct visual treatment.
- Tooltip: "Curated by The Growth Project. No payment received for this listing."

### 6.5 Audit & legal

- Every featured-slot impression logged to `DiscoveryEvent` with `kind: "impression"`, `featuredSlotId` set.
- Disclosure compliance audited monthly.
- Legal review of disclosure copy (Wave 7 launch + every 12 months thereafter).

---

## 7. State-transition table — `FeaturedSlot`

| From               | To                | Trigger                             | Side effects                                      |
| ------------------ | ----------------- | ----------------------------------- | ------------------------------------------------- |
| (created)          | PENDING_PAYMENT   | coach initiates purchase            | PaymentIntent created                             |
| PENDING_PAYMENT    | ACTIVE            | webhook payment_intent.succeeded    | start at next UTC hour                            |
| PENDING_PAYMENT    | FAILED_PAYMENT    | webhook payment_intent.failed       | retry per Section 5.4                             |
| FAILED_PAYMENT     | ACTIVE            | retry succeeds                      | start                                              |
| FAILED_PAYMENT     | CANCELLED         | 7d expiry                           | release slot capacity                             |
| ACTIVE             | SUSPENDED         | refund-rate breach OR ADMIN         | pro-rata refund issued                            |
| ACTIVE             | EXPIRED           | end_at reached                      | release slot capacity                             |
| ACTIVE             | CANCELLED         | coach cancellation < 24h post-active | full refund                                       |
| SUSPENDED          | ACTIVE            | ADMIN reinstates                    | coach notified; remaining days resume             |
| SUSPENDED          | CANCELLED         | suspension > 30 days                | release slot capacity; refund forfeited unless ADMIN override |
| ACTIVE             | CHARGEBACK_HOLD   | chargeback opened                   | hide from public until resolved                   |
| CHARGEBACK_HOLD    | ACTIVE            | platform wins chargeback            | resume                                            |
| CHARGEBACK_HOLD    | CANCELLED         | coach wins chargeback               | 90-day eligibility revocation                     |

Audit on every transition.

---

## 8. Failure modes

### 8.1 Slot capacity exceeded at archetype/niche tier

- **Detection**: capacity check at purchase time.
- **Recovery**: 409 `code: "slot_capacity_exceeded"`; coach offered alternative tier or scope.
- **Audit**: capacity-exceeded events logged.

### 8.2 Webhook race (payment success vs slot end)

- **Detection**: payment success after `end_at` (rare, but possible if user delays Stripe Checkout).
- **Recovery**: if `now > end_at`, full refund; slot never activated.
- **Audit**: all such races logged.

### 8.3 Sponsored badge stripped at SSR

- **Detection**: server-rendered HTML diff vs expected; CI test asserts presence in SSR output.
- **Recovery**: if discovered post-launch, immediate hotfix; impressions during outage refunded pro-rata to affected coaches.
- **Audit**: every render-mode change is reviewed for badge integrity.

### 8.4 Stripe Connect mis-routing

- **Detection**: featured-slot revenue routed to coach instead of platform (regression risk).
- **Recovery**: reconciliation job nightly compares `FeaturedSlot.platformAmount` vs Stripe ledger.
- **Audit**: any drift triggers P0.

### 8.5 Anti-monopoly bypass

- **Detection**: same coach buying multiple slots via linked accounts.
- **Recovery**: Stripe customer linkage detection; revoke duplicate slots; refund.
- **Audit**: linked-account violations escalated.

### 8.6 Refund-rate-suspension lag

- **Detection**: suspension trigger is time-of-checkout, but refund-rate is trailing 90 days; daily cron job.
- **Recovery**: if a coach hits 8% mid-week, slot suspended within 24h; pro-rata refund.
- **Audit**: lag metric tracked.

### 8.7 Banned-claim slip-through

- **Detection**: profile or card text post-purchase scan flags claim.
- **Recovery**: slot suspended; coach notified to edit; resume after compliance.
- **Audit**: claim-violation events logged.

### 8.8 Promo code abuse

- **Detection**: same coach attempting multiple promo redemptions.
- **Recovery**: promo scoped to first-purchase only; subsequent attempts → 422.
- **Audit**: promo abuse pattern tracked.

---

## 9. Performance budget

| Endpoint                           | 100 coaches | 1k    | 10k   |
| ---------------------------------- | ----------- | ----- | ----- |
| `POST /v1/coach/featured-slots`    | 200ms       | 250ms | 300ms |
| `GET /v1/coach/featured-slots`     | 50ms        | 70ms  | 100ms |
| Stripe webhook handle              | 100ms       | 150ms | 200ms |
| Slot eligibility check             | 30ms        | 50ms  | 80ms  |
| Sponsored placement injection      | < 5ms       | < 5ms | < 5ms |

Sponsored placement injection runs in the ranking pipeline as a post-step over the top-12 results; constant-time per page.

---

## 10. Test plan

### 10.1 Unit

- Pricing math: weekly + currency conversion + FX rate fixed at purchase time.
- Pro-rata refund formula edge cases (1 day remaining, 0 days, suspension before activation).
- Eligibility checks across all gating criteria.
- State transitions exhaustive matrix.

### 10.2 Integration

- Buy slot → Stripe → activation → impression → click → suspension → refund.
- Promo first-time only.
- Anti-monopoly cooldown.
- Refund-rate breach triggers suspension.

### 10.3 E2E

- Coach buys Bronze → card visible with Sponsored badge in browser.
- Coach buys Gold → top-of-page visibility.
- Webhook race recovery.

### 10.4 Load

- 100 simultaneous slot purchases / minute → no double-allocation.
- Sponsored placement injection at 1k QPS no measurable rank latency impact.

### 10.5 Compliance

- Sponsored badge presence test on every rendered card (HTML diff).
- Disclosure copy review.
- FTC native-advertising guideline checklist.

---

## 11. Schema deltas (illustrative)

```prisma
model FeaturedSlot {
  id                  String                    @id @default(cuid())
  coachId             String
  coach               Coach                     @relation(fields: [coachId], references: [id], onDelete: Cascade)
  listingId           String
  listing             CoachListing              @relation(fields: [listingId], references: [id], onDelete: Cascade)
  tier                FeaturedTier
  scopeArchetype      String                    // closed enum
  scopeNicheTags      String[]
  startAt             DateTime
  endAt               DateTime
  state               FeaturedSlotState         @default(PENDING_PAYMENT)
  priceAmount         Decimal                   @db.Decimal(14, 2)
  priceCurrency       String                    @db.Char(3)
  priceUsdEquivalent  Decimal                   @db.Decimal(14, 2)
  fxRate              Decimal                   @db.Decimal(18, 8)
  promoCodeId         String?
  stripePaymentIntentId String?                 @unique
  refundLedger        FeaturedSlotRefundLedger[]
  createdAt           DateTime                  @default(now())
  updatedAt           DateTime                  @updatedAt
  createdById         String
  @@index([state, startAt, endAt])
  @@index([coachId, state])
  @@index([scopeArchetype, state, startAt, endAt])
}

enum FeaturedTier {
  BRONZE
  SILVER
  GOLD
}

enum FeaturedSlotState {
  PENDING_PAYMENT
  ACTIVE
  SUSPENDED
  EXPIRED
  CANCELLED
  FAILED_PAYMENT
  CHARGEBACK_HOLD
}

model FeaturedSlotRefundLedger {
  id              String       @id @default(cuid())
  slotId          String
  slot            FeaturedSlot @relation(fields: [slotId], references: [id], onDelete: Cascade)
  refundAmount    Decimal      @db.Decimal(14, 2)
  refundCurrency  String       @db.Char(3)
  fxRateAtRefund  Decimal      @db.Decimal(18, 8)
  reason          String
  stripeRefundId  String?
  occurredAt      DateTime     @default(now())
  actorId         String
}

model PromoCode {
  id              String   @id @default(cuid())
  code            String   @unique
  discountPercent Decimal  @db.Decimal(5, 2)
  appliesToTier   FeaturedTier?
  firstPurchaseOnly Boolean @default(true)
  expiresAt       DateTime?
  redemptions     PromoCodeRedemption[]
  @@index([code])
}

model PromoCodeRedemption {
  id          String    @id @default(cuid())
  promoCodeId String
  promoCode   PromoCode @relation(fields: [promoCodeId], references: [id], onDelete: Cascade)
  coachId     String
  slotId      String
  redeemedAt  DateTime  @default(now())
  @@unique([promoCodeId, coachId])
}
```

GDPR cascade: cascade from `Coach`. `FeaturedSlot` rows for offboarded coaches are tombstoned (pricing data preserved for accounting; coachId replaced with hash) per finance retention policy.

---

## 12. Day-1 implementation order

1. `FeaturedSlot` model + state machine.
2. Eligibility check service.
3. Pricing service (USD baseline + FX).
4. Stripe PaymentIntent creation + webhook handler.
5. Slot capacity allocator (per archetype/niche).
6. Sponsored placement injection in ranking post-step.
7. Pro-rata refund service.
8. Suspension trigger (refund-rate cron).
9. Promo code service.
10. Audit + reconciliation jobs.

---

## 13. Cross-repo

- `tgp-finance-app`: featured-slot revenue is platform-collected. Finance app receives reconciliation feed. No coach-side payout.
- `growth-project-mobile`: featured-slot purchase is web-only in v1 (App Store / Play Store IAP friction). Mobile shows existing slots' status read-only.

---

## 14. Audit log

Every featured-slot mutation (create, activate, suspend, refund, cancel, charge-back) audited with actor, scope, before/after state, justification.

Eligibility-check failures audited at coach console for transparency.

---

## 15. Senior-engineer onboarding

1. Read Section 1-2 (tiers + pricing).
2. Read Section 3 (anti-spam) — eligibility is non-negotiable.
3. Read Section 4-5 (Stripe + refunds) — money path.
4. Read Section 6 (disclosure) — legal.
5. Confirm OWNER_DECISION 3 before launch (default flat tier with cap).

---

## 16. Detailed slot allocation algorithm

### 16.1 Slot allocator data model

```ts
interface SlotInventory {
  archetype: ArchetypeTag;
  niche: NicheTag | null;        // null = archetype-level pool
  tier: FeaturedTier;
  slotsTotal: number;            // capacity
  slotsActiveSet: Set<{ slotId: string; weight: number }>;
}
```

Capacity rules:
- Bronze: 4 slots per (archetype, niche) pair.
- Silver: 2 slots per (archetype, niche) pair.
- Gold: 2 slots per archetype overall (no niche scoping in capacity bookkeeping).

### 16.2 Allocation request

```
allocate(coachId, tier, archetype, niche[], weeks):
  for each (archetype, niche) pair:
    inv = inventory_lookup(archetype, niche, tier)
    if inv.slotsActive >= inv.slotsTotal: return CAPACITY_EXCEEDED
  reserve all required pairs
  return slotId
```

Reservations are atomic via Postgres advisory locks per (archetype, niche, tier) tuple, with 5-second timeout.

### 16.3 Slot eviction at expiry

Daily cron at 00:05 UTC:
1. Find all slots with `state = ACTIVE` and `endAt <= now`.
2. Transition to `EXPIRED`.
3. Free inventory.
4. Trigger cache-tag invalidation `coach-list`.
5. Notify coach via email + in-app.

### 16.4 Slot rotation within page

For Gold (2 slots in first 12), rotation logic:

```
positions_for_request(snapshotId, requestId):
  pool = active_gold_slots_matching_filters
  if len(pool) <= 2: positions = [1, 6]
  else:
    seed = hash(snapshotId + requestId)
    pool_sorted = sort_by_purchase_time(pool)
    rotated = rotate(pool_sorted, seed % len(pool_sorted))
    return rotated[0] -> position 1, rotated[1] -> position 6
```

Ensures fairness across requests while preserving snapshot stability per page.

For Silver (1 slot in first 12), position 9 default.

For Bronze (rotational positions 13-24), uniform random across 4 candidate positions per snapshot.

---

## 17. Currency conversion details

### 17.1 USD baseline

Pricing defined in USD (Section 2.1). Coach billed in their default Stripe currency.

### 17.2 FX rate source

Daily ECB reference rate. Cached for 24h. Fallback to last known rate if ECB feed unavailable.

### 17.3 Rate locking

- FX rate locked at PaymentIntent creation; stored on `FeaturedSlot.fxRate`.
- Refunds use same locked rate (avoids FX risk for refund amount).
- Reconciliation report identifies any FX drift between platform-side USD and Stripe charge.

### 17.4 Multi-currency display

Coach console displays:
- Base USD price.
- Coach's billing currency price (FX-converted at current rate, refreshed on view).
- Disclosure: "Final price locked at checkout".

---

## 18. Tax handling

### 18.1 Stripe Tax

- Featured-slot purchases subject to applicable VAT/GST per Stripe Tax automated lookup.
- Tax displayed at checkout as separate line item.
- Tax remitted via Stripe Tax to applicable jurisdictions.

### 18.2 Coach as B2B customer

- Most coaches are B2B; reverse-charge rules apply where applicable.
- Coach can provide VAT ID at first purchase; persisted on `Coach` record.

### 18.3 1099 / tax reporting

- Featured-slot revenue is platform revenue, not coach revenue. No 1099 to coach for featured-slot fees.
- Coach receives invoice/receipt for own records.

---

## 19. Reconciliation

### 19.1 Daily reconciliation job

Reconciles internal `FeaturedSlot.priceAmount` ledger against Stripe ledger:

```
reconcile_daily():
  for each FeaturedSlot created in [yesterday-1d, yesterday]:
    stripe = stripe_payment_intent_lookup(slot.stripePaymentIntentId)
    if slot.state == ACTIVE and stripe.status != "succeeded": flag
    if slot.priceAmount != stripe.amount_received: flag
  for each FeaturedSlotRefundLedger row in [yesterday-1d, yesterday]:
    stripe_refund = stripe_refund_lookup(row.stripeRefundId)
    if row.refundAmount != stripe_refund.amount: flag
```

Flagged rows surface in ADMIN dashboard. Daily summary email to finance team.

### 19.2 Monthly close

- Featured-slot revenue rolled up by month.
- Reported to `tgp-finance-app` for inclusion in monthly P&L.
- Discrepancy threshold: < 0.1% of monthly revenue.

---

## 20. Featured-slot dashboard for coach

### 20.1 Surfaces

`/coach/console/featured-slots`:

- Active slots: list with tier, scope, expiry, days remaining, total cost, total impressions, total clicks.
- Slot performance: CTR vs organic CTR delta.
- Suspension warnings: refund-rate trending toward 8%.
- Purchase form: tier picker, scope picker, weeks picker, promo input, total price.
- History: completed slots with outcome.

### 20.2 Sub-coach scoping

If parent coach has sub-coaches with featured slots (Mode B), parent can see consolidated view; sub-coach sees own only.

### 20.3 Performance metrics

- Impressions (with sponsored disclosure clarified).
- Clicks (sponsored vs organic split).
- Apply rate.
- Checkout conversion.
- Cost per click (CPC).
- Cost per acquisition (CPA).

---

## 21. Featured-slot edge cases

### 21.1 Tier downgrade mid-slot

Not supported in v1. Coach must wait for slot to expire, then purchase new tier.

### 21.2 Tier upgrade mid-slot

Supported via "extend with upgrade" flow:
- Cancel current slot (full refund only if < 24h since activation; pro-rata otherwise).
- Purchase new higher-tier slot.
- Net cost calculated.

### 21.3 Scope change mid-slot

Not supported. Coach purchases new slot.

### 21.4 Pause slot

Not supported in v1. Slots run continuously.

### 21.5 Multi-currency promo

Promo discount applied to USD baseline; FX conversion applied to discounted amount. Refunds use same path.

---

## 22. Banned-tier scenarios

### 22.1 Coach with active suspension

Cannot purchase featured slot until suspension lifted.

### 22.2 Coach with refund-rate breach

Cannot purchase until refund-rate drops below 5% trailing 90d (deliberately stricter than 8% suspension threshold to prevent toggling).

### 22.3 Coach with open ADMIN moderation case

Cannot purchase until case resolved.

### 22.4 Coach with banned-claim hit in last 30 days

Cannot purchase until 30 days elapsed AND coach acknowledges.

### 22.5 Newly created coach (< 30 days, < 5 active engagements)

Cannot purchase Silver or Gold; Bronze allowed only if profile completeness >= 70%.

---

## 23. Operational runbook (forward-pointer)

- Cancel coach's active slot via ADMIN console (with reason).
- Issue manual refund (with audit + Stripe API).
- Whitelist a coach past auto-suspension (with documented justification).
- Pause inventory tier (e.g. emergency capacity reduction).
- Promo code creation + retirement.

---

## 24. Cross-repo recap

- `tgp-finance-app`: featured-slot revenue reconciliation feed; monthly P&L roll-up.
- `growth-project-mobile`: read-only featured-slot status; deep-link to web for purchase.
- `growth-project-backend` (this repo): owns slot allocation, billing, dashboards, sponsored disclosure rendering.

---

End `featured-placements-and-monetization.md`.
