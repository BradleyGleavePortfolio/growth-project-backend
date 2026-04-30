# 05 — Billing packaging & monetization

> **Last reviewed:** 2026-04-30. Docs-only. No runtime change.

## WHY

Today there is one paid plan: a flat coach SaaS subscription via
Stripe, gated by `STRIPE_PRICE_ID_FITNESS`. The mirror schema
(`CoachSubscription`, `Invoice`, `PaymentFailure`,
`StripeProcessedEvent`) is solid. `BILLING_ENFORCEMENT` already
supports `off` / `observe` / `enforce`, with `past_due`,
`canceled`, `paused`, `active`, `trialing`, and `grandfathered`
states.

The next wave of features changes this from "one plan" to
"multiple bundles with feature-level entitlements":

- `fitness_only`, `finance_only`, `performance_os` bundles —
  documented in `docs/entitlements.md` and partially backed by
  the federation envelope (PR series #79/#80).
- AI Program Builder is a **paid add-on** (per `docs/rfcs/ai-program-builder.md`,
  PR #117): per-coach monthly budget cap + per-draft cap +
  per-coach entitlement.
- Team Mode is a **flat-rate** seat model (staff free under
  the owner's seat, per ADR §10 question #4 in PR #118).
- Templates marketplace introduces a **revenue-share** model
  (creator coach gets a cut of each template sale; platform
  takes a fee).
- Public profiles is **bundled** (no separate price; gated by
  bundle).
- Revenue dashboards is **bundled** (OWNER and per-coach views).

Without an explicit packaging brief that says how each new
feature maps to bundle / add-on / revenue-share / free, every
launch becomes a one-off pricing decision and the entitlement
read-model drifts from Stripe's product/price catalog.

**Cross-feature impact:** see the table above. Every active
feature has a billing decision attached.

## WHEN

Settle this brief **before** PR #117 (AI Program Builder) lands
its first runtime PR — that PR introduces the first paid
add-on and is the canary for the bundle/add-on shape.

## WHERE

- `src/billing/` — webhook receiver, mirror tables, guard.
- `docs/entitlements.md` — bundle taxonomy and Phase-2
  override-table shape.
- `docs/stripe-setup.md` — Stripe dashboard configuration.
- `src/admin/federation/` — cross-product (fitness ↔ finance)
  status envelope.
- `src/admin/reports/` — revenue dashboards land here.

## WHO

- **Owner:** founder + backend lead (founder owns pricing;
  backend owns the plumbing).
- **Reviewers:** Stripe-savvy reviewer if engaged.
- **On the hook in production:** OWNER. Stripe-mirror drift is
  triaged via the operator workflow in
  `docs/deploy-runbook.md`.

## WHAT

### What already exists

- Stripe webhook receiver with HMAC verification (no SDK
  runtime dependency).
- Mirror tables (`CoachSubscription`, `Invoice`,
  `PaymentFailure`, `StripeProcessedEvent`).
- `SubscriptionGuard` enforcing `BILLING_ENFORCEMENT`.
- Coach-side billing portal session route.
- Mobile-route `/billing/portal` with login-link fallback (PR
  #116, recently shipped).
- One-time backfill script: `npm run
  backfill:coach-subscriptions` (PR #96).
- Bundle taxonomy in `docs/entitlements.md` plus the additive
  Phase-2 override table proposal.

### What is missing

- A mapping from **bundle** → **Stripe products / prices**.
  Today there is one price (`STRIPE_PRICE_ID_FITNESS`) and one
  reserved price (`STRIPE_PRICE_ID_FINANCE`, currently unused).
  When add-ons land we need a second axis: **add-on prices**
  (Builder, Templates).
- A documented rule for **grandfathering**. The recent
  `CoachSubscription` backfill (PR #96) is the precedent:
  existing coaches with `grandfathered` status continue
  working. A future bundle change must define what "existing
  coaches" sees.
- A documented **dunning posture** — what happens at `past_due`,
  the grace window, the read-only state, and the eventual
  `canceled` state. Today the enforcement modes are
  documented; the customer-facing copy is not.
- A documented **proration posture** — when bundles change
  mid-cycle, how Stripe handles it and what the mirror does.
- A documented **revenue-share** model for templates —
  proposed: Stripe Connect (Express) for creator coaches; the
  platform takes a flat percentage. **This is a future-PR
  question**; the brief just declares the shape so nobody
  designs around it without realizing the constraint.
- A **revenue dashboards** read-model: OWNER sees aggregate
  MRR / churn / dunning across coaches; per-coach view shows
  own MRR (sum of client subscriptions, when client
  subscriptions ship later).

### Bundle → product / price mapping (proposed)

| Bundle | Stripe product | Includes |
|---|---|---|
| `fitness_only` | `STRIPE_PRICE_ID_FITNESS` (existing) | All fitness features. Default for today. |
| `finance_only` | `STRIPE_PRICE_ID_FINANCE` (reserved) | Finance product. Owned by separate finance backend; we mirror status only. |
| `performance_os` | both above | All features across both products. |
| Add-on: Builder | `STRIPE_PRICE_ID_BUILDER` (new) | AI Program Builder. Per-coach monthly. |
| Add-on: Templates Pro | `STRIPE_PRICE_ID_TEMPLATES_PRO` (new, future) | Higher revenue share / better creator tools. |
| Team Mode | seat model on the existing fitness price | Free staff under owner's seat (per PR #118 ADR §10 q4). |

### Dunning posture (proposed)

| State | Coach can do | Customer-facing copy |
|---|---|---|
| `active` / `trialing` / `grandfathered` | All writes | None. |
| `past_due` (within 7-day grace) | All writes; banner shown | "Your subscription needs attention. Update payment in the next 7 days to avoid interruption." |
| `past_due` (past 7-day grace) | Read-only; writes 402 | "Your subscription is past due. Update payment to resume coaching." |
| `paused` | Read-only | "Your subscription is paused. Resume in billing settings." |
| `canceled` | Read-only; 30-day data grace | "Your subscription is canceled. Your data will be removed in 30 days unless you reactivate." |

Customer copy is operator-controlled — the strings live in
`docs/help/` (already an established surface for coach-facing
copy).

## HOW

### Operator handoff

- Stripe products / prices are owned by the founder. The
  operator (OWNER) updates `STRIPE_PRICE_ID_*` env vars in Fly
  before the matching feature flag flips.
- Webhook routing: every product/price → handled by the same
  receiver; the receiver dispatches by `subscription.metadata`
  (proposed) to the right mirror table. Today there is one
  table; add-ons land additive rows.
- OWNER monitors `Invoice` and `PaymentFailure` daily during
  the first month after any bundle change.

### Add-on plumbing

Add-ons map 1:1 to Stripe products. Each add-on has:

- A price id env var (`STRIPE_PRICE_ID_BUILDER`).
- An entitlement key consumed by the lane #01 resolver
  (`builder.draft_program`).
- A per-coach mirror row (`CoachAddonSubscription`, proposed,
  future migration). For the **first** add-on (Builder), the
  mirror can reuse `CoachSubscription` with a `kind` column
  added — we'll choose the simpler shape when the runtime PR
  lands.

### Revenue-share (templates)

The brief reserves the shape. The runtime PR is far in the
future. Today's commitment:

- Stripe Connect Express is the proposed mechanism.
- Platform fee is a flat percentage (founder sets).
- Creator KYC happens via Stripe; we do not collect tax info.
- Mirror table `TemplateSale` (proposed, future) captures the
  Stripe transfer id, creator coach id, buyer coach id,
  template id, gross, fee, net.

**This is documentation only — do not design around it without
re-reading the brief and updating it first.**

## Risks

- **Stripe webhook backfill drift.** Mitigation: the
  one-time backfill script (`npm run
  backfill:coach-subscriptions`) is the precedent; every new
  mirror table ships with a backfill script before
  `BILLING_ENFORCEMENT` is flipped.
- **Bundle change mid-cycle.** Mitigation: Stripe handles
  proration; the mirror reads the new state on the next
  webhook event.
- **Add-on cost runaway** (Builder LLM costs). Mitigation:
  per-coach monthly budget cap is enforced *inside* the
  Builder module (lane #08 — AI governance). Billing is
  decoupled from cost.
- **Revenue-share legal complexity.** Mitigation: out-of-scope
  for this round. The brief reserves the shape; the design is
  re-litigated when templates marketplace is in flight.

## Dependencies

- Lane #01 (resolver) — entitlement decisions flow through it.
- Lane #07 (migration safety) — every new mirror table follows
  the additive shape.
- Lane #10 (analytics) — revenue dashboards consume the
  analytics read-model.

## Acceptance criteria

1. ✅ `docs/entitlements.md` is extended with the bundle →
   product / price table above.
2. ✅ `docs/stripe-setup.md` is extended with the dunning
   posture table.
3. ✅ A new section "Add-ons" in `docs/entitlements.md`
   documents the Builder add-on (this is a *future-runtime*
   contract; document only).
4. ✅ The grandfather rule is documented (one paragraph in
   `docs/entitlements.md`) — what triggers it, who sets it,
   how it composes with bundle changes.
5. ✅ The revenue-share shape for templates is documented as
   "reserved" with the proposed mechanism.

## Test strategy

- **Unit:** existing `SubscriptionGuard` tests cover today's
  enforcement modes. New entitlement keys (`builder.*`,
  `team.*`) are covered when their runtime PRs ship.
- **Integration:** Stripe webhook smoke (`scripts/`) is
  extended per add-on.
- **Manual:** before any bundle change ships, OWNER runs an
  end-to-end Stripe checkout in test mode and verifies the
  mirror updates.

## Rollout & kill-switch

- Bundle changes ship behind `BILLING_ENFORCEMENT=observe`
  for ≥7 days before flipping to `enforce`.
- Add-ons ship behind their own kill-switch flag (e.g.,
  `BUILDER_ENABLED=false`) on top of the entitlement check.
- Kill switch for the entire billing layer:
  `BILLING_ENFORCEMENT=off` reverts to the pre-enforcement
  posture (everyone allowed). This is documented as the P0
  escape hatch and should be used only with OWNER's
  knowledge.
