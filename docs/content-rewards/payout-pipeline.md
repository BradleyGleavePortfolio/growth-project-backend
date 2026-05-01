# Content Rewards — Payout Pipeline

> Companion to `rewards-spec.md`. Read that first for entity definitions and state machines.
> Cross-repo: actual Stripe Connect transfer execution lives in `tgp-finance-app`. This doc specifies the **emitter contract** owned by this backend.

---

## 1. Pipeline overview

```
                                     +-----------------+
                                     | Tier-2 / Tier-3 |
                                     | Verification    |
                                     +--------+--------+
                                              |
                                              v
+-----------+        +------------+      +----------+      +------------------+      +--------------+
| Submission| -----> | Tier-1     | ---> | Approval | ---> | Accrual ledger   | ---> | PayoutInstr  |
| created   |        | short-link |      | (auto/   |      | (per-window      |      | emitted      |
|           |        | verify     |      | manual)  |      |  burn-down)      |      | (domain evt) |
+-----------+        +------------+      +----------+      +------------------+      +------+-------+
                                                                                             |
                                                                                             v
                                                                                    +--------+--------+
                                                                                    | tgp-finance-app |
                                                                                    | executes        |
                                                                                    | Stripe Transfer |
                                                                                    +--------+--------+
                                                                                             |
                                                                                             v
                                                                                    +--------+--------+
                                                                                    | settlement +    |
                                                                                    | 1099 / VAT      |
                                                                                    | + reconciliation|
                                                                                    +-----------------+
```

Eight stages:

1. **Submission created.** `ContentSubmission` row created, status `PENDING`.
2. **Tier-1 verification.** Short-link click rollup begins; first eligibility check.
3. **Approval.** Auto (if low-risk and below tier-1 ceiling) or manual.
4. **Accrual.** Per-window verifiedViews × perViewCents accumulate against `submission.payoutAmountCents`. `remainingPoolCents` decrements.
5. **Payout instruction emission.** Once accrued payout crosses payout-batch threshold (or pool closes), emit `PayoutInstruction`.
6. **Finance-app transfer.** Finance-app consumes domain event, executes Stripe Connect transfer.
7. **Settlement confirmation.** Webhook back to backend; mark `PayoutInstruction.status = SUCCEEDED`.
8. **Reconciliation.** Daily job verifies platform views, ledger balance, transfer success.

---

## 2. Money handling rules

### 2.1 Decimal precision

- All amounts: `Decimal(14, 2)` — supports up to 999,999,999,999.99.
- Per-view rate exception: `perViewCents` is `Decimal(14, 6)` to support sub-cent precision (e.g., $0.000750 per view). Submission-level payouts are always rounded to `Decimal(14, 2)` at emit time using **banker's rounding** (round-half-to-even).
- All monetary arithmetic uses a `bigDecimal`-style library (e.g., `decimal.js`). NEVER `Number`. NEVER `parseFloat`.

### 2.2 Currency

- Stored on every `ContentReward` row (`currency` ISO-4217 char(3)).
- Stored on every `PayoutInstruction` row (must equal reward's currency at emit time).
- Creator's `payoutCurrency` may differ; FX is handled by Stripe Connect transfer with platform-paid FX disclosed.
- Cross-currency rewards (reward in EUR, creator paid in USD): allowed, but quoted at the FX rate at the moment of `PayoutInstruction` emit, not at submission accrual time. Disclosed to creator.

### 2.3 Pool burn-down accounting

```
Pool initialised:
  totalPoolCents = X
  platformFee = X * platformFeeBps / 10000
  remainingPoolCents = X - platformFee   // platform fee taken upfront

For each verified view-window approved:
  delta = verifiedViewsThisWindow * perViewCents
  delta = min(delta, remainingPoolCents)
  delta = min(delta, capCents - submission.creator.allocatedToThisReward)
  delta = round(delta, banker's, 2)

  submission.payoutAmountCents += delta
  reward.remainingPoolCents -= delta
```

### 2.4 Rounding strategy

- **Submission-level payout:** rounded to cents with banker's rounding at emit time.
- **Pool burn:** integer-cents only; sub-cent precision flows through accumulator until emit.
- **Currency aware:** for currencies without minor units (e.g., JPY), round to 0 decimals; for 3-decimal currencies (e.g., BHD), round to 3.

### 2.5 Platform fee

- Default: 5% (500 bps), per OWNER_DECISION 8.A.
- Stored on `ContentReward.platformFeeBps`.
- Deducted at pool funding (Stripe charge time), NOT at payout time. This keeps payout math creator-clean.
- TGP revenue accounting: a `PlatformFeeLedger` row is created at funding charge time recording the fee captured.

### 2.6 Per-creator cap

- `ContentReward.capCents` (optional) caps the total a single creator can earn from one pool. Anti-whale.
- When cap reached: submission moves to `PAID_FINAL` and accrual stops. Creator's other submissions to the same pool are still eligible (but the cap is shared across them).

---

## 3. Idempotency

Every `PayoutInstruction` carries an `idempotencyKey` formed as:

```
SHA256(
  submissionId || ':' ||
  windowStartUnix || ':' ||
  windowEndUnix || ':' ||
  amountCents || ':' ||
  ENV.PAYOUT_IDEMPOTENCY_SALT
)
```

The Stripe Connect transfer call uses the same key. If the same instruction is replayed (network retry, dual-emit race), Stripe deduplicates and returns the original transfer. The DB `@@unique` constraint on `idempotencyKey` likewise dedupes on our side.

For clawbacks (negative instructions):

```
SHA256(
  'CLAWBACK:' || originalPayoutInstructionId || ':' || ENV.PAYOUT_IDEMPOTENCY_SALT
)
```

---

## 4. Auto-pay vs hold thresholds (trust-tier ladder applied)

| Submission state | Trust tier (creator) | Submission accrued $ | Auto-emit instruction? |
|------------------|:--------------------:|---------------------:|:----------------------:|
| APPROVED | 1 | <= $50 lifetime | YES (per emit cycle) |
| APPROVED | 1 | > $50 lifetime | NO — escalate to tier 2 |
| APPROVED | 2 | <= $500 / submission | YES |
| APPROVED | 2 | > $500 / submission | NO — escalate to tier 3 |
| APPROVED | 3 | any | YES (manual signed off) |
| UNDER_REVIEW | any | any | NO — pause emission |
| KYC NOT VERIFIED | any | any | NO — accrual continues, emission held |

---

## 5. Emit cadence

- **Per-submission rolling:** As soon as accrued amount >= $5 USD-equivalent AND submission is in `APPROVED`/`PAID_PARTIAL`, emit a `PayoutInstruction`.
- **Daily sweep:** Once daily at 04:00 UTC, sweep all submissions with accrued > $0 (regardless of $5 floor) to keep small balances flowing — but only if creator's total balance exceeds $5.
- **Pool close:** On `CLOSED`, emit final instructions for all accrued amounts regardless of floor.
- **Per-creator daily cap on instructions:** max 50 instructions/day/creator to avoid Stripe Connect transfer limit issues.

---

## 6. Stripe Connect transfer envelope (handoff to finance-app)

### 6.1 Domain event published by backend

```ts
interface PayoutInstructionEmittedEvent {
  type: 'content_rewards.payout_instruction.emitted';
  v: 1;
  emittedAt: string;            // ISO
  payload: {
    payoutInstructionId: string;
    submissionId: string;
    creatorProfileId: string;
    creatorStripeAccountId: string;
    rewardId: string;
    amountCents: number;        // safe int (≤ 9e15)
    currency: string;
    idempotencyKey: string;
    metadata: {
      submissionId: string;
      rewardId: string;
      creatorProfileId: string;
      windowStart: string;
      windowEnd: string;
      trustTier: number;
    };
  };
  // signed JWT envelope; verified by finance-app via shared secret
  signature: string;
  requestId: string;
}
```

Topic: `tgp.payouts.content_rewards.v1`. Persisted to outbox; outbox-dispatcher publishes to event bus. Finance-app subscribes.

### 6.2 Finance-app acks back

```ts
interface PayoutInstructionAckEvent {
  type: 'content_rewards.payout_instruction.ack';
  v: 1;
  payload: {
    payoutInstructionId: string;
    status: 'IN_FLIGHT' | 'FAILED';
    stripeTransferId?: string;
    failureCode?: string;
    failureMessage?: string;
  };
}
```

### 6.3 Finance-app reports completion

```ts
interface PayoutInstructionCompletedEvent {
  type: 'content_rewards.payout_instruction.completed';
  v: 1;
  payload: {
    payoutInstructionId: string;
    status: 'SUCCEEDED' | 'FAILED' | 'CLAWED_BACK';
    stripeTransferId: string;
    stripePayoutId?: string;     // when Connect account is daily auto-payout
    completedAt: string;
    failureCode?: string;
  };
}
```

On `SUCCEEDED`: backend updates `PayoutInstruction.status`, `submission.paidOutCents`, and emits creator-side notification.

On `FAILED`: backend retries up to 3x with exponential backoff (15min, 1h, 6h). After 3 failures, escalate to admin.

---

## 7. 1099 / tax handling

### 7.1 US 1099-NEC

- Threshold: $600 USD/year per creator (US payor, US payee).
- TGP tracks `CreatorProfile.taxYear1099Cents` JSON field by year.
- Stripe Connect Express handles 1099 generation natively (OWNER_DECISION 8.D Option B).
- Backend's only responsibility:
  - Flag creator approaching threshold (>$500/yr): nudge to complete tax info via `Stripe Tax` form.
  - At year-end (Jan 1 next year): freeze year aggregate; provide ledger CSV export to creator.
- Year boundary: TGP fiscal year aligns to calendar year for 1099.

### 7.2 EU / UK VAT

- TGP charges VAT inclusive on coach-side pool funding (Stripe Tax handles).
- Creator-side: TGP issues self-billing invoices on behalf of creator if creator has provided VAT registration. Creator opts in via `CreatorProfile`.
- Reverse-charge rules apply: B2B cross-border, no VAT charged on transfer; clearly disclosed.

### 7.3 Other jurisdictions

- Defer to local tax law. Creator is responsible for declaring income.
- TGP's `Stripe Tax` integration provides per-country support as Stripe rolls out.

### 7.4 Year-end flows

```
Year N+1, January 5:
  - Job freezes Year N aggregates per creator.
  - Stripe generates 1099-NEC for US creators >= $600.
  - Backend emails creator: "Your tax form is available on Stripe Express dashboard."
  - Backend produces creator-facing CSV ledger of all `PayoutInstruction.SUCCEEDED` rows in Year N.
```

---

## 8. Clawback rules

### 8.1 Triggers

- Confirmed fraud (post-payout flag upheld).
- Coach Stripe-charge dispute lost AND coach uncollectible.
- Creator-initiated voluntary refund (rare; e.g., creator self-reports duplicate submission).
- Platform takedown for ToS violation.

### 8.2 Window

- 30 days after payout: clawback always permitted (Stripe dispute window).
- 30-90 days: clawback permitted only with explicit confirmed fraud signature (OWNER + admin documentation).
- >90 days: clawback NOT permitted from payment unless court order; instead, recover from creator's future earnings via offset.

(OWNER_DECISION 8.C Option C.)

### 8.3 Mechanism

```
For each clawback:
  1. Validate trigger (fraud signature OR refund event).
  2. Create negative `PayoutInstruction` with idempotencyKey = "CLAWBACK:" + originalId.
  3. Emit domain event `content_rewards.payout_instruction.emitted` with negative amount.
  4. Finance-app calls Stripe `POST /v1/transfer_reversals` on the original transfer ID.
  5. On success: original `PayoutInstruction.status = CLAWED_BACK`; submission status updated.
  6. On failure (transfer too old or Stripe blocked): create offset record `CreatorBalanceOffset` for next payout cycle to debit.
```

### 8.4 Creator balance offset

```prisma
model CreatorBalanceOffset {
  id                   String          @id @default(cuid())
  creatorProfileId     String
  amountCents          Decimal         @db.Decimal(14, 2)   // negative
  currency             String          @db.Char(3)
  reason               String          @db.VarChar(280)
  reasonCode           OffsetReasonCode
  appliedToPayoutId    String?
  status               OffsetStatus    @default(PENDING)
  createdAt            DateTime        @default(now())
  appliedAt            DateTime?

  @@index([creatorProfileId, status])
  @@map("creator_balance_offsets")
}

enum OffsetStatus {
  PENDING
  APPLIED
  WRITTEN_OFF
}

enum OffsetReasonCode {
  CLAWBACK_FRAUD
  CLAWBACK_REFUND
  CLAWBACK_PLATFORM_TAKEDOWN
  OVERPAY_CORRECTION
}
```

Future `PayoutInstruction.amountCents` is reduced by pending offsets up to zero (never negative emit).

---

## 9. Reconciliation job (daily)

### 9.1 Purpose

- Detect view-count drift (platform-reported vs ledger).
- Detect ledger drift (sum of `submission.paidOutCents` vs sum of `PayoutInstruction.SUCCEEDED.amountCents`).
- Detect pool drift (`reward.totalPoolCents - reward.remainingPoolCents` vs sum of payout instructions for pool).
- Detect Stripe drift (sum of Stripe Connect transfers for org vs sum of our instructions).

### 9.2 Schedule

`0 5 * * *` UTC daily. Runtime SLA: <90 min at 10k coaches.

### 9.3 Algorithm

```
For each ACTIVE or recently-CLOSED reward in trailing 90 days:
  1. Fetch all submissions and their views.
  2. Re-fetch tier-2 platform metrics (sample 10% of submissions; full re-fetch weekly).
  3. Compare verifiedViews vs platform-reported. If divergence > 25%: flag.
  4. Sum submission.paidOutCents; sum PayoutInstruction.SUCCEEDED for reward.
     Difference > $0.01: alarm, halt new emissions for reward.
  5. Sum reward burn-down vs Stripe Connect transfer amounts via finance-app reconciliation feed.
     Difference > $1.00: alarm.
  6. Cross-currency: convert at end-of-day FX (Stripe-reported rate) for comparison only.

Output: ReconciliationReport row, surfaced to admin dashboard.
```

### 9.4 ReconciliationReport schema

```prisma
model ReconciliationReport {
  id              String                @id @default(cuid())
  rewardId        String?
  scope           ReconciliationScope
  ranAt           DateTime              @default(now())
  durationMs      Int
  driftCents      Decimal               @db.Decimal(14, 2)
  alertLevel      ReconciliationAlert
  payload         Json                  // structured detail per category
  resolvedAt      DateTime?
  resolvedByUserId String?

  @@index([scope, ranAt])
  @@map("reconciliation_reports")
}

enum ReconciliationScope {
  PER_REWARD
  PER_ORG
  PLATFORM_WIDE
}

enum ReconciliationAlert {
  OK
  INFO
  WARN
  CRITICAL
}
```

### 9.5 Alert routing

- `INFO`: log, surface in admin dashboard.
- `WARN`: page on-call (PagerDuty).
- `CRITICAL`: page on-call AND auto-pause new emissions for affected reward(s).

---

## 10. Failure modes

### 10.1 Failure: Stripe transfer rejected (insufficient platform balance)

**Detection:** finance-app returns `FAILED` with code `BALANCE_INSUFFICIENT`.

**Recovery:**
- Mark `PayoutInstruction.status = FAILED`, `failureReason = 'PLATFORM_BALANCE_INSUFFICIENT'`.
- Auto-retry once after 6 h (gives funding time to land).
- If still failing: page on-call. Coach is notified that pool funding may not have settled.

### 10.2 Failure: Creator KYC reject mid-emission

**Detection:** Stripe webhook flips `payouts_enabled = false` while a `PayoutInstruction` is `IN_FLIGHT`.

**Recovery:**
- Allow in-flight transfer to complete (Stripe will queue or reject; we reflect outcome).
- Block all new emissions for creator.
- Move all subsequent accruals to `CreatorBalanceOffset.PENDING` accumulating.
- 30-day cure period: if KYC re-verifies, release backlog.
- 30-day no-cure: forfeit per ToS.

### 10.3 Failure: Currency mismatch between reward and creator

**Detection:** At emit time, `reward.currency != creator.payoutCurrency`.

**Recovery:**
- Stripe Connect handles cross-currency natively if Connect account supports it.
- If creator's currency is unsupported by reward's Stripe destination: convert via TGP platform balance using daily FX, disclosed.
- If FX rate spread exceeds 2%: hold and notify creator to confirm.
- Failure to confirm in 7 days: convert at then-rate.

### 10.4 Failure: Coach refund disputes pool funding charge after payouts emitted

**Detection:** Stripe webhook `charge.dispute.funds_withdrawn` for the funding charge.

**Recovery:**
- Treat as adversarial scenario. TGP fronts the cost to creators short-term to protect creator trust.
- File dispute response with evidence (audit trail, signed terms, payout records).
- If dispute won: restore funds.
- If dispute lost: collections under coach contract; otherwise platform absorbs as fraud loss line item.

### 10.5 Failure: Platform-deleted post mid-accrual

**Detection:** Tier-2 fetcher returns `POST_NOT_FOUND` for a previously-fetchable post.

**Recovery:**
- Halt accrual at last-known verifiedViews.
- 24 h grace: maybe transient platform issue.
- After 24 h: lock `paidOutCents` at current value. Submission moves to `PAID_FINAL` (no more accrual).
- Already-emitted payout instructions stand.

### 10.6 Failure: Outbox dispatcher down — events not flowing to finance-app

**Detection:** Outbox lag metric > 5 min.

**Recovery:**
- Page on-call.
- Backlog drains automatically once dispatcher resumes; idempotency keys prevent double-emits.
- If dispatcher down >1 hour: switch to backup dispatcher path (manual SQS publisher).
- During downtime, `PayoutInstruction` rows accumulate in `PENDING` state; no creator funds at risk because nothing has been transferred yet.

### 10.7 Failure: Reconciliation reports drift > $1 platform-wide

**Detection:** Daily reconciliation `CRITICAL` alert.

**Recovery:**
- Auto-pause all new emissions across platform.
- Forensics: dump diff into ops bucket; engineer-on-call investigates within 2 h.
- Resume emissions only after diff explained and (if needed) manual journal entry posted.

### 10.8 Failure: Race condition double-emit

**Detection:** Two `PayoutInstruction` rows with same `idempotencyKey` attempt to insert. DB unique constraint catches. One succeeds, one fails.

**Recovery:**
- Failing path returns 409 to internal caller; caller logs and continues.
- If logic reaches Stripe with same key: Stripe deduplicates; one transfer happens. Safe.

### 10.9 Failure: Negative `remainingPoolCents`

**Detection:** DB CHECK constraint fires.

**Recovery:** see `rewards-spec.md` §8.7. Pool emissions paused; admin investigates.

### 10.10 Failure: 1099 threshold crossed silently

**Detection:** Year-end report shows creator at $645 but Stripe didn't auto-issue 1099.

**Recovery:**
- Backstop job at Jan 5 enumerates all `CreatorProfile` with `taxYear1099Cents[N] >= 60000` (cents) and verifies Stripe issued 1099 via Stripe API.
- Where missing: TGP files manually via Stripe Tax Reporting API.
- Annual audit by tax CPA covers this.

---

## 11. Performance budgets (payout pipeline specific)

- `PayoutInstruction` insert: p50 < 30ms (single row, hot table).
- Domain event publish (outbox to bus): p50 < 100ms end-to-end.
- Finance-app round-trip (emit → ack): p50 < 5s, p95 < 30s.
- Stripe transfer creation (in finance-app): p50 < 1.5s, p95 < 8s.
- Reconciliation job: <90 min at 10k scale.

---

## 12. Test plan (payout-specific)

### 12.1 Unit

- Idempotency-key derivation function (deterministic, covers all field permutations).
- Cap enforcement (per-creator, per-pool).
- Banker's rounding correctness across currencies.
- Clawback amount computation (full and partial).
- Offset application logic.

### 12.2 Integration (with Stripe test mode)

- Funding charge → pool active → submissions → payouts → 1099 export.
- Funding-dispute path.
- Creator-KYC-fail path.
- Cross-currency reward + creator.
- Clawback (within 30d, 30-90d, >90d).

### 12.3 End-to-end with finance-app (local + staging)

- Domain event round-trip.
- Idempotency under retries.
- Reconciliation job catches injected drift.

---

## 13. Migration / backfill plan

No backfill (no prior data). State explicitly: this is a greenfield primitive.

If feature flag enabled in stages, the payout pipeline turns on last (after submission ingestion has at least 7 days of soak time on test data).

---

## 14. Rollback

- Feature flag `org.contentRewardsEnabled` disables creation; existing pools may be paused via admin.
- Outbox dispatcher kill-switch halts emissions to finance-app without data loss.
- Active pools cannot be silently rolled back; creators have already accrued balances and TGP must honour or explicitly close-and-pay.

---

## 15. Cross-repo dep map (specific to payout)

- `tgp-finance-app` — owns Stripe Connect transfer call. Subscribes to `tgp.payouts.content_rewards.v1` topic. Documented in finance-app's wave-8 PR.
- `tgp-finance-app` — also issues `PayoutInstructionAck` and `PayoutInstructionCompleted` events.
- `tgp-finance-app` — owns 1099 generation flow (Stripe Tax Reporting API).

---

End of `payout-pipeline.md`.
