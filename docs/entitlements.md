# Product Entitlements

Status: **Phase 1 — read model only**. No new tables. No destructive migration.

This document describes how the platform represents *product entitlements*
— the answer to "what does this account have access to right now?" — and
how the OWNER-only admin console renders that state.

## Why a first-class entitlement concept

Until now, the admin console inferred product access by reading two
different sources independently:

- The fitness side looked at `User.role` / `User.archived_at` / the coach
  `CoachSubscription.status` mirror.
- The finance side called `FinanceAdminClient` and trusted whatever
  outcome came back.

That worked for two products but it hard-codes the question "is finance
reachable?" into "is the customer entitled to finance?" — those are not
the same. And it had no shared notion of `performance_os` (the bundle SKU
sold as fitness + finance) or of operator/GDPR suspension.

The entitlement read model fixes this by folding the existing signals
into one stable shape that the admin UI can render without recomputing.

## Shape

The read shape lives in
[`src/admin/entitlements/entitlements.types.ts`](../src/admin/entitlements/entitlements.types.ts):

```ts
{
  active_products: ['fitness' | 'finance'],
  bundle: 'none' | 'fitness_only' | 'finance_only' | 'performance_os',
  overall: 'active' | 'past_due' | 'canceled' | 'suspended' | 'inactive' | 'unknown',
  products: {
    fitness: { product, status, reason, detail? },
    finance: { product, status, reason, detail? },
  },
  account_suspended: boolean,
}
```

Per-product `status` values:

- `trialing` — Stripe `trialing`
- `active` — Stripe `active` (or finance record present)
- `past_due` — Stripe `past_due` or `unpaid` (still grants access during dunning)
- `canceled` — Stripe `canceled`, or fitness `User.archived_at` set
- `suspended` — Stripe `paused`, or account-level override
- `inactive` — no record on this side, or `User.deleted_at` set
- `unknown` — finance call was degraded (timeout / 5xx / not_configured / etc.)

`unknown` is **never** silently downgraded to `inactive`. The admin UI
must render it as "temporarily unavailable" so an operator can see the
finance backend is unreachable instead of being misled into thinking the
customer cancelled.

## Where it shows up

The same `entitlements` block is attached to every record-level admin
endpoint:

- `GET /api/admin/clients/:id` and `GET /api/admin/clients/:id/unified`
- `GET /api/admin/coaches/:id/overview`
- `GET /api/admin/federation/clients/lookup?email=...`
- `GET /api/admin/federation/coaches/lookup?email=...`

Two dedicated thin endpoints exist for the console's entitlement chip /
"Plan & Access" tab:

- `GET /api/admin/clients/:id/entitlements` →
  `{ user_id, email, entitlements }`
- `GET /api/admin/coaches/:id/entitlements` →
  `{ user_id, email, entitlements }`

All routes are `OWNER`-gated by `JwtAuthGuard + RolesGuard + @Roles('owner')`
exactly like the rest of `/api/admin/*`.

## Account-level suspension

Two signals collapse every product to `suspended` regardless of
subscription state:

- `User.deletion_scheduled_at` set → GDPR grace period; account locked but
  recoverable. `entitlements.overall = 'suspended'`,
  `account_suspended = true`. The original per-product status is preserved
  in the per-product `detail` field for forensics.
- (Reserved) operator-suspension flag — see "Phase 2" below.

`User.deleted_at` set is **inactive**, not suspended. The PII has been
scrubbed; there is no longer an account to "suspend".

## Inputs and trust

`EntitlementsService.resolve` is a pure function. It takes:

1. A `FitnessAccountSnapshot` projected from the fitness `User` row plus
   the `CoachSubscription.status` string (when role=coach).
2. The raw `FinanceCallOutcome` from `FinanceAdminClient`.

That last point is critical: the resolver is the **only** thing that maps
finance call outcomes into entitlement statuses. The admin UI does not
get to interpret a degraded outcome as "finance churned".

## Phase 1 vs Phase 2

This PR ships Phase 1: a read-only resolver wired into the admin surface.
No database changes, no destructive migration.

Phase 2 (future work) will add a small additive Postgres table to support
operator overrides and explicit comp grants. The expected shape — kept
here so a future migration is mechanical — is:

```sql
CREATE TABLE "AccountEntitlementOverride" (
  "id"                    TEXT PRIMARY KEY,
  "user_id"               TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "product"               TEXT NOT NULL,        -- 'fitness' | 'finance'
  "override_status"       TEXT NOT NULL,        -- 'active' | 'suspended' | 'comp'
  "reason"                TEXT NOT NULL,        -- operator-supplied
  "starts_at"             TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "ends_at"               TIMESTAMP(3),
  "created_by_owner_id"   TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  CONSTRAINT "AccountEntitlementOverride_user_product_active_uq"
    EXCLUDE USING gist (
      "user_id" WITH =,
      "product" WITH =,
      tstzrange("starts_at", COALESCE("ends_at", 'infinity'::timestamptz)) WITH &&
    )
);
CREATE INDEX "AccountEntitlementOverride_user_id_idx"
  ON "AccountEntitlementOverride"("user_id");
CREATE INDEX "AccountEntitlementOverride_product_idx"
  ON "AccountEntitlementOverride"("product");
```

Operator steps for that future migration:

1. Apply the migration (additive, no data loss).
2. Backfill `AccountEntitlementOverride` rows for any manually-comp'd
   accounts from the audit log.
3. `EntitlementsService.resolve` will gain a third input
   (`overrides: AccountEntitlementOverride[]`) and apply them after the
   subscription-derived status. This is wire-compatible — the read shape
   doesn't change.

Until that lands, no migration is needed. The Phase 1 resolver is purely
derived and ships safely on top of existing rows.

## Testing

- Unit coverage: [`test/entitlements.service.spec.ts`](../test/entitlements.service.spec.ts)
  — 22 tests covering bundle classification, coach subscription status
  mapping (active/trialing/past_due/canceled/paused/null/unknown),
  degraded-finance handling, and account-level suspension.
- Integration coverage: [`test/federation.service.spec.ts`](../test/federation.service.spec.ts)
  ("FederationService — entitlement attachment") — asserts the read shape
  is attached to every unified response and reacts correctly to
  finance-degraded outcomes.
- Console coverage: [`test/admin-console.service.spec.ts`](../test/admin-console.service.spec.ts)
  — `getClientEntitlements` / `getCoachEntitlements` propagate user_id +
  entitlement block and 404 for non-coach roles.

## Operator notes

- `entitlements.overall = 'unknown'` does **not** mean "the customer has
  no subscription". It means we couldn't reach the finance backend
  (timeout, 5xx, or finance not configured). Check
  `GET /api/admin/finance/health` and the `FINANCE_API_BASE_URL` /
  `FINANCE_SERVICE_TOKEN` env vars before drawing conclusions.
- When `account_suspended = true`, the per-product `detail` field carries
  the prior status (`prior_status=active/subscription_active`, etc.). Use
  that to confirm what state the account was in before the GDPR delete
  was scheduled.
- `bundle = 'performance_os'` is the marketing label for "active fitness
  AND active finance" — it is *derived*, not a separately-priced SKU. Do
  not look for a `performance_os` Stripe price; there isn't one.
