# Spec — L2 / L3 tiering, entitlements, and white-glove

**Roadmap row:** #37.
**Status:** Pre-work — spec only; no runtime, no migration, no
module wiring.
**Handoff brief:** [`../architecture/handoff/37-tiering-l2-l3.md`](../architecture/handoff/37-tiering-l2-l3.md).
**Cross-references:** merged
[`docs/entitlements.md`](../entitlements.md) (existing read
model, Phase-2 override-table sketch); merged
`src/admin/entitlements/`; merged `src/billing/`; PR #120
platform-readiness lane 05 (billing/packaging); PR #117 §15
(cost controls); PR #121 spec
[`revenue-dashboard.md`](./revenue-dashboard.md) (#29).

---

## 1. Status

Partial / extension feature. The entitlement read model exists
in production and exposes a per-product status; a first-class
*tier* axis (L1 / L2 / L3) layered above per-product status
does not. The Phase-2 override table is *sketched* in
`docs/entitlements.md` but not migrated. See
[`../architecture/gap-map-coach-experience.md`](../architecture/gap-map-coach-experience.md)
§"Row #37."

## 2. WHY

The platform sells one SKU today: a flat coach SaaS plan
(`STRIPE_PRICE_ID_FITNESS`). Every feature is on-or-off; every
coach sees the same surface. This is not survivable for the
expansion wave because:

- **Some features have a real cost gradient.** Challenges (#30)
  and content boards (#33) consume storage and compute per coach.
  A free-tier (L1) coach with 2 clients should not cost as much
  to serve as an L3 coach with 50 clients and 8 active
  challenges. Without a tier, the only knob is "deny everyone
  the new features."
- **Some features are explicitly premium.** White-glove intake
  ("we will set up your first regimen for you"), L3 marketing
  support ("we will produce a launch newsletter"), hiring/team
  support ("we will help you onboard your first assistant
  coach"), branded-instance access ("your subdomain at
  `coach.tgp.app`") — these are services with human cost. They
  must be opt-in and tier-gated.
- **The entitlement read model already does the structural
  work.** It cleanly separates `bundle` (fitness vs finance vs
  performance_os), per-product `status`, and account
  suspension. Adding a `tier` axis on top is *additive*; the
  existing consumers ignore the new field until they read it.

This spec lifts the Phase-2 sketch in `docs/entitlements.md`
into a concrete migration plan, defines the L1 / L2 / L3
feature matrix, and adds the credit-allowance and white-glove
scaffolding needed to operate the upper tiers.

## 3. WHEN

Trigger conditions:

1. PR #117 §15 (cost controls) is reviewed; the AI Program
   Builder will be tier-gated, so its cost ceiling depends on
   tier. The two specs converge on the per-tier monthly cap.
2. Spec #30, #31, #33, #34, #35, #36 are reviewed; each one
   names a feature flag and a quota that this spec is the
   source of truth for.
3. PR #120 lane 05 (billing/packaging) is reviewed for the
   pricing structure.
4. Founder approves the L1 / L2 / L3 matrix in §8.
5. Stripe products + prices for L2 + L3 are created in the
   Stripe dashboard (per
   [`../stripe-setup.md`](../stripe-setup.md)).
6. Backend lead approves the white-glove credit ledger
   shape and the audit envelope.

## 4. WHERE

- **Module changes (additive):** `src/admin/entitlements/`
  gains a `TierService` and a `tier` field on the read shape;
  `src/billing/` gains the L2 / L3 webhook handlers and the
  white-glove credit consumer.
- **New module:** `src/tiers/` —
  `tiers.module.ts`,
  `tiers.service.ts`,
  `feature-matrix.ts`,
  `credits.service.ts`,
  `branded.service.ts`.
- **New tables:**
  `AccountTierState`,
  `AccountTierFeatureOverride`,
  `WhiteGloveCredit`,
  `WhiteGloveCreditLedger`,
  `BrandedInstance`.
- **New columns on read shape:** the `entitlements` envelope
  (returned by every `/api/admin/.../entitlements` route)
  gains:
  - `tier`: `"L1" | "L2" | "L3"`
  - `tier_source`: `"stripe" | "owner_override" | "default"`
  - `feature_quotas`: `{ challenges: { max_active: int }, ... }`
  - `white_glove_credits`: `{ marketing: int, hiring: int, intake_hours: int }`
  - `branded_instance`: `{ enabled: boolean, subdomain: string|null }`
- **New routes (paths under `/api/`):**
  - `GET /me/tier` (caller's own tier + quotas)
  - OWNER:
    - `GET /admin/coaches/:id/tier`
    - `POST /admin/coaches/:id/tier/promote` (audited override)
    - `POST /admin/coaches/:id/tier/demote`
    - `POST /admin/coaches/:id/credits/grant`
    - `POST /admin/coaches/:id/branded/enable`
    - `POST /admin/coaches/:id/branded/disable`
- **New env vars:**
  - `STRIPE_PRICE_ID_L2_FITNESS` (prod-tier, optional in dev)
  - `STRIPE_PRICE_ID_L3_FITNESS` (prod-tier, optional)
  - `STRIPE_PRICE_ID_L2_FINANCE` (optional, finance vertical)
  - `STRIPE_PRICE_ID_L3_FINANCE` (optional)
  - `BRANDED_BASE_DOMAIN` (optional; default `coach.tgp.app`)
  - `WHITE_GLOVE_OPS_EMAIL` (optional; receives credit-grant
    notifications)

## 5. WHO

- **Sign-off:** founder for the L1 / L2 / L3 matrix, the
  white-glove credit catalog, and the branded-instance scope;
  backend lead for the override-table contract and the
  Stripe-side wiring; legal for the white-glove SLA wording;
  product for the upgrade-CTA UX.
- **On the hook:** backend platform.
- **Downstream consumers:** every spec in this wave (each is
  tier-gated); spec #29 (revenue dashboard segments coaches
  by tier); the OWNER admin console (tier promotion UI); the
  mobile + console clients (rendering quota nudges).

## 6. WHAT

**Already exists:**

- `docs/entitlements.md` — including the Phase-2 override-table
  sketch this spec lifts to a migration plan.
- `src/admin/entitlements/entitlements.types.ts` — the read
  shape this spec extends.
- The `CoachSubscription` mirror tables and the
  `SubscriptionGuard`.
- The OWNER federation envelope.

**New surface:**

- The tier axis (L1 / L2 / L3) on the entitlement envelope.
- The `AccountTierState` mirror (keyed off Stripe price ids).
- The `AccountTierFeatureOverride` table (per-feature override
  for quirky cases — e.g., a beta coach gets challenges quota
  bumped without a tier change).
- The `WhiteGloveCredit` ledger.
- The `BrandedInstance` placeholder (no DNS work in this PR).
- The OWNER promote / demote / grant / branded routes.
- The feature-matrix module: a single file containing the
  L1 / L2 / L3 quotas read by every guarded feature.

**Non-goals:**

- DNS / TLS for branded subdomains. The `BrandedInstance` row
  exists; the subdomain string is stored; the actual DNS
  provisioning is parked for a later wave.
- White-glove *delivery* automation. The credit ledger
  records grants and consumption; the actual operator
  workflow (email an ops mailbox, schedule a call) is
  manual.
- L4 / enterprise. Reserved for a later wave.
- Discounting / coupons. Stripe handles those at the
  subscription level; the tier read shape does not encode
  discount state.

## 7. HOW

Smallest first PR: the migration + the read-shape extension
(every entitlement endpoint returns `tier="L1"` and the
documented `feature_quotas` for L1) — *zero behavioral change*
because L1 quotas match today's surface for every feature
flag set to `off`. This unblocks every other spec in this
wave to start consuming the read shape before the upgrade
flow lands.

Rollout phases:

1. **Phase 1 — read-shape extension (no behavior).**
   Migration adds the four new tables; every entitlement
   endpoint returns L1 + the L1 feature matrix; no upgrade
   flow.
2. **Phase 2 — Stripe webhook wiring for L2.** The
   subscription webhook detects the L2 price id and writes
   `AccountTierState.tier='L2'`. Every spec's feature flag
   reads from the matrix.
3. **Phase 3 — owner override.** OWNER promote / demote /
   override routes. Audit + email to founder.
4. **Phase 4 — credit ledger.** Grant + consume routes;
   feature-side consumers (#30, #33, etc.) check ledger
   before applying L3-only paths.
5. **Phase 5 — L3 + white-glove + branded.** L3 webhook;
   branded-instance row + subdomain validation (no DNS);
   white-glove ops email handler.
6. **Phase 6 — flip default flags.** Every spec's feature
   flag flips from `off` to `on` for the tiers that gate
   it on (e.g., `CHALLENGES_ENABLED=on` ships at Phase 6
   *because* the tier gate now reads-and-rejects correctly).

Feature flags (master):
- `TIERING_ENABLED` (`off` | `read_only` | `on`).
- `WHITE_GLOVE_CREDITS_ENABLED` (`off` | `on`).
- `BRANDED_INSTANCE_ENABLED` (`off` | `on`).

## 8. Data model sketch

### Tier matrix

The matrix is **code, not data** in the first cut: a single
TypeScript module exports the per-tier quotas. This is
deliberate — a quota change is a code change, gated by code
review.

```ts
// src/tiers/feature-matrix.ts (sketch — not committed by this PR)
export const TIER_MATRIX = {
  L1: {
    label: "Solo",
    challenges: { max_active: 0,  max_participants: 0 },
    leaderboards: { public: false },
    content_boards: { max_count: 0,  byte_ceiling_mb: 0 },
    regimens: { max_count: 0,  max_weeks: 0 },
    assignments: { max_active: null }, // inherit from existing client cap
    avatar: { max_size_mb: 5 },
    ai_program_builder: { monthly_drafts: 0 }, // PR #117 §15
    public_coach_profile: { enabled: false },
    white_glove: { intake_hours: 0, marketing_credits: 0, hiring_credits: 0 },
    branded_instance: { allowed: false },
  },
  L2: {
    label: "Studio",
    challenges: { max_active: 3,  max_participants: 50 },
    leaderboards: { public: true },
    content_boards: { max_count: 5, byte_ceiling_mb: 500 },
    regimens: { max_count: 10, max_weeks: 26 },
    assignments: { max_active: null }, // inherit
    avatar: { max_size_mb: 10 },
    ai_program_builder: { monthly_drafts: 50 },
    public_coach_profile: { enabled: true },
    white_glove: { intake_hours: 0, marketing_credits: 0, hiring_credits: 0 },
    branded_instance: { allowed: false },
  },
  L3: {
    label: "Practice",
    challenges: { max_active: 20, max_participants: 1000 },
    leaderboards: { public: true },
    content_boards: { max_count: 100, byte_ceiling_mb: 10000 },
    regimens: { max_count: 100, max_weeks: 52 },
    assignments: { max_active: null }, // inherit
    avatar: { max_size_mb: 25 },
    ai_program_builder: { monthly_drafts: 500 },
    public_coach_profile: { enabled: true },
    white_glove: { intake_hours: 4, marketing_credits: 1, hiring_credits: 1 },
    branded_instance: { allowed: true },
  },
} as const;
```

The matrix is read by `tiers.service.ts` and by every feature
guard. A future migration may move it into a database table
(per the `AccountTierFeatureOverride` shape below) but the
default values stay in code.

### Mirror tables

```prisma
enum AccountTier {
  L1
  L2
  L3
}

enum AccountTierSource {
  default          // no Stripe row → L1
  stripe           // derived from Stripe subscription's price_id
  owner_override   // OWNER admin promote/demote
}

model AccountTierState {
  id                          String              @id @default(uuid())
  user_id                     String              @unique
  tier                        AccountTier         @default(L1)
  source                      AccountTierSource   @default(default)
  effective_at                DateTime            @default(now())
  stripe_subscription_id      String?             // mirror; FK by string
  stripe_price_id             String?
  override_reason             String?              @db.Text
  override_expires_at         DateTime?
  created_at                  DateTime            @default(now())
  updated_at                  DateTime            @updatedAt

  user                        User                @relation(fields: [user_id], references: [id], onDelete: Cascade)
  feature_overrides           AccountTierFeatureOverride[]

  @@index([tier])
}

model AccountTierFeatureOverride {
  id                          String     @id @default(uuid())
  tier_state_id               String
  feature_key                 String     // e.g. 'challenges.max_active', 'content_boards.byte_ceiling_mb'
  override_value              Json       // shape depends on the feature key
  reason                      String     @db.Text
  expires_at                  DateTime?
  created_at                  DateTime   @default(now())

  tier_state                  AccountTierState   @relation(fields: [tier_state_id], references: [id], onDelete: Cascade)

  @@index([tier_state_id, feature_key])
  @@unique([tier_state_id, feature_key])
}

enum WhiteGloveCreditKind {
  intake_hours
  marketing
  hiring
}

model WhiteGloveCredit {
  id                          String                  @id @default(uuid())
  user_id                     String
  kind                        WhiteGloveCreditKind
  remaining                   Int
  granted_at                  DateTime                @default(now())
  expires_at                  DateTime?
  source                      String                   // 'tier_grant' | 'manual' | 'promo'
  source_detail               Json?

  user                        User                    @relation(fields: [user_id], references: [id], onDelete: Cascade)
  ledger                      WhiteGloveCreditLedger[]

  @@index([user_id, kind])
}

model WhiteGloveCreditLedger {
  id                          String     @id @default(uuid())
  credit_id                   String
  delta                       Int        // +N grant; -N consume
  reason                      String
  ticket_id                   String?     // external ticket ref (Linear, ops queue)
  created_by_user_id          String
  created_at                  DateTime   @default(now())

  credit                      WhiteGloveCredit   @relation(fields: [credit_id], references: [id], onDelete: Cascade)

  @@index([credit_id, created_at])
}

model BrandedInstance {
  id                          String     @id @default(uuid())
  user_id                     String     @unique   // one branded instance per coach
  subdomain                   String     @unique   // <subdomain>.<BRANDED_BASE_DOMAIN>
  display_name                String?
  primary_color_hex           String?
  enabled                     Boolean    @default(false)
  dns_state                   String     @default("pending")  // 'pending' | 'verified' | 'failed' | 'disabled'
  created_at                  DateTime   @default(now())
  updated_at                  DateTime   @updatedAt

  user                        User       @relation(fields: [user_id], references: [id], onDelete: Cascade)
}
```

The `BrandedInstance` row is created on `POST /branded/enable`
but `dns_state` remains `pending` because this PR does not
implement DNS provisioning.

## 9. API sketch

### Read

`GET /api/me/tier`

Response:
```json
{
  "tier": "L2",
  "source": "stripe",
  "feature_quotas": {
    "challenges": {"max_active": 3, "max_participants": 50},
    "regimens": {"max_count": 10, "max_weeks": 26},
    "content_boards": {"max_count": 5, "byte_ceiling_mb": 500}
  },
  "white_glove_credits": {"intake_hours": 0, "marketing": 0, "hiring": 0},
  "branded_instance": {"enabled": false, "subdomain": null}
}
```

The same envelope is embedded in
`GET /api/admin/coaches/:id/entitlements` under the new
`tier` / `feature_quotas` / `white_glove_credits` /
`branded_instance` fields.

### OWNER promote / demote

`POST /api/admin/coaches/:id/tier/promote`

Request:
```json
{
  "to_tier": "L3",
  "reason": "Beta partner; manual L3 for 90 days",
  "expires_at": "2026-08-01T00:00:00Z"
}
```

Effect:
- Writes `AccountTierState` with `source='owner_override'`,
  `tier='L3'`, `override_expires_at=...`, `override_reason=...`.
- Writes an `AuditLog` entry.
- Grants the L3 white-glove credits per the matrix
  (`WhiteGloveCredit` rows per kind).
- Emails `WHITE_GLOVE_OPS_EMAIL` if set.

### Credits

`POST /api/admin/coaches/:id/credits/grant`

Request:
```json
{ "kind": "marketing", "delta": 1, "reason": "PR #154 ack" }
```

Effect: writes a `WhiteGloveCreditLedger` row; bumps
`remaining` on the matching credit.

`POST /api/me/credits/consume` (deferred to a later PR; not
in Phase 1)

### Branded

`POST /api/admin/coaches/:id/branded/enable`

Request:
```json
{ "subdomain": "alex-coach", "display_name": "Alex Coaching" }
```

Validation:
- Subdomain matches `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`.
- Subdomain is not in a reserved list (`api`, `app`,
  `admin`, `www`, `tgp`).
- The coach is currently L3 (or has an override).

Effect: row created with `dns_state='pending'`. The `enabled`
flag stays false until DNS work in a later wave.

## 10. Rollout / feature flags

- **Env vars:** see §4.
- **Default values** (production at Phase 1):
  - `TIERING_ENABLED=read_only`
  - `WHITE_GLOVE_CREDITS_ENABLED=off`
  - `BRANDED_INSTANCE_ENABLED=off`
- At Phase 6, all three flip to `on`.
- **Stripe wiring.** Until the L2 / L3 price ids exist,
  every coach reads `tier=L1`. The webhook handler is a
  no-op until `STRIPE_PRICE_ID_L2_FITNESS` is set in the
  environment (per `env-validation.ts`).
- **Backfill.** No backfill required at Phase 1 — every
  coach is L1 by default; the row materializes on first
  read.
- **Fan-out order.** Backend (read shape) → BFF → mobile +
  console (render tier badge + quota nudges) → Stripe
  webhook (Phase 2) → OWNER admin (Phase 3+).

## 11. RBAC and privacy

- **Reads.** `/me/tier` is auth'd; admin reads are
  OWNER-gated.
- **Writes.** Promote / demote / grant / branded routes are
  OWNER-only and *audited*. Every write writes an
  `AuditLog` entry per
  [`../audit-and-gdpr.md`](../audit-and-gdpr.md).
- **Override expiry.** `override_expires_at` is honored at
  read time: an expired override falls back to the Stripe
  source. A scheduled job sweeps expired overrides nightly
  and writes an `AuditLog` (`tier_override_expired`).
- **Stripe → tier mapping.** A single source of truth in
  `tiers.service.ts`:
  - `STRIPE_PRICE_ID_FITNESS` → L1 (the existing flat plan)
  - `STRIPE_PRICE_ID_L2_FITNESS` → L2
  - `STRIPE_PRICE_ID_L3_FITNESS` → L3
  - finance variants → same tier classification.
- **GDPR.** Coach delete cascades all five tables.
  `WhiteGloveCreditLedger` rows reference `created_by_user_id`
  which is **not** nulled (audit integrity); the ledger row
  body is the audit record.

## 12. Tests

- **Unit:**
  - Stripe price-id → tier mapping (every documented price
    id; an unknown price id falls back to L1 with a Sentry
    warning).
  - Override expiry: an expired override is invisible.
  - Subdomain validator: every reserved entry rejected;
    every legal entry accepted.
- **Integration:**
  - Webhook receives a subscription with the L2 price id →
    `AccountTierState` updates → `/me/tier` reflects.
  - OWNER promote → `/me/tier` reflects → expiry sweep →
    falls back.
  - Credit grant → ledger increments; manual consume
    (deferred Phase 4) decrements.
- **Smoke:**
  - `/me/tier` returns 200 with at minimum
    `{tier: "L1", source: "default"}`.
- **Manual eval:**
  - Founder verifies the L2 / L3 matrix is correct against
    the strategy memo before Phase 2 ships.

## 13. Risks

- **Tier-gate misfire.** A new feature ships forgetting to
  check the matrix → L1 coach sees L3 surface. Mitigation:
  a single guard pattern (`@TierGate('challenges.max_active')`)
  in code review checklist; CI test enumerates every guarded
  endpoint and asserts it 402s for L1.
- **Stripe price-id misconfig.** A test price id makes it
  into prod; coaches are silently misclassified. Mitigation:
  `env-validation.ts` rejects placeholder values; the
  webhook handler logs an `unknown_price_id` Sentry event
  and falls back to L1 (do-no-harm default).
- **Override expiry sweep stalls.** Mitigation: the sweep is
  idempotent and re-runs nightly; an OWNER-visible report
  surfaces overrides that should have expired but did not.
- **Branded subdomain takeover.** Mitigation: subdomain is
  unique; reserved list; OWNER-only enable; DNS work
  explicitly out of scope of this PR (the row exists, not
  the route).
- **White-glove ops drift.** A coach has marketing credits
  but no operator picks up the email. Mitigation: a tile
  in the OWNER dashboard surfaces unconsumed credits aged
  > 14 days; alerts on > 5 such rows.

## 14. Dependencies

- **Roadmap rows.** Every spec in this wave (#30–#36); spec
  #29 (revenue dashboard); PR #117 §15 (cost controls).
- **Existing modules.** `src/admin/entitlements/`,
  `src/billing/`, `src/audit/`, `src/auth/`.
- **External services.** Stripe (new price ids); OWNER ops
  email (manual workflow).
- **Decisions that must close.**
  - L2 / L3 pricing.
  - White-glove credit catalog (kinds and per-tier grant).
  - Branded subdomain reserved list.
  - Whether L2 includes the AI Program Builder or it is
    L3-only (PR #117 §15 owns this; spec defers).

## 15. Acceptance criteria

1. Migration adds the five tables idempotently with FKs.
2. `/me/tier` returns the correct envelope for L1 / L2 / L3.
3. Stripe → tier mapping handles every documented price id.
4. OWNER promote / demote workflow audits and emails.
5. Override expiry sweep flips back correctly.
6. Branded enable validates the subdomain.
7. Every spec in this wave consumes the matrix without
   re-deriving the quotas.
8. The entitlement read shape change is forwards-compatible
   (existing consumers ignore the new fields).
9. Handoff brief at
   [`../architecture/handoff/37-tiering-l2-l3.md`](../architecture/handoff/37-tiering-l2-l3.md)
   updated.

## 16. Operator handoff

- **Runbook entry** in [`../deploy-runbook.md`](../deploy-runbook.md):
  how to set the L2 / L3 price ids in Fly secrets, how to
  promote a coach, how to grant credits, how to enable a
  branded instance (DNS deferred), how to read the override
  expiry sweep log.
- **Dashboard tiles:**
  - "Coaches by tier."
  - "Active overrides + expiry distribution."
  - "Unconsumed white-glove credits aged > 14 days."
  - "Branded instances pending DNS."
- **Alerts:**
  - Unknown Stripe price id seen on a webhook.
  - Override sweep job error.
  - White-glove ops email bounces.
  - Coach upgrades to L3 (one-shot to founder).
- **Kill switches:**
  - `TIERING_ENABLED=read_only` — entitlements expose tier
    but no upgrade flows.
  - `WHITE_GLOVE_CREDITS_ENABLED=off` — credit endpoints
    return 503.
  - `BRANDED_INSTANCE_ENABLED=off` — branded routes return
    404.
