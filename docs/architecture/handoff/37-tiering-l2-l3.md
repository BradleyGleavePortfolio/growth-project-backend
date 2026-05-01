# Handoff brief 37 — L2 / L3 tiering, entitlements, and white-glove

> Operator-facing pre-work brief for expansion-roadmap item **#37**.
> Companion to the engineer-facing spec at
> [`../../specs/tiering-l2-l3.md`](../../specs/tiering-l2-l3.md).
> Read this brief first, then the spec.

**Status:** In discovery — spec drafted, no runtime code merged.
**Last updated:** 2026-05-01.
**Roadmap row:** [`expansion-wave-coach-experience.md` row 37](../expansion-wave-coach-experience.md).

---

## WHY

The platform sells one flat SaaS plan today. The expansion
wave (#30–#36) introduces features with real cost gradients
(challenges, content boards) and explicitly premium services
(white-glove intake, marketing support, hiring/team support,
branded instances). Without a tier axis, the only knob is
"deny everyone the new features."

The existing entitlement read model
([`docs/entitlements.md`](../../entitlements.md)) already
separates `bundle` (fitness vs finance vs performance_os) and
per-product status. Adding a `tier` axis (L1 / L2 / L3) on
top is **additive** — existing consumers ignore the new field
until they read it. See spec §2.

## WHEN

Gated on:

1. PR #117 §15 review (cost ceilings; the AI Program
   Builder is tier-gated).
2. Every spec in this wave reviewed; each names a feature
   flag and a quota that this spec is the source of truth
   for.
3. PR #120 lane 05 review (billing/packaging).
4. Founder approval of the L1 / L2 / L3 matrix in spec §8.
5. Stripe products + prices for L2 + L3 created in the
   dashboard per
   [`../../stripe-setup.md`](../../stripe-setup.md).
6. Backend lead approval of the white-glove credit ledger
   shape and audit envelope.

## WHERE

- **Module changes (additive):** `src/admin/entitlements/`
  gains a `TierService` and a new `tier` field on the read
  shape; `src/billing/` gains the L2 / L3 webhook handlers.
- **New module:** `src/tiers/` (spec §4).
- **New tables:** `AccountTierState`,
  `AccountTierFeatureOverride`, `WhiteGloveCredit`,
  `WhiteGloveCreditLedger`, `BrandedInstance`.
- **Existing read shape extension:** every
  `/api/admin/.../entitlements` endpoint gains
  `tier`, `tier_source`, `feature_quotas`,
  `white_glove_credits`, `branded_instance` fields.
- **New env vars:** see spec §4 — `STRIPE_PRICE_ID_L2_*`,
  `STRIPE_PRICE_ID_L3_*`, `BRANDED_BASE_DOMAIN`,
  `WHITE_GLOVE_OPS_EMAIL`. All optional in dev.
- **Routes:** `/api/me/tier`,
  `/api/admin/coaches/:id/tier/promote`,
  `/api/admin/coaches/:id/credits/grant`,
  `/api/admin/coaches/:id/branded/enable`. See spec §4.

## WHO

- **Owner / decision-maker:** founder for the L1 / L2 / L3
  matrix, white-glove credit catalog, branded-instance scope;
  backend lead for the override-table contract and
  Stripe-side wiring; legal for the white-glove SLA wording;
  product for the upgrade-CTA UX.
- **On the hook for runtime work:** backend platform.
- **Audience:** every spec in this wave (each is tier-gated),
  spec #29 (segments coaches by tier), the OWNER admin
  console (tier promotion UI), the mobile + console clients
  (tier badge + quota nudges).

## WHAT

**Already exists:**

- Spec at [`../../specs/tiering-l2-l3.md`](../../specs/tiering-l2-l3.md).
- `docs/entitlements.md` — including the Phase-2
  override-table sketch this spec lifts to a migration plan.
- `src/admin/entitlements/entitlements.types.ts` — the read
  shape this spec extends.
- The `CoachSubscription` mirror tables and
  `SubscriptionGuard`.
- The OWNER federation envelope.

**Still to be produced:**

- Migration adding the five new tables.
- The `feature-matrix.ts` module (L1 / L2 / L3 quotas as
  code; future migration into a table is forward-compatible
  via the override row).
- The Stripe webhook → tier mapping.
- The OWNER promote / demote / grant / branded routes
  (audited).
- The override-expiry sweep job.
- The branded subdomain validator (DNS deferred).

## HOW

PR-1 lands the migration + the read-shape extension only —
*every coach reads as L1*, the matrix is loaded but no
behavior changes. This zero-impact PR unblocks every other
spec in this wave to start consuming the read shape.

Six-phase rollout per spec §7. Acceptance criteria in spec
§15. Master flags: `TIERING_ENABLED`,
`WHITE_GLOVE_CREDITS_ENABLED`, `BRANDED_INSTANCE_ENABLED`.
All flip to `on` only at Phase 6, after the upper-tier
features (#30, #33, #34) are operational.

The ops handoff in spec §16 covers the operator dashboards,
the alert list, and the kill switches — particularly the
"unconsumed white-glove credits aged > 14 days" tile that
catches the human-workflow side of L3 commitments.
