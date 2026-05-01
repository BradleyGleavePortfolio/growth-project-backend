# Affiliate program — dashboard + payouts spec

> **Status:** draft, docs-only. Do not merge. No runtime changes.
> **Owner:** backend platform.
> **Wave:** 8 (parity layer).
> **Reads with:** `affiliate-link-spec.md`. This file specifies the dashboard surface and the end-to-end payout pipeline; the data model, attribution, and fraud rules live in the link spec.

---

## 1. Purpose, non-goals, OWNER decisions

### Purpose
Specify (a) the affiliate-facing dashboard surface (what an affiliate sees and acts on) and (b) the end-to-end payout pipeline from `COMMISSIONABLE` ledger entry → bank-account credit, including KYC, tax-form gating, and reconciliation.

### Non-goals (v1)
- No native mobile payout UI (deep-link to web).
- No instant payout / "request now" flow — monthly cycle only.
- No multi-currency consolidation per affiliate (each currency has its own balance and threshold).
- No marketing-attribution analytics beyond clicks/conversions/EPC (richer cohort analytics deferred).
- No tax-treaty optimisation tooling beyond the W8-BEN/W8-BEN-E collection itself.

### OWNER decisions (this spec)

| # | Decision | Options | Recommendation |
|---|---|---|---|
| 1 | Default min payout threshold | $25 / $50 / $100 | **$50** (per-currency equivalent on row) |
| 2 | Payout cadence | weekly / bi-weekly / monthly | **monthly, settling on the 7th for prior month-end** |
| 3 | 1099-NEC trigger | $400 / $600 (US legal floor) / $1000 | **$600 trailing 12-month gross commission** |
| 4 | KYC provider | Stripe-only / Stripe + Persona / hybrid | **Stripe Connect Express** (re-uses Wave 5 KYC) |
| 5 | Tax form storage | platform-encrypted bucket / managed (Stripe) / both | **platform-encrypted bucket; Stripe-managed surfaced via webhook for redundancy** |
| 6 | Pre-flight hold window after first PAID transition | 0 h / 24 h / 48 h | **24 h** (allows reconciliation pass before Stripe transfer dispatches) |

---

## 2. Personas + permission matrix (recap)

| Persona | Dashboard scope |
|---|---|
| `AFFILIATE` | Own balance, own ledger, own payouts, own tax forms. NO program-owner PII. |
| `COACH` (program owner) | Own program metrics aggregated; no affiliate PII. |
| `OWNER` | All program metrics; PII-redacted ledger by default. |
| `ADMIN` | Full read; PII visible; can clawback / release / ban; all reads audit-logged. |

---

## 3. Affiliate dashboard surface

### 3.1 Top-level dashboard widgets

```ts
type AffiliateDashboardSummary = {
  account: {
    id: string;
    status: 'ACTIVE' | 'SUSPENDED' | 'BANNED' | 'CLOSED';
    payout_currency: string;       // ISO-4217
    payout_threshold: { amount: string; currency: string };
    kyc_state: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETE' | 'REJECTED';
    tax_form_state: 'REQUIRED' | 'COLLECTED' | 'EXPIRING_SOON' | 'EXPIRED';
  };
  balance: {
    pending_attribution: { amount: string; currency: string };  // PENDING conversions
    commissionable: { amount: string; currency: string };       // ATTRIBUTED + COMMISSIONABLE not yet paid
    payable_now: { amount: string; currency: string };          // commissionable && passes threshold
    paid_lifetime: { amount: string; currency: string };
    clawed_back_lifetime: { amount: string; currency: string };
  };
  metrics_30d: {
    clicks: number;
    conversions: number;
    epc: { amount: string; currency: string };  // earnings per click
    conversion_rate_pct: string;
    top_links: Array<{ link_id: string; code: string; conversions: number }>;
    top_programs: Array<{ program_id: string; name: string; conversions: number }>;
  };
  next_payout: {
    scheduled_at: string | null;       // ISO; null if blocked
    blocked_reason: 'BELOW_THRESHOLD' | 'KYC_INCOMPLETE' | 'TAX_FORM_REQUIRED' | 'ACCOUNT_SUSPENDED' | null;
    estimated_amount: { amount: string; currency: string } | null;
  };
};
```

### 3.2 Endpoints

```ts
// GET /v1/affiliate/dashboard/summary
type DashboardSummaryResponse = ApiResult<AffiliateDashboardSummary>;

// GET /v1/affiliate/dashboard/timeseries?metric=clicks|conversions|epc&granularity=day|week|month&since=&until=
type TimeseriesResponse = ApiResult<{
  metric: 'clicks' | 'conversions' | 'epc';
  granularity: 'day' | 'week' | 'month';
  points: Array<{ ts: string; value: string }>;  // string for Decimal precision
  total: string;
}>;

// GET /v1/affiliate/dashboard/links?status=&cursor=&limit=
//   (Same shape as ListLinksResponse in affiliate-link-spec §4 with extended metrics.)

// GET /v1/affiliate/dashboard/programs
//   Lists programs the affiliate is enrolled in with per-program metrics.

// GET /v1/affiliate/payouts?cursor=&limit=
type ListPayoutsResponse = ApiResult<{
  items: Array<{
    payout_id: string;
    status: PayoutStatus;
    requested_at: string;
    processed_at: string | null;
    arrival_estimated_at: string | null;
    amount: { amount: string; currency: string };
    method: 'STRIPE_CONNECT';
    stripe_transfer_id?: string;
    items_count: number;        // commissions included
    failure_reason?: string;
  }>;
  next_cursor?: string;
}>;

// GET /v1/affiliate/payouts/:id
//   Payout detail with included commission rows (paginated).

// POST /v1/affiliate/tax-forms/start  → returns Stripe-hosted KYC + tax form session URL
type StartTaxFormResponse = ApiResult<{
  session_url: string;
  expires_at: string;        // ISO
}>;

// GET /v1/affiliate/tax-forms/state
type TaxFormStateResponse = ApiResult<{
  kind: 'W9' | 'W8BEN' | 'W8BEN-E' | null;
  collected_at: string | null;
  expires_at: string | null;          // W8 forms expire after ~3 years
  needs_renewal: boolean;
}>;
```

### 3.3 Dashboard performance budgets

| Endpoint | 100 affiliates | 1 k | 10 k |
|---|---|---|---|
| `dashboard/summary` | p50 60 ms / p95 200 ms | p50 80 ms / p95 250 ms | p50 110 ms / p95 350 ms |
| `dashboard/timeseries` | p50 80 ms / p95 250 ms | p50 110 ms / p95 350 ms | p50 150 ms / p95 500 ms |
| `payouts` listing | p50 50 ms / p95 180 ms | p50 70 ms / p95 220 ms | p50 100 ms / p95 320 ms |

Reads from replica with ≤ 5 s lag. Heavy aggregations (`metrics_30d`) materialised hourly into `AffiliateAccountMetricsHourly`.

---

## 4. Payout pipeline — end-to-end

### 4.1 Models

```prisma
model AffiliatePayout {
  id                   String   @id @default(cuid())
  affiliate_account_id String
  status               PayoutStatus @default(PENDING)
  amount               Decimal  @db.Decimal(14,2)
  currency             String   @db.Char(3)
  method               String   @default("STRIPE_CONNECT")
  stripe_transfer_id   String?  @unique
  stripe_destination_id String? // Connect account id
  requested_at         DateTime @default(now())
  scheduled_for        DateTime
  processed_at         DateTime?
  arrival_estimated_at DateTime?
  failure_code         String?
  failure_reason       String?
  retry_count          Int      @default(0)
  reconciled_at        DateTime?
  ledger_hash          String   // SHA-256(sorted commission ids + amount + currency) — tamper-evidence
  audit_request_id     String   // ties to AuditLog
  created_at           DateTime @default(now())
  updated_at           DateTime @updatedAt

  account              AffiliateAccount @relation(fields: [affiliate_account_id], references: [id], onDelete: Restrict)
  commissions          AffiliateCommission[]

  @@index([affiliate_account_id, status])
  @@index([scheduled_for, status])
  @@index([stripe_transfer_id])
}

enum PayoutStatus {
  PENDING        // batched, waiting for hold window + Stripe dispatch
  PROCESSING     // Stripe transfer in flight
  PAID           // transfer succeeded
  FAILED         // transfer failed; retry possible
  HELD           // manual hold (admin or fraud signal)
  CANCELLED      // affiliate closed mid-flight or admin cancel
  CLAWBACK_PENDING // refund hit during processing — see §5
}
```

### 4.2 Pipeline stages

```
[1] Nightly sweep (00:30 UTC)
    Inputs:  AffiliateCommission rows where paid_at IS NULL and conversion.status = COMMISSIONABLE
             AND conversion.clawback_window_elapsed = TRUE
    Group by: (affiliate_account_id, currency)
    Filter:   running_sum >= account.payout_threshold
    Output:   AffiliatePayout draft rows (status=PENDING, scheduled_for = next 7th of month at 09:00 UTC)
    Idempotency: keyed on (affiliate_account_id, currency, period_yyyy_mm)

[2] Pre-dispatch reconciliation (24 h before scheduled_for)
    Re-compute the commission set; verify ledger_hash matches.
    If divergent: status → HELD, alert ops.
    If KYC/tax incomplete: status → HELD, notify affiliate, do not dispatch.

[3] Dispatch (scheduled_for time)
    Idempotency-Key: payout.id (UUID stable on the row)
    Call Stripe transfers.create with Connect destination.
    On 2xx: status → PROCESSING; store stripe_transfer_id.
    On 4xx with retryable error: retry_count++ up to 5 with exponential backoff.
    On 4xx terminal (KYC reject, account closed): status → FAILED; failure_code captured.

[4] Webhook reconciliation
    Stripe transfer.paid → status PAID, processed_at set.
    Stripe transfer.failed → status FAILED.
    Stripe transfer.reversed → status CLAWBACK_PENDING; see §5.

[5] Reconciled (D+5)
    Daily reconciliation job compares Stripe transfer ledger to platform AffiliatePayout ledger.
    Sets reconciled_at when match. Mismatches → ops alert.
```

### 4.3 Idempotency

- `Idempotency-Key = AffiliatePayout.id` on the Stripe call.
- Row lock during dispatch (advisory lock keyed on payout id) to prevent concurrent dispatch.
- Webhooks are idempotent on `(event_id, payout_id)`; replays do not double-record.

### 4.4 KYC gates

A payout cannot transition `PENDING → PROCESSING` unless:
- `AffiliateAccount.kyc_completed = true`, AND
- `AffiliateAccount.tax_form_collected_at` not null, AND (for US payees) `tax_form_kind = 'W9'`, OR (non-US) `tax_form_kind ∈ {'W8BEN','W8BEN-E'}`, AND
- `AffiliateAccount.status = 'ACTIVE'`, AND
- Stripe Connect `payouts_enabled = true` for the destination.

Blocked payouts go to status `HELD` with `failure_reason` describing the gap, and an in-app + email notification is sent to the affiliate (with PII-safe templates).

### 4.5 1099 / W8 collection

- Trailing-12-month gross commission summed across all currencies (converted to USD at month-end FX); when ≥ $600, the system flags the account `tax_form_state = REQUIRED` and blocks future payouts until W9 collected.
- Non-US affiliates: W8-BEN collected before *first* payout regardless of threshold.
- Tax forms expire after 3 years (W8) — system flags `EXPIRING_SOON` 60 days before expiry, `EXPIRED` after.
- Annual 1099-NEC issuance: PDF generated by Jan 31 of the following year for all US affiliates whose paid-out total in the prior calendar year ≥ $600. Issuance handled by Stripe 1099 service where available; platform retains a copy in encrypted storage.

---

## 5. Refund / clawback after payout

When a Stripe `charge.refunded` arrives for a conversion whose commission has already been included in a `PAID` payout:

1. `AffiliateCommission.clawed_back_at` set; `AffiliateConversion.status = CLAWED_BACK`.
2. Decrement affiliate's running balance (a negative-balance entry is permitted up to a limit).
3. Three recovery paths, in order:
   - **Net against next payout:** preferred — subtract from next month's payable.
   - **Reverse a portion of the original Stripe transfer:** `Stripe transfers.createReversal` with idempotency key `(payout_id, refund_id)`. Used when next payout would not cover within 60 days.
   - **AffiliateClawbackInvoice:** v2 — out of scope here, but the column is reserved on `AffiliateAccount`. v1 falls back to manual ops for affiliates with insufficient future balance.
4. Balance can go negative up to `-$500` USD-equivalent; below that, payouts halt and ops is notified.

---

## 6. Failure modes (≥5)

### 6.1 Stripe transfer fails terminal (KYC withdrawn mid-flight)
- **Detection:** Stripe `transfer.failed` with `failure_code = 'account_invalid'` or `'kyc_required'`.
- **Recovery:** payout `FAILED`; affiliate notified with KYC re-collection link; commissions re-eligible at next sweep when KYC restored.

### 6.2 KYC gap (tax form expired)
- **Detection:** pre-dispatch reconciliation reads `tax_form_collected_at`; expiry computed.
- **Recovery:** payout `HELD`; affiliate prompted; commissions stay COMMISSIONABLE.

### 6.3 Bank reject (insufficient routing info, closed account)
- **Detection:** Stripe `transfer.failed` with bank-level reason.
- **Recovery:** payout `FAILED`; auto-retry x3 with backoff; if still failing, `HELD`; affiliate prompted to update bank details.

### 6.4 Refund-after-payout
- **Detection:** webhook `charge.refunded` after `AffiliatePayout.processed_at`.
- **Recovery:** §5 cascade.

### 6.5 Duplicate transfer (race / replay)
- **Detection:** Stripe `Idempotency-Key` collision; or row-lock observation.
- **Recovery:** advisory-lock + `Idempotency-Key = payout.id` prevents duplicates. If Stripe returns the existing transfer id on replay, treat as no-op success.

### 6.6 Currency mismatch between commission rows in same batch
- **Detection:** sweep groups by currency; mismatch is impossible by construction. If detected via reconciliation, treat as data corruption — ops alert, halt payout to that affiliate.

### 6.7 Reconciliation drift (D+5 mismatch)
- **Detection:** daily reconciliation job: sum of Stripe transfers ≠ sum of platform PAID payouts in the period.
- **Recovery:** drift report to ops; freeze payout dispatch until resolved; never auto-correct ledger.

---

## 7. Anti-fraud at payout time

- **Velocity check:** if an affiliate's monthly payout exceeds 10× their trailing-90-day average, payout enters `HELD` for manual review.
- **First-payout cap:** the first payout to a brand-new affiliate is capped at $1,000 USD-equivalent regardless of accrued balance; remainder rolls to the following month.
- **Blocklist:** payout destinations on the AML / sanctions blocklist are blocked at dispatch.
- **Conversion-quality score:** a per-affiliate score derived from refund rate, dispute rate, and bot-click ratio. Score below threshold (`< 0.5`) sends payout to `HELD` for review.

---

## 8. Security & audit

- Every payout transition writes an `AuditLog` row with `actor`, `before/after_state`, `reason`, `request_id`.
- `AffiliatePayout.ledger_hash` is computed at batch creation (`SHA-256` over sorted commission ids + amount-cents + currency). Any retroactive ledger edit invalidates the hash and surfaces in reconciliation.
- Tax forms encrypted at rest (KMS); access requires admin scope + per-request justification logged.
- Affiliate self-service exports include their tax-form metadata (kind, collected_at, expires_at) but **not** the raw form contents.
- PII-safe webhook payloads to affiliate-configured webhook endpoints (program owner cannot subscribe to affiliate PII).

---

## 9. Performance budgets — payouts

| Stage | 100 | 1 k | 10 k affiliates |
|---|---|---|---|
| Nightly sweep (build payout rows) | < 30 s | < 90 s | < 5 min |
| Pre-dispatch reconciliation | < 10 s | < 30 s | < 90 s |
| Dispatch (Stripe API calls, parallelised batch) | < 30 s | < 5 min (rate-limited by Stripe) | < 30 min |
| Daily reconciliation (D+5) | < 60 s | < 3 min | < 10 min |

Stripe rate-limit class: 100 transfers/sec per account; we throttle to 30/sec to leave headroom. At 10 k affiliates, the 30-min ceiling is achievable with parallelism within rate limits; if affiliate count grows further, sharding by affiliate id range is straightforward.

---

## 10. Migration / backfill

Greenfield. New tables only.
- One existing-table touch: a soft pointer `User.affiliate_account_id` (nullable, indexed). Optional; can be a join. **OWNER decision deferred.** Recommend join until profiling shows pressure.

---

## 11. Rollback plan

- Feature flags at three layers: nightly sweep, dispatch job, webhook handler. Each independently disable-able.
- If a buggy compute is detected post-dispatch, write corrective ledger entries (never UPDATE — append correction rows). Stripe transfers can be reversed via `transfers.createReversal` if needed.
- Pre-dispatch hold window (24 h, OWNER decision §1) provides a final reconciliation pass before money moves.

---

## 12. Test plan

### Unit
- Sweep grouping by currency.
- Threshold check.
- KYC/tax-form gate.
- Ledger hash compute.
- Refund-after-payout recovery cascade (all three paths).
- 1099 trigger threshold.
- W8 expiry detection.

### Integration
- Happy-path: COMMISSIONABLE → PAID → reconciled.
- Stripe transfer failure (KYC withdrawn) → HELD → affiliate completes KYC → next sweep includes.
- Bank reject with retry.
- Refund-after-payout net-against-next-payout.
- Refund-after-payout reverse-original-transfer.
- Concurrent dispatch race.
- Webhook replay (transfer.paid x2).
- Reconciliation drift detection.

### E2E
- Affiliate completes KYC → first payout dispatched at next monthly cycle → arrives in bank → reconciled D+5.
- Tax form expires → next payout `HELD` → renewal flow → re-eligible.
- Affiliate hits 1099 threshold mid-year → next payout blocks until W9 → affiliate provides W9 → payout dispatches.

### Load
- 10 k affiliate dispatch within Stripe rate limits.
- Reconciliation at 12 months of historical PAID payouts (~120 k rows).

### Security
- Tax-form download requires per-request signed URL ≤ 5 min TTL.
- `ledger_hash` tamper detection.
- Audit trail completeness (every transition emits a row).

---

## 13. Day-1 implementation order

1. `AffiliatePayout` migration + audit/idempotency wiring.
2. Nightly sweep job (`payout-sweep`).
3. Pre-dispatch reconciliation (`payout-preflight`).
4. Stripe transfer dispatch (`payout-dispatch`).
5. Webhook handlers (transfer.paid, transfer.failed, transfer.reversed, charge.refunded re-route).
6. Daily reconciliation (`payout-reconcile`).
7. Dashboard summary endpoint + timeseries.
8. Tax-form session start endpoint + state endpoint.
9. Admin overrides (force-pay, force-hold, cancel) — audited.
10. Velocity/quality scoring (anti-fraud at payout time).

---

## 14. Cross-repo dependency map

| Dep | Repo | Surface |
|---|---|---|
| Stripe Connect destination model | `tgp-finance-app` | Re-uses Wave 5 destination wiring; this PR adds a sub-ledger split for affiliates. Detailed Connect routing extensions in `tgp-finance-app/docs/billing/affiliate-payouts.md` (Wave 8 finance branch — out of scope here). |
| Mobile dashboard (read-only) | `growth-project-mobile` | Mirrors `dashboard/summary` and `payouts` listing. No native KYC UI; deep-link to web. |
| Admin payout console | `growth-project-backend` Wave 1 admin | Operator screens for force-hold/release/cancel and reconciliation drift triage. |

---

## 15. Senior-engineer onboarding checklist

- [ ] Read `affiliate-link-spec.md` first; this file extends it.
- [ ] Read `tgp-finance-app/docs/billing/` Wave 5 connect routing.
- [ ] Read TGP `audit-and-gdpr.md`.
- [ ] Verify Stripe Connect Express account constraints (transfer rate-limit 100/sec/acct; we throttle 30/sec).
- [ ] Set up local Stripe webhook listener (`stripe listen --forward-to ...`).
- [ ] Test KMS-key-rotation handling for tax-form bucket.
- [ ] Sit with finance/tax owner for one hour on 1099 timing and W8 renewal cadence.

---

## 16. Open clarifications (none blocking)

All OWNER decisions in §1 are recommendations. Implementation can proceed with the recommendations on file.
