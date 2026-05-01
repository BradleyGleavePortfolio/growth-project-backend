# Apps Platform — Installation and Billing

Status: DRAFT (docs only)
Wave: 6

## 1. Purpose

Specifies the install/uninstall flow, the billing model for paid apps, the per-app revenue split, Stripe Connect routing for app payouts, refund and clawback handling, trial handling, and the Decimal(14,2) money discipline that all of the above must respect.

This document depends on Wave 5 (sub-coach billing on Connect) for the platform Connect model; this wave extends Connect to a third axis (developer payouts) without disturbing the existing sub-coach split.

## 2. Personas + permission matrix (install/billing slice)

| Action | OWNER (TGP) | COACH | SUB_COACH | CLIENT | ADMIN | DEVELOPER |
|---|---|---|---|---|---|---|
| Install free app | n/a | yes | only if coach grants | no | yes | n/a |
| Install paid app | n/a | yes (own card) | no | no | yes | n/a |
| Uninstall app | n/a | yes | only if coach grants | no | yes | n/a |
| Cancel subscription | n/a | yes | no | no | yes | n/a |
| Request refund | n/a | yes | no | no | yes | n/a |
| Issue refund | yes (TGP staff) | no | no | no | yes | yes (own apps, within window) |
| View payout report | n/a | n/a | n/a | n/a | yes | yes (own apps) |
| Update price | n/a | n/a | n/a | n/a | yes (with review) | yes (with review) |

## 3. Install flow

### 3.1 Happy path (free app)

```
COACH clicks "Install"
   |
   v
GET /api/apps/<app_id>/install/preflight
  - manifest validator
  - capability set diffed against installable scope
  - egress allowlist checked
  - quota tier matched
   |
   v
POST /api/apps/<app_id>/install
  body: { granted_capabilities, scope_overrides? }
   |
   v
- Insert apps_install row (state=pending)
- Provision per-install webhook secret
- Provision per-install KV namespace
- Issue first app_token
- Call lifecycle.on_install hook (worker-side)
- Wait up to 30s for hook to return 2xx
   |
   +---- on_install OK ---->  state=active
   |
   +---- on_install fail --->  state=install_failed
                               (cleanup: delete KV, revoke secret)
```

### 3.2 Happy path (paid one-time)

```
COACH clicks "Install"
   |
   v
preflight (as above)
   |
   v
POST /api/apps/<app_id>/install
  body: { granted_capabilities, payment_intent_token }
   |
   v
- Synchronous Stripe charge for full amount
   - destination: Connect account = developer.stripe_connect_account_id
   - application_fee_amount = platform_share_calc(price, developer_revenue_ytd)
   - currency = manifest.monetization.currency
   - metadata: { install_id, app_id, version }
   |
   +-- charge fail ---> 402 payment_failed; install row not created
   +-- charge ok ----> install row created (state=pending) -> on_install -> active
   |
   v
Audit: record charge_id, amount, application_fee, dev_payout
```

### 3.3 Happy path (paid subscription)

```
COACH clicks "Install"
   |
   v
preflight
   |
   v
POST /api/apps/<app_id>/install
  body: { granted_capabilities, payment_method_token }
   |
   v
- Stripe Subscription created
   - destination: Connect account
   - application_fee_percent = platform_share_calc_percent(developer_revenue_ytd)
   - trial_period_days = monetization.trial_days (if any)
   - currency, interval from manifest
   |
   +-- subscription create fail ---> 402; rollback install attempt
   +-- subscription create ok ---> install row created (state=pending)
                                   -> on_install -> active
                                   -> billing_state = trialing | active
```

### 3.4 Re-install of previously uninstalled app

If install was uninstalled within the last 7 days (GDPR pending-wipe window), re-install offers "restore" path: existing KV and audit log are reattached, billing resumes (no new trial). After 7 days, re-install is a fresh install with a new install_id and a new trial.

## 4. Per-app revenue split — OWNER_DECISION (recommended: 70/30 with first $1k/mo free)

### 4.1 Options considered

#### Option A — 70/30 with first $1k/mo developer revenue free (RECOMMENDED)

Developer keeps 100% of the first $1,000 of monthly revenue per developer (across all their apps). Above $1,000/mo, platform takes 30%, developer keeps 70%.

Pros: matches Apple's Small Business Program (15% under $1M) and Google Play (15% under $1M). Lowest friction for early devs. Aligned with Stripe Connect's flat fee model. Coaches see "100% to developer" prominence early in marketplace.

Cons: more expensive for TGP at scale (developers earning >$1k/mo cost 30% of growth).

#### Option B — Flat 15%

Platform takes 15% on every dollar.

Pros: simple. Mirrors mature App Store flat tier.
Cons: small devs feel taxed from dollar one. Less attractive at launch.

#### Option C — Tiered (15% under $50k/yr, 20% over, 25% over $500k/yr)

Pros: rewards growth.
Cons: more complex; harder to communicate.

### 4.2 Recommendation

**Option A** at Day-1. We re-evaluate after 12 months of data.

### 4.3 Calculation

```ts
function platformShareCalc(amount: Decimal, devYtdRevenue: Decimal): Decimal {
  // Decimal arithmetic; never floats.
  if (devYtdRevenue.lt("1000.00")) {
    // Below threshold for the month: zero platform fee on this charge,
    // unless this charge tips over $1k.
    const thresholdRemaining = new Decimal("1000.00").sub(devYtdRevenue);
    if (amount.lte(thresholdRemaining)) {
      return new Decimal("0.00");
    } else {
      const taxable = amount.sub(thresholdRemaining);
      return taxable.mul("0.30").toFixed(2, Decimal.ROUND_HALF_EVEN);
    }
  }
  return amount.mul("0.30").toFixed(2, Decimal.ROUND_HALF_EVEN);
}
```

- All amounts are `Decimal(14,2)` strings, never `number`.
- Currency is per-row. We do not aggregate across currencies; the YTD threshold is computed per (developer_id, currency).
- Rounding: half-to-even (banker's rounding) for fairness across many small charges.

### 4.4 Stripe Connect routing

- Developer onboards a Connect Express account at dev portal verification.
- Platform fee is set per-charge via `application_fee_amount` (one-time) or `application_fee_percent` (subscription) at create time.
- For the "first $1k/mo free" period, we use `application_fee_amount` with the calculated value (which may be $0).
- For subscriptions that span the threshold mid-month, we re-issue invoice items at month boundary (Stripe billing_cycle_anchor) and recalc.

#### 4.4.1 Edge case: subscription that tips over mid-month

A subscription charge of $29 where developer YTD is $985 splits:
- $15 untaxed (untaxed remaining = $1,000 - $985)
- $14 taxed -> $4.20 platform fee
- application_fee_amount = $4.20
- developer_payout = $24.80

We log the calculation in the audit row.

### 4.5 Currency handling

- Charge currency is the manifest currency.
- Coach must have a payment method in that currency or Stripe handles conversion (Stripe FX margin disclosed at checkout).
- Developer payout currency is whichever currency the Connect account supports for the destination country.
- Conversion costs sit with the developer (Stripe Connect default).

## 5. Refund handling

### 5.1 Coach-initiated refund

Coach has 14 days to request refund for one-time charges; subscriptions follow standard prorated cancel (no refund of past months).

```
COACH requests refund
   |
   v
POST /api/apps/<app_id>/installs/<install_id>/refund
  body: { reason }
   |
   v
- Validate within window
- Open refund record (state=requested)
- Notify developer (webhook + email)
   |
   +-- developer auto-approves (default) --> Stripe refund (full)
   +-- developer manual review (opt-in)  --> wait 72h; auto-approve if no response
   +-- developer rejects                  --> coach can escalate to TGP staff
```

### 5.2 Refund accounting

Refund reverses the original charge AND reverses the platform fee proportionally. Developer balance is debited via `application_fee_refund` Stripe API.

```ts
// Original charge: $29, platform fee $8.70, dev payout $20.30
// Full refund: 
//   - charge refunded $29 -> coach
//   - platform fee refunded $8.70 -> developer balance net 0 from platform
//   - dev payout refunded $20.30 -> debited from developer Connect balance
//   - if developer balance insufficient -> reverse-debit (Stripe handles or escalates)
```

If a developer's Connect balance can't cover the refund, the refund is held; developer is contacted; after 14 days, TGP staff arbitrate.

### 5.3 Partial refund

Supported for subscriptions (e.g. clawing back N days of the current period). Computed pro rata. Same fee proportionality.

### 5.4 TGP-initiated clawback

If we discover an app violated terms (banned category usage, security issue), TGP staff can clawback all charges in the past 90 days. Audit-logged. Affected coaches are refunded; developer balance debited.

## 6. Trial handling

### 6.1 Trial declarations

- Manifest `monetization.trial_days` (0..30).
- Subscription apps only.
- One trial per (coach, app) lifetime. Re-installing does not grant a new trial.

### 6.2 Trial state

| State | Billing | Surfaces |
|---|---|---|
| trialing | no charge | full access |
| active | charged at interval | full access |
| past_due | charge failed; 7-day grace | reduced access (read-only) |
| canceled | n/a | uninstall path |

### 6.3 Trial -> active

At trial end, Stripe attempts charge. On success: `active`. On fail: `past_due`, retry up to 4 times over 7 days, then auto-cancel (uninstall) unless coach updates payment method.

### 6.4 Cancel during trial

Coach cancels during trial -> immediate uninstall, no charge.

## 7. Uninstall flow

### 7.1 Coach-initiated uninstall

```
COACH clicks "Uninstall"
   |
   v
- Confirmation modal (with "Uninstall" or "Cancel")
- For paid: explain billing implications:
   - one_time: no further charge; refund window if within 14 days
   - subscription: cancel at period end (default) or immediate (opt-in)
   |
   v
POST /api/apps/<app_id>/installs/<install_id>/uninstall
  body: { mode: "at_period_end" | "immediate", reason? }
   |
   v
- For subscription: Stripe subscription set to cancel_at_period_end OR canceled now
- install state = uninstalled
- on_uninstall hook called
- KV scheduled for wipe in 7 days (undo window)
- Webhooks paused
- Scheduled jobs cancelled
- App tokens revoked
```

### 7.2 Developer-initiated uninstall (rare)

Developer can request mass uninstall (delisting + force uninstall). Only ADMIN can execute. Used when an app is being shut down. 30-day notice required to coaches.

### 7.3 Auto-uninstall (subscription canceled, payment failed past grace)

```
trial_end -> charge fails 4x -> auto-cancel
   |
   v
- Same as coach-initiated uninstall, mode=at_period_end
- Coach gets explanatory email (not just "uninstalled")
```

### 7.4 GDPR-safe uninstall

Within 7 days post-uninstall:
- Per-install KV deleted.
- Per-install secrets deleted.
- Webhook DLQ entries dropped.
- Audit-log rows older than 90 days deleted.
- Audit-log rows within 90 days pseudonymized (install_id replaced with hash).

App developer notified of the wipe completion.

## 8. Schema deltas (illustrative; no migration this wave)

```prisma
model AppInstall {
  id                       String    @id @default(cuid())
  app_id                   String
  app_version              String
  org_id                   String
  installed_by_user_id     String
  state                    String    // "pending" | "active" | "suspended" | "auto_suspended" | "uninstalled" | "install_failed"
  granted_capabilities     Json      // string[]
  scope_root               String
  cap_set_hash             String
  webhook_secret_kms_id    String
  kv_namespace             String
  auto_upgrade             String    // "patch" | "minor" | "manual"
  monetization_model       String    // "free" | "one_time" | "subscription"
  stripe_charge_id         String?
  stripe_subscription_id   String?
  billing_state            String?   // "trialing" | "active" | "past_due" | "canceled" | null
  trial_ends_at            DateTime?
  uninstall_reason         String?
  uninstalled_at           DateTime?
  wipe_scheduled_at        DateTime?
  created_at               DateTime  @default(now())
  updated_at               DateTime  @updatedAt

  @@unique([app_id, org_id])
  @@index([state])
  @@index([wipe_scheduled_at])
}

model AppCharge {
  id                          String   @id @default(cuid())
  install_id                  String
  app_id                      String
  developer_id                String
  stripe_charge_id            String   @unique
  /// Decimal(14,2) string. Currency on row.
  amount                      Decimal  @db.Decimal(14, 2)
  currency                    String
  /// Decimal(14,2) string. Platform fee for this charge.
  platform_fee                Decimal  @db.Decimal(14, 2)
  /// Decimal(14,2) string. Developer payout = amount - platform_fee.
  developer_payout            Decimal  @db.Decimal(14, 2)
  /// YTD revenue snapshot at time of charge (for audit).
  developer_ytd_revenue_pre   Decimal  @db.Decimal(14, 2)
  developer_ytd_revenue_post  Decimal  @db.Decimal(14, 2)
  status                      String   // "succeeded" | "refunded" | "partially_refunded" | "failed"
  occurred_at                 DateTime
  created_at                  DateTime @default(now())

  @@index([developer_id, occurred_at])
  @@index([install_id, occurred_at])
}

model AppRefund {
  id                  String   @id @default(cuid())
  charge_id           String
  install_id          String
  app_id              String
  /// Decimal(14,2) string.
  amount              Decimal  @db.Decimal(14, 2)
  /// Decimal(14,2) string. Platform fee refund (clawback).
  platform_fee_refund Decimal  @db.Decimal(14, 2)
  /// Decimal(14,2) string. Developer payout refund (debit).
  developer_debit     Decimal  @db.Decimal(14, 2)
  reason              String
  status              String   // "requested" | "approved_developer" | "approved_auto" | "approved_admin" | "processed" | "rejected"
  requested_at        DateTime @default(now())
  processed_at        DateTime?

  @@index([charge_id])
  @@index([install_id])
}
```

GDPR cascade: delete on `Org` cascades `AppInstall`. Pseudonymize after 90d.

## 9. Failure modes (>=5)

### 9.1 Stripe down at install time

Detection: charge create returns `service_unavailable`.
Recovery: surface inline error; do not create install row; coach retries.

### 9.2 on_install hook times out

Detection: 30s wall-clock cap.
Recovery: install marked `install_failed`; cleanup runs; coach can retry.

### 9.3 Subscription charge fails after activation

Detection: Stripe webhook `invoice.payment_failed`.
Recovery: state = `past_due`; 7-day grace with reduced access; auto-cancel after grace.

### 9.4 Refund larger than developer balance

Detection: Stripe `application_fee_refund` returns `insufficient_balance`.
Recovery: refund held; developer notified; TGP staff arbitrate within 14 days. Coach receives provisional refund from TGP reserve if approved.

### 9.5 Currency mismatch (coach card USD, app priced EUR)

Detection: charge create attempt notes currency mismatch.
Recovery: Stripe automatically converts; FX margin disclosed at checkout. Developer payout uses charge currency.

### 9.6 Coach uninstalls then re-installs within 7 days

Detection: install lookup finds wipe_scheduled_at not yet elapsed.
Recovery: re-install offers "restore" path; reverts wipe; subscription re-activates without new trial.

### 9.7 Manifest pricing changes between coach's "view" and "click install"

Detection: `version_pinned_against_call`. The manifest version pinned at preflight differs from the manifest version at install POST.
Recovery: 409 conflict; coach sees the new price, must confirm again.

### 9.8 Developer's Connect account suspended

Detection: charge create returns `account_suspended`.
Recovery: install fails; no charge; coach told app is temporarily unavailable. App auto-marked `delisted` after 24h of consecutive failures.

## 10. Audit (install/billing slice)

Every install/uninstall, every charge, every refund, every state transition is audited. Audit retention: 7 years for install/charge/refund events (legal/billing).

## 11. Performance budgets (install/billing slice)

| Operation | p50 | p95 |
|---|---|---|
| Preflight | 100 ms | 300 ms |
| Install (free) | 800 ms | 2,000 ms |
| Install (paid one-time) | 1,500 ms | 4,000 ms |
| Install (subscription) | 1,500 ms | 4,000 ms |
| Uninstall | 500 ms | 1,500 ms |
| Refund processing | 800 ms | 2,500 ms |
| Per-install state read | 20 ms | 80 ms |

## 12. Test plan (install/billing slice)

- **Unit**: revenue split function across thresholds, currencies, partial refunds; state machine transitions; idempotency on install POST.
- **Integration**: full install/uninstall lifecycle with Stripe test fixtures; trial -> active; trial -> cancel; subscription past_due -> auto-cancel; refund flows (auto-approve, manual review, reject).
- **E2E**: developer publishes paid app, coach installs with card, charge succeeds, install activates, coach uses for 5 days, requests refund, refund processes, install ends.
- **Load**: 100 installs/sec sustained; revenue split function < 1 ms.
- **Compliance**: GDPR wipe verification 7 days after uninstall.

## 13. Migration / backfill

No backfill. New tables.

## 14. Rollback

Feature flags:
- `apps.install.enabled` (gates install POST entirely)
- `apps.install.paid.enabled` (gates paid install path)
- `apps.refund.coach_initiated.enabled`

Rolling back disables new installs; existing installs continue (we do not roll back live installs).

## 15. Cross-repo deps

- `tgp-finance-app` (Wave 8 finance half) owns the developer payout ledger view and the YTD revenue source-of-truth. This wave defines the Decimal(14,2) split function and Connect routing; finance owns the reporting, statements, and dispute resolution UI.

## 16. Senior-engineer onboarding (install/billing slice)

- [ ] Can trace one paid install end-to-end: preflight, charge, install row, on_install, active.
- [ ] Knows the 7-day undo window and what survives.
- [ ] Knows that platform fee uses Decimal(14,2) and never floats.
- [ ] Knows the difference between `at_period_end` and `immediate` uninstall for subscriptions.
- [ ] Knows where the YTD revenue threshold check lives (gateway, not Stripe).
