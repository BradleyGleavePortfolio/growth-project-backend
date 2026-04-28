# admin/entitlements

First-class read model for product entitlements. See
[`docs/entitlements.md`](../../../docs/entitlements.md) for the full
contract, status semantics, and the Phase-2 override-table sketch.

## Files

| File | Purpose |
|---|---|
| `entitlements.types.ts` | Stable typed contract: `AccountEntitlements`, `EntitlementProduct`, `EntitlementStatus`, `EntitlementBundle`, `EntitlementOverall`, `EntitlementReason`, `ProductEntitlement`. |
| `entitlements.service.ts` | `EntitlementsService.resolve(input) → AccountEntitlements`. Pure function — no DB, no HTTP. Folds a fitness-side snapshot and a `FinanceCallOutcome` into the read shape. |

## Wiring

`EntitlementsService` is provided by `AdminModule`. `FederationService`
calls it inline to attach the `entitlements` block to every unified
client and coach response.

`AdminConsoleService` exposes thin reads at
`GET /api/admin/clients/:id/entitlements` and
`GET /api/admin/coaches/:id/entitlements` for consoles that only need
the entitlement chip / "Plan & Access" tab.

## Phase 1 — read only

No new tables. The resolver derives entitlement state from existing
sources of truth:

- `User.role`, `User.archived_at`, `User.deletion_scheduled_at`,
  `User.deleted_at`
- `CoachSubscription.status` (mirror of Stripe)
- `FinanceCallOutcome` from `FinanceAdminClient`

Phase 2 (future PR) adds an additive `AccountEntitlementOverride` table
for operator overrides and explicit comp grants. Migration shape is
documented in `docs/entitlements.md` so the upgrade is mechanical.

## Why this lives in `admin/`

The entitlement read is an admin/operator concern in Phase 1 — the
console renders a "Plan & Access" tab; mobile clients do not consume
it. If a mobile gating use-case appears later, the resolver can be
lifted to `src/common/entitlements/` without changing the contract.
