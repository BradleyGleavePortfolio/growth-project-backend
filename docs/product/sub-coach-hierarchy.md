# Sub-coach hierarchy

Status: **draft, docs-only**. Companion to [`README.md`](./README.md) and
[`positioning-whop-ai-for-coaches.md`](./positioning-whop-ai-for-coaches.md).
This is the largest schema, RBAC, and billing change in Wave 2. The
file is the contract a future runtime PR is graded against.

The sub-coach hierarchy is the single feature that makes The Growth
Project usable past 30 clients per head coach. Without it, the gym,
influencer, and info-seller archetypes from
[`positioning-whop-ai-for-coaches.md`](./positioning-whop-ai-for-coaches.md) §2
do not have a credible path on the platform.

---

## 1. The problem this spec solves

Today the platform has exactly one notion of a coaching unit: a
single `User` with `role='coach'` who is bound to a Stripe
subscription via `CoachSubscription` and to a roster of clients via
`User.coach_id`. Everything in the runtime — `SubscriptionGuard`,
`/api/v1/coach/me/*`, the admin Coaches table, federation lookups,
the AI weekly recap — is written against that single-coach
assumption.

A gym with 8 trainers, an influencer with 4 sub-coaches, and an
info-seller with a 3-person team cannot use the platform without
either (a) one Stripe seat per trainer with no organizational
context, or (b) one Stripe seat on the head coach with all clients
assigned to one `coach_id`, hiding which sub-coach actually owns
which client.

This spec replaces the single-coach assumption with a two-level
**organization** model:

- A **`CoachOrganization`** is the head-coach-owned business entity.
  Every coach `User` belongs to exactly one organization. A solo
  trainer's organization is just themselves; a gym's organization is
  the gym + all its trainer sub-coaches.
- A **`CoachMembership`** binds a coach `User` to an organization
  with a role (`OWNER` / `HEAD_COACH` / `SUB_COACH` / `ASSISTANT`)
  and an optional set of overridden entitlements.

The model preserves the existing single-coach runtime as a degenerate
case (an organization of one) and lets every existing coach migrate
in-place without a rewrite — see §12 migration.

---

## 2. Naming and vocabulary

| Term | Definition |
|---|---|
| Organization | The business entity. Has a single billing relationship with the platform. Owns one or more `CoachMembership` rows, exactly one of which has role `OWNER`. |
| Head coach | A coach with `CoachMembership.role = HEAD_COACH` who runs the day-to-day organization. The organization OWNER and the head coach are typically the same `User` for solo / influencer / info-seller archetypes; in the gym archetype the OWNER may be a non-coaching gym owner and the head coach is the most senior trainer. The OWNER and the head coach **may** be different users; the OWNER is always exactly one user. |
| Sub-coach | A coach with `CoachMembership.role = SUB_COACH`. Owns clients but inherits org-level entitlements from the head coach. |
| Assistant | A non-coaching staff member with `CoachMembership.role = ASSISTANT`. Reads-only for client data, can send messages on behalf of the head coach with explicit attribution, cannot author programs or accept AI drafts. |
| Org-OWNER | The organization-level role. Distinct from the platform-level `User.role = 'owner'` (the platform OWNER). When ambiguous, this spec uses `org-OWNER` for the org-level role and `platform-OWNER` for the platform-level role. |
| Sub-coach seat | The platform billing unit a head coach pays for to add a sub-coach. See §8. |
| Internal split | Flow B billing arrangement where the head coach pays the platform a higher fee and the platform forwards a share to each sub-coach via Stripe Connect. See §8.2. |
| Client ownership | The pointer from a client `User` to the `CoachMembership` that owns the relationship. Replaces today's `User.coach_id`. See §4. |

The platform-OWNER role is documented in
[`../audit-and-gdpr.md`](../audit-and-gdpr.md) and
[`../admin/deployment-and-rbac.md`](../admin/deployment-and-rbac.md).
This spec does not change the platform-OWNER role.

---

## 3. Schema additions — Prisma sketch

The blocks below are illustrative. They are written in `prisma`
fences so a future runtime PR can lift them into
`prisma/schema.prisma`. **No migration is implied by this spec PR.**

### 3.1 New models

```prisma
enum CoachArchetype {
  solo
  gym
  influencer
  info_seller
}

enum OrgMemberRole {
  OWNER
  HEAD_COACH
  SUB_COACH
  ASSISTANT
}

enum OrgMemberStatus {
  invited
  active
  suspended
  removed
}

enum OrgBillingFlow {
  separate         // Flow A: each sub-coach billed individually
  internal_split   // Flow B: head coach pays platform, sub-coaches paid via Stripe Connect transfers
}

model CoachOrganization {
  id                          String           @id @default(uuid())
  name                        String
  archetype                   CoachArchetype
  archetype_notes             String?
  owner_user_id               String           @unique
  owner                       User             @relation("OrgOwner", fields: [owner_user_id], references: [id], onDelete: Restrict)

  // Billing posture
  billing_flow                OrgBillingFlow   @default(separate)
  primary_subscription_id     String?          // FK to CoachSubscription (head-coach Stripe subscription)
  stripe_connect_account_id   String?          // for internal_split

  // Defaults applied to every new sub-coach in this org
  default_entitlement_set_id  String?

  created_at                  DateTime         @default(now())
  updated_at                  DateTime         @updatedAt
  archived_at                 DateTime?

  memberships                 CoachMembership[]
  invites                     CoachInvite[]

  @@index([archetype])
  @@index([archived_at])
}

model CoachMembership {
  id                          String           @id @default(uuid())
  org_id                      String
  org                         CoachOrganization @relation(fields: [org_id], references: [id], onDelete: Cascade)
  user_id                     String
  user                        User             @relation(fields: [user_id], references: [id], onDelete: Cascade)

  role                        OrgMemberRole
  status                      OrgMemberStatus  @default(active)

  // Per-membership entitlement overrides on top of org defaults
  entitlement_overrides       Json?            // shape: { fitness?: 'allowed' | 'denied' | null, ... }

  // Per-membership client-roster cap (null = no cap; org-level cap applies)
  client_roster_cap           Int?

  // For internal_split (Flow B) only — the sub-coach's revenue share basis points (0..10000)
  revenue_share_bps           Int?

  invited_by_user_id          String?
  invited_at                  DateTime?
  joined_at                   DateTime?
  removed_at                  DateTime?

  created_at                  DateTime         @default(now())
  updated_at                  DateTime         @updatedAt

  @@unique([org_id, user_id])
  @@index([user_id, status])
  @@index([role])
}

model CoachInvite {
  id                          String           @id @default(uuid())
  org_id                      String
  org                         CoachOrganization @relation(fields: [org_id], references: [id], onDelete: Cascade)

  email                       String
  intended_role               OrgMemberRole
  invite_token                String           @unique
  expires_at                  DateTime
  redeemed_at                 DateTime?
  redeemed_by_user_id         String?

  invited_by_user_id          String
  created_at                  DateTime         @default(now())

  @@index([org_id, redeemed_at])
  @@index([email])
}

model OrgEntitlementSet {
  id                          String           @id @default(uuid())
  org_id                      String           @unique
  org                         CoachOrganization @relation(fields: [org_id], references: [id], onDelete: Cascade)

  // The shape mirrors the existing entitlement read shape in
  // `docs/entitlements.md`, with sub-coach seats and progression
  // unlocks added.
  shape                       Json
  updated_at                  DateTime         @updatedAt
}
```

### 3.2 Modifications to existing models

The runtime PR that lifts this spec adds the following columns. They
are illustrative; the spec does not perform the migration.

```prisma
// User — gain a denormalized current-membership pointer for fast lookup
model User {
  // ... existing columns ...
  current_coach_membership_id String?          // nullable; points to CoachMembership.id when role='coach'
  current_coach_membership    CoachMembership? @relation(fields: [current_coach_membership_id], references: [id], onDelete: SetNull)
  // `coach_id` (the per-client owner pointer) is NOT removed in v1.
  // It becomes a denormalized cache of the membership-owned relation.
  // See §12.
}

// CoachProfile — gain an org pointer, kept for back-compat
model CoachProfile {
  // ... existing columns ...
  org_id                      String?
  org                         CoachOrganization? @relation(fields: [org_id], references: [id], onDelete: SetNull)
}

// CoachSubscription — already a per-User row. Gain an org_id for fast
// org-scoped billing reads. The Stripe customer model does not change.
model CoachSubscription {
  // ... existing columns ...
  org_id                      String?
  org                         CoachOrganization? @relation(fields: [org_id], references: [id], onDelete: SetNull)
}
```

### 3.3 Indexes the runtime author must add

- `CoachOrganization (archetype)` — admin Coaches table archetype filter.
- `CoachOrganization (archived_at)` — admin filter "exclude archived orgs".
- `CoachMembership (org_id, role)` — sub-coach roster reads.
- `CoachMembership (user_id, status)` — "what org am I in?" reads.
- `CoachInvite (org_id, redeemed_at)` — open-invite list per org.
- `User (current_coach_membership_id)` — already covered by membership unique key, but a separate index avoids a join on org-roster reads.

### 3.4 Cardinality invariants

- Exactly one `CoachMembership` per org has `role = OWNER` and
  `status != removed`. Enforced by a partial unique index in the
  runtime PR (`@@unique([org_id]) WHERE role = 'OWNER' AND status != 'removed'` —
  Postgres partial unique).
- A `User` with `role = 'coach'` has at most one
  `CoachMembership.status = 'active'` row at a time. (A coach
  *leaving* one org and *joining* another is a transition: the prior
  membership flips to `status = 'removed'` first.)
- A `User` with `role = 'student'` has zero `CoachMembership` rows.
- A `CoachOrganization` with `billing_flow = 'internal_split'` MUST
  have a non-null `stripe_connect_account_id` and every active
  membership of role `SUB_COACH` MUST have a non-null
  `revenue_share_bps`. Validated on transition (§8.2).

---

## 4. Client ownership — replacing `User.coach_id`

Today, `User.coach_id` (with `User.role = 'student'`) is the
authoritative pointer from a client to their coach. Wave 2 keeps the
column as a **denormalized cache** and adds membership-scoped
ownership as the source of truth.

### 4.1 The new ownership pointer

A client `User` is owned by a single `CoachMembership` at any time.
The runtime PR adds:

```prisma
model User {
  // ... existing columns ...
  owning_membership_id        String?
  owning_membership           CoachMembership? @relation("ClientOwner", fields: [owning_membership_id], references: [id], onDelete: SetNull)
  // `coach_id` remains; it is updated by a database trigger or a
  // service-layer hook to mirror `owning_membership.user_id` whenever
  // ownership changes. See §12.
}
```

### 4.2 Reassignment

Reassigning a client from one sub-coach to another within the same
organization is the common case (a sub-coach goes on leave, a head
coach rebalances load). The reassignment endpoint is in §7.4.

Cross-organization reassignment is **out of scope for v1**. A client
is admitted to one org via invite redemption and stays there. Moving
a client between orgs requires manual platform-OWNER intervention.

### 4.3 RBAC invariants on client reads

- A `SUB_COACH` reads only clients whose `owning_membership_id`
  points at their own membership.
- A `HEAD_COACH` reads all clients in their org.
- An `ASSISTANT` reads all clients in their org but every read is
  audited (`assistant.client.read` audit action — §13).
- An org-`OWNER` who is not also a head coach reads org-level
  metrics and roster but **not** per-client data — that distinction
  is what makes the gym archetype safe to ship to a non-coaching gym
  owner.

The platform-OWNER bypasses all of the above per
[`../admin/deployment-and-rbac.md`](../admin/deployment-and-rbac.md).

---

## 5. Role matrix

The matrix below is the canonical contract. It is enforced
server-side by class-level guards on the new `/api/v1/org/*`
controllers and by row-scoping in the existing `/api/v1/coach/me/*`
reads.

| Capability | OWNER | HEAD_COACH | SUB_COACH | ASSISTANT | platform-OWNER |
|---|---|---|---|---|---|
| Read org settings | yes | yes | yes (read-only) | yes (read-only) | yes |
| Edit org settings (name, archetype not editable post-create) | yes | yes | no | no | yes |
| View org billing | yes | yes | no | no | yes |
| Change billing flow (Flow A ↔ Flow B) | yes | no | no | no | yes |
| Invite a sub-coach | yes | yes | no | no | yes |
| Invite an assistant | yes | yes | no | no | yes |
| Invite a head coach | yes | no | no | no | yes |
| Remove a sub-coach | yes | yes | no | no | yes |
| Remove a head coach | yes | no | no | no | yes |
| Edit per-membership entitlement overrides | yes | yes | no | no | yes |
| Set per-membership client-roster cap | yes | yes | no | no | yes |
| Set per-membership `revenue_share_bps` (Flow B) | yes | no | no | no | yes |
| Read sub-coach roster | yes | yes | no (own only) | yes | yes |
| Read all clients in org | yes (no PII) | yes | own only | yes (audited) | yes |
| Reassign a client between memberships in same org | yes | yes | no | no | yes |
| Read AI weekly recap (org rollup) | yes | yes | no | no | yes |
| Read AI at-risk flags (per scope) | yes | yes (org) | own clients | yes (audited) | yes |
| Send a message as the head coach (attributed to assistant) | no | yes | own clients | yes | yes |
| Author or save an AI program draft | no | yes | own clients | no | yes |

The "no PII" cell on the OWNER row reflects the gym archetype: a
gym OWNER who is not a coach reads aggregate org metrics, billing,
and roster counts, but not per-client food logs, weight logs, or
chat transcripts. The PII restriction is enforced by an
`org_owner_pii_blocked` middleware on the relevant routes.

---

## 6. Entitlement inheritance

The existing entitlement read shape in
[`../entitlements.md`](../entitlements.md) is the substrate. Wave 2
extends it without breaking the existing fields.

### 6.1 Extended read shape

Every record-level admin endpoint that already attaches the
`entitlements` block (per [`../entitlements.md`](../entitlements.md))
gains an `org` and `progression_unlocks` block:

```ts
{
  active_products: ['fitness' | 'finance'],
  bundle: 'none' | 'fitness_only' | 'finance_only' | 'performance_os',
  overall: 'active' | 'past_due' | 'canceled' | 'suspended' | 'inactive' | 'unknown',
  products: { fitness: {...}, finance: {...} },
  account_suspended: boolean,

  // NEW in Wave 2
  org: {
    org_id: string,
    org_name: string,
    archetype: 'solo' | 'gym' | 'influencer' | 'info_seller',
    role_in_org: 'OWNER' | 'HEAD_COACH' | 'SUB_COACH' | 'ASSISTANT' | null,
    billing_flow: 'separate' | 'internal_split',
    inherits_from_org: boolean,             // true = reading org default; false = local override
    sub_coach_seats_used: number,
    sub_coach_seats_cap: number | null,     // null = no cap on this tier
    client_roster_used: number,
    client_roster_cap: number | null
  } | null,
  progression_unlocks: {
    level_id: string,
    unlocked_features: string[]             // see retention-progression-system.md §6
  } | null
}
```

### 6.2 Inheritance rules

- A sub-coach's `entitlements.products.fitness.status` is the
  **min** of (org default, per-membership override). A head coach
  cannot grant a sub-coach an entitlement the org itself does not
  have.
- A head coach **can** restrict a sub-coach below the org default
  by setting `entitlement_overrides.fitness = 'denied'` on the
  membership (e.g. a probationary sub-coach who is not yet allowed
  to use AI program builder).
- The inheritance evaluator is a pure function of (org default,
  membership overrides, billing status, suspension flag). It never
  hits Stripe; it uses the existing `CoachSubscription` mirror.
- The `unknown` semantics from
  [`../entitlements.md`](../entitlements.md) carry over: a finance
  call timing out renders `unknown`, never `inactive`.

### 6.3 Per-archetype defaults (illustrative)

| Archetype | Sub-coach seats cap on L1 | on L2 | on L3 |
|---|---|---|---|
| solo | 0 | 0 | 0 |
| gym | 0 | 5 | 25 |
| influencer | 0 | 3 | 15 |
| info_seller | 0 | 3 | 15 |

These caps are illustrative. The OWNER sets the actual numbers in
the entitlement-set table at runtime; the spec does not invent
prices or seat counts.

---

## 7. API surface

All new routes follow [`../api-conventions.md`](../api-conventions.md):
`/api/v1/*` for coach-side (Supabase JWT, class-gated by
`SubscriptionGuard` where applicable), `/api/admin/*` for
platform-OWNER (class-gated by `@Roles('owner')`). Errors use the
existing envelope shape; idempotency keys on POST endpoints follow
the existing pattern; pagination is cursor-based per
`api-conventions.md` §3.

### 7.1 `/api/v1/org/*` — coach-facing

```
GET    /api/v1/org/me
       -> { org, my_membership, entitlements }
       The single discovery endpoint a coach mobile / coach console
       hits on app boot.

PATCH  /api/v1/org/me
       Body: { name?: string }
       OWNER-or-HEAD_COACH only. Edits org-level mutable fields.
       Archetype is NOT editable here — it is platform-OWNER-only
       to prevent self-reclassification. See §11.

GET    /api/v1/org/me/members
       Query: { role?, status?, limit?, cursor? }
       Lists memberships in the org. SUB_COACH gets self-only.

POST   /api/v1/org/me/members/invite
       Body: { email, intended_role: 'SUB_COACH' | 'ASSISTANT' | 'HEAD_COACH', revenue_share_bps?: number }
       OWNER-or-HEAD_COACH only. Sends an invite email (existing
       `src/email/` module) with a one-time `invite_token`.
       Idempotency-Key required.

POST   /api/v1/org/me/members/:membership_id/remove
       Body: { reason: string }
       OWNER-or-HEAD_COACH only. Sets membership.status='removed'.
       Cascades client-ownership reassignment per §7.4.

PATCH  /api/v1/org/me/members/:membership_id
       Body: { entitlement_overrides?, client_roster_cap?, revenue_share_bps? }
       OWNER-or-HEAD_COACH only. revenue_share_bps editable only by
       OWNER and only when billing_flow='internal_split'.

POST   /api/v1/org/me/clients/:client_id/reassign
       Body: { to_membership_id: string, reason?: string }
       OWNER-or-HEAD_COACH only. Updates client.owning_membership_id
       and the denormalized client.coach_id pointer. Audited.

POST   /api/v1/org/invites/redeem
       Body: { invite_token: string }
       AUTHENTICATED (the redeeming coach must be signed in). The
       redeeming user must have role='coach'; otherwise the platform
       returns 409 with a hint to upgrade. (No silent role flip.)
```

### 7.2 `/api/admin/orgs/*` — platform-OWNER

```
GET    /api/admin/orgs?archetype=&query=&limit=&cursor=
       Lists organizations.

GET    /api/admin/orgs/:id
       Full org detail with memberships, billing, entitlements.

PATCH  /api/admin/orgs/:id
       Body: { name?, archetype?, archetype_notes? }
       The only path that can change archetype.

POST   /api/admin/orgs/:id/billing/flow
       Body: { flow: 'separate' | 'internal_split', stripe_connect_account_id?: string }
       Transitions billing flow per §8.4.

POST   /api/admin/orgs/:id/archive
       Body: { reason: string }
       Sets archived_at. Cascades to memberships; clients are NOT
       cascaded — they are flipped to a "no active coach" state and
       surface in the admin dashboard's "orphaned clients" report.
```

### 7.3 Webhook integration

Stripe webhook handlers in `src/billing/webhook/` already process
`invoice.paid`, `customer.subscription.updated`, and friends, idempotent
on `StripeProcessedEvent`. Wave 2 adds:

- `account.updated` — for Flow B Connect accounts. The handler updates
  `CoachOrganization.stripe_connect_account_id` capability state.
- `transfer.created` / `transfer.failed` — for Flow B internal-split
  transfers. The handler upserts a `CoachOrgTransfer` row (added in §8).

### 7.4 Reassignment cascade

When a sub-coach is removed (`POST /members/:id/remove`), every
client whose `owning_membership_id` points at the removed membership
is reassigned. The cascade order:

1. The remove call requires a `reassignment_strategy` body field:
   `{strategy: 'to_specific', to_membership_id}` or
   `{strategy: 'to_head_coach'}` or
   `{strategy: 'to_orphan'}` (latter only allowed when org has
   `archived_at`).
2. The cascade runs in the same transaction as the membership flip.
3. Each per-client reassignment lands a separate `AuditLog` row
   (`client.reassigned_due_to_member_removal`).
4. Each reassigned client receives a system message in their existing
   coach-thread (per `src/messaging/`) explaining the change. The
   system message is a real `CoachMessage` row with
   `actor_role='system'`.

Failure modes:
- A client whose subscription is `past_due` is still reassigned. The
  past-due grace period in [`../entitlements.md`](../entitlements.md)
  is independent of ownership.
- A client whose subscription is `canceled` is reassigned but their
  data access is unchanged (canceled clients keep their archive per
  the existing GDPR lifecycle).

---

## 8. Billing flows

The two flows are the heart of this spec. Both are commercially
viable; defaults differ by archetype per
[`positioning-whop-ai-for-coaches.md`](./positioning-whop-ai-for-coaches.md) §2.
A new org starts on Flow A. Switching is one direction at a time and
requires a Stripe Connect account.

### 8.1 Flow A — separate billing

Each coach in the org pays the platform individually via the
existing `CoachSubscription` mirror.

**Properties:**
- Each `CoachMembership.user_id` has a `CoachSubscription` row.
- The org has a `primary_subscription_id` pointing at the OWNER's
  subscription, used for org-level seat counting and tier resolution.
- Sub-coach seat caps are still enforced at the org level: adding a
  sub-coach beyond the cap is rejected with HTTP 422 even if the
  sub-coach has a personal Stripe subscription, because the platform
  considers the cap an org-tier guarantee.
- No Stripe Connect account is required.

**Invoice contract:**
- The head coach receives a normal Stripe invoice on the head-coach
  subscription.
- Each sub-coach receives a normal Stripe invoice on the sub-coach
  subscription.
- The platform does not move money between coaches. Internal
  arrangements (the head coach reimbursing sub-coaches, or vice
  versa) are out of platform scope.

**Reconciliation:**
- The existing `Invoice` mirror is per-User. No org-rollup is added
  to the schema in v1; the admin console (`docs/admin/control-room-spec.md` §8)
  computes org-level invoice rollups by joining
  `CoachSubscription.org_id`.

### 8.2 Flow B — internal split via Stripe Connect

The head coach (or org-OWNER) holds the customer relationship; the
platform retains its platform fee and forwards the remainder to each
sub-coach via Stripe Connect transfers.

**Properties:**
- The `CoachOrganization` has a non-null
  `stripe_connect_account_id`. Onboarding to that account is owned
  by the commerce wave (PR #125) — Wave 2 consumes the contract,
  does not respec it.
- Each active `CoachMembership` of role `SUB_COACH` has a non-null
  `revenue_share_bps` (basis points; 0..10000; sum across active
  sub-coaches MUST be ≤ 10000). The remainder is the platform fee
  plus the head-coach's residual.
- A new `CoachOrgTransfer` table records each Stripe Connect transfer
  the platform has scheduled / executed / failed.

```prisma
enum OrgTransferStatus {
  pending
  in_transit
  paid
  failed
  reversed
}

model CoachOrgTransfer {
  id                          String           @id @default(uuid())
  org_id                      String
  org                         CoachOrganization @relation(fields: [org_id], references: [id], onDelete: Cascade)
  destination_membership_id   String
  destination_user_id         String           // denormalized
  source_invoice_id           String           // FK to existing Invoice mirror
  amount_cents                Int
  currency                    String
  stripe_transfer_id          String?          @unique
  status                      OrgTransferStatus
  failure_reason              String?
  scheduled_at                DateTime         @default(now())
  posted_at                   DateTime?
  reversed_at                 DateTime?

  @@index([org_id, status])
  @@index([destination_membership_id])
}
```

**Invoice contract:**
- The head coach (or OWNER) receives a single Stripe invoice from the
  platform, sized to the gym/influencer/info-seller tier.
- The platform schedules a Connect transfer per active sub-coach
  according to `revenue_share_bps`, debited from the platform's
  Connect-account balance.
- Sub-coaches do **not** see a Stripe invoice; they see a
  per-membership earnings statement on their coach mobile / coach
  console, sourced from `CoachOrgTransfer`.

**Reconciliation:**
- Idempotency. The transfer creation is idempotent on
  `(invoice_id, destination_membership_id)`.
- Failure handling. A `failed` transfer raises an admin-console alert
  per `docs/admin/control-room-spec.md` §8 (Finance health). The
  failed transfer is retried on a cron worker with exponential
  backoff for up to 7 days, after which it is marked permanently
  failed and a platform-OWNER intervention is required.
- Reversal handling. A reversed transfer (Stripe `transfer.reversed`)
  flips the row to `reversed` and lands an `AuditLog` row.

### 8.3 Sub-coach seat product

For both flows, "adding a sub-coach" requires a seat. The seat is a
Stripe product whose price ID is held in the entitlement set.

- **Flow A:** the platform requires the sub-coach to have a personal
  `CoachSubscription` row with `status` ∈ `{trialing, active}`. The
  org tier defines a soft seat cap; passing the cap requires the
  head-coach subscription to be on a tier with a higher cap.
- **Flow B:** the platform charges the org-OWNER's subscription a
  per-seat add-on for each active sub-coach. The add-on is a
  `quantity` increment on the existing `CoachSubscription` Stripe
  subscription.

The Stripe product / price IDs live in environment configuration per
[`../stripe-setup.md`](../stripe-setup.md). Wave 2 does not invent
prices; it specifies the seat-counting and quantity-update
mechanics.

### 8.4 Transition between flows

Flow A → Flow B:
1. The org must have an onboarded Stripe Connect account
   (`stripe_connect_account_id` non-null with `charges_enabled =
   true` from the most recent `account.updated` webhook).
2. Each active `SUB_COACH` membership must have a non-null
   `revenue_share_bps` set BEFORE the transition POST.
3. The transition cancels every sub-coach's personal
   `CoachSubscription` at period end (Stripe `cancel_at_period_end =
   true`) and increments the OWNER's subscription quantity by the
   sub-coach count, effective at the next invoice cycle.
4. The transition is a single atomic admin endpoint
   (`POST /api/admin/orgs/:id/billing/flow`) that runs in a
   transaction; partial failures roll back.

Flow B → Flow A:
1. Each active `SUB_COACH` membership is presented an "establish your
   own subscription" task in the coach mobile inbox. Until the
   sub-coach completes the task, their membership status remains
   `active` but their entitlement evaluator returns `past_due` for
   the personal billing slice.
2. The OWNER's subscription quantity decrements at the next invoice
   cycle.
3. Pending `CoachOrgTransfer` rows (status `pending` or
   `in_transit`) are left to settle; new ones are not created post-
   transition.

Both transitions land an `org.billing_flow_changed` audit row with
`metadata = { from, to, reason, actor_id }` and a PostHog event per
[`data-tracking-contract.md`](./data-tracking-contract.md).

### 8.5 Refunds and cancellations

- A sub-coach refund (Flow A) is processed against the sub-coach's
  Stripe subscription. The org sees no impact.
- A head-coach refund (Flow B) triggers a *transfer reversal* on
  every Connect transfer associated with the refunded invoice.
  Reversals are pro-rata by `revenue_share_bps`. The reversal logic
  reuses Stripe's `transfer.reversal` API. The detailed refund-
  cascade rules (including head-coach refund → sub-coach pro-rata)
  are owned by the finance app — see
  [`tgp-finance-app/docs/billing/sub-coach-billing-split-spec.md`](https://github.com/BradleyGleavePortfolio/tgp-finance-app)
  (Wave 5). Wave 2 surfaces the contract; Wave 5 is the canonical
  source for refund rules.

---

## 9. Admin console surfaces

The Wave 2 sub-coach hierarchy must surface in the admin console
(`docs/admin/control-room-spec.md`). This section enumerates the
surface changes; the runtime PR for each is owned by the next admin-
spec PR (cross-ref §15 below for the new gap letters).

### 9.1 Coaches table — new columns

Per `docs/admin/control-room-spec.md` §4, the Coaches table gains:

- **Organization** — chip showing org name + archetype. Click → org
  profile (new screen, §9.3).
- **Role in org** — `OWNER` / `HEAD_COACH` / `SUB_COACH` / `ASSISTANT`.
- **Billing flow** — `separate` / `internal_split` chip.
- **Sub-coach seats** — `used / cap` for OWNER and HEAD_COACH rows;
  blank for SUB_COACH and ASSISTANT.

### 9.2 Person profile — Organization tree panel

Per `docs/admin/control-room-spec.md` §7, the person profile gains
an Organization tree panel that renders:

- The org's OWNER and HEAD_COACH at the top.
- Sub-coaches grouped by status.
- Assistants grouped at the bottom.
- For each row: client count, last-active timestamp, AI weekly recap
  adoption flag, at-risk client count.

The panel is a single endpoint (`GET /api/admin/orgs/:id/tree`)
returning a denormalized JSON tree to avoid N+1 fetches. Pagination
is irrelevant at expected sizes (a 30-sub-coach org renders in one
response).

### 9.3 New screen — Organization profile

A new screen at `Admin → Organizations → :id` that mirrors the
existing Coach profile shape but org-scoped:

- KPI cards: total clients, total sub-coaches, MRR (org-rolled-up),
  AI recap adoption rate, at-risk client share.
- Memberships table.
- Billing tab: subscription mirror, recent invoices, recent transfers
  (Flow B), transfer-failure list.
- Audit tab: org-scoped audit log (filter chip
  `tenant_org_id = :id`).

The screen is gated by the `view:overview` capability per
[`../admin/deployment-and-rbac.md`](../admin/deployment-and-rbac.md) §3.
Mutations on the screen (archive, change billing flow) are gated by
new capabilities listed in §9.5 below.

### 9.4 Organization-aware metrics

The existing `/api/admin/metrics` gains an `?org_id=...` filter. Every
KPI on `docs/admin/control-room-spec.md` §3 is renderable scoped to
a single org. The cross-org rollup (default) is unchanged.

### 9.5 New advisory capability matrix entries

The `docs/admin/deployment-and-rbac.md` §3 capability matrix gains:

| Capability | Endpoints it implies | UI affordance gated |
|---|---|---|
| `view:org_admin` | `/api/admin/orgs`, `/api/admin/orgs/:id`, `/api/admin/orgs/:id/tree` | Renders Organizations |
| `act:org_archive` | `/api/admin/orgs/:id/archive` | Archive button on org profile |
| `act:org_billing_flow_change` | `/api/admin/orgs/:id/billing/flow` | Change-flow button on org profile |
| `view:org_transfers` | `/api/admin/orgs/:id/transfers` (Flow B) | Renders Transfers tab |
| `act:org_transfer_retry` | future `/api/admin/orgs/:id/transfers/:tx/retry` | Retry button on failed transfer |

These additions are merged into the canonical capability matrix in
the next admin-spec PR; this spec reserves the names.

---

## 10. RBAC enforcement — server-side

The role matrix in §5 is enforced by:

- **Class-level guards.** Every `/api/v1/org/*` controller class is
  decorated with the existing `JwtAuthGuard` + `RolesGuard` chain. A
  new `OrgRoleGuard` looks up `req.user.id`'s active membership and
  attaches `req.membership` to the request.
- **Per-route role decorators.** A new `@OrgRoles('OWNER',
  'HEAD_COACH')` decorator gates routes that mutate org state.
- **Row-scoping middleware.** Reads of clients, programs, messages,
  and check-ins go through the existing services; those services
  receive a `scope` parameter derived from `req.membership.role` and
  filter the query.
- **Assistant audit middleware.** When `req.membership.role =
  ASSISTANT`, every read of a client surface lands an
  `assistant.client.read` audit row with the read target. This is
  the integrity check that lets the gym OWNER trust the assistant
  with org-wide reads.
- **OWNER PII block.** When `req.membership.role = OWNER` and the
  route returns client PII, the response body is filtered through a
  PII-stripper that nulls out food logs, weight logs, message bodies,
  and check-in transcripts. Aggregate counts pass through.

The existing platform-OWNER bypass (per
[`../admin/deployment-and-rbac.md`](../admin/deployment-and-rbac.md))
is preserved.

---

## 11. Validation rules

The runtime PR enforces:

1. `CoachOrganization.archetype` is set at creation and only mutable
   by the platform-OWNER admin endpoint. Self-edit attempts return
   422 with code `org_archetype_immutable_to_self`.
2. Inviting a `HEAD_COACH` when an active `HEAD_COACH` already exists
   returns 409 `org_head_coach_already_present`. To rotate, the
   incumbent must be removed first.
3. Inviting a sub-coach beyond the org's seat cap returns 422
   `org_sub_coach_seats_exhausted` with a payload including the cap
   and the current count.
4. Transitioning to `internal_split` when any active `SUB_COACH`
   has null `revenue_share_bps` returns 422
   `org_revenue_share_unset` listing the offending memberships.
5. Sum of active `SUB_COACH.revenue_share_bps` exceeding 10000
   returns 422 `org_revenue_share_overflow`.
6. Reassigning a client across orgs returns 403
   `cross_org_reassignment_forbidden`.
7. A coach `User` redeeming a `CoachInvite` whose
   `intended_role = HEAD_COACH` when the user already has an active
   membership in another org returns 409
   `coach_active_membership_present` with a hint to leave the prior
   org first.
8. A coach `User` accepting an invite when they have an unpaid
   invoice on a personal subscription is allowed under Flow A (their
   subscription is independent) and rejected under Flow B with 422
   `personal_subscription_must_resolve_first`.

---

## 12. Migration strategy from the single-coach world

The runtime migration is the most operationally sensitive piece of
this spec. It runs in three steps; each is reversible up to the
point of cutover.

### 12.1 Step 1 — backfill (read-only, behind a flag)

A one-shot script under `scripts/backfill-org-from-coach.ts`:

- For every `User` with `role = 'coach'`, create a
  `CoachOrganization` with `name = CoachProfile.business_name ?? User.email`,
  `archetype = 'solo'` (default; platform-OWNER reclassifies after),
  `owner_user_id = User.id`, `billing_flow = 'separate'`.
- Create a `CoachMembership` with `org_id = org.id`,
  `user_id = User.id`, `role = OWNER`, `status = 'active'`.
- Set `User.current_coach_membership_id = membership.id`.
- For every client `User` with `coach_id = coach.id`, set
  `client.owning_membership_id = membership.id`.
- Set `CoachProfile.org_id` and `CoachSubscription.org_id`.

The script is idempotent: re-running on top of an already-migrated
row is a no-op. The script writes to a `BackfillRun` table with
counters for verification.

A feature flag `ORG_HIERARCHY_ENABLED` gates the new
`/api/v1/org/*` and `/api/admin/orgs/*` routes. Until the flag is
enabled, the routes 404 and the existing `/api/v1/coach/me/*`
surface is unchanged.

### 12.2 Step 2 — dual-write (under flag)

The `User.coach_id` column remains. A service-layer hook in the
client-ownership reassignment path keeps `coach_id` in sync with
`owning_membership_id` whenever ownership changes.

This step lets the existing runtime continue reading `coach_id`
unchanged while the new endpoints read `owning_membership_id`.

The dual-write window is the period where the runtime PR is
behind the flag and partial migrations are still possible.

### 12.3 Step 3 — flag flip

The OWNER flips `ORG_HIERARCHY_ENABLED = true` per environment.
The new endpoints become reachable. The mobile app's
`/api/v1/org/me` discovery endpoint starts returning a real
response. Existing single-coach users see a one-org view of
themselves with no behavior change.

### 12.4 What is NOT removed in v1

`User.coach_id` stays. Removing it is a separate, gated migration in
a later phase (call it Phase-2 cleanup) once every read path has
been audited to confirm no remaining caller uses it. The runtime PR
that lifts this spec leaves the column alone.

### 12.5 Relationship to PR #118 Team Mode ADR

PR #118 (Team Mode foundation: ADR + permission scaffolding) is the
**runtime substrate** for this spec. Its scaffolding is the place the
`OrgRoleGuard`, the `@OrgRoles()` decorator, and the membership
discovery hooks live. This Wave 2 spec is the **product layer** on
top of #118. The two PRs do not collide:

- #118 ships a permission-system shape with no semantic meaning yet
  (its `do_not_merge` marker reflects that).
- This spec gives #118's shape semantic meaning by defining roles,
  capabilities, and entitlement inheritance.

When a future runtime PR lifts both, #118's scaffolding is the
foundation and this spec is the building.

---

## 13. Audit logging

Every state-changing call lands an `AuditLog` row through the
existing `AuditService.write` (per [`../audit-and-gdpr.md`](../audit-and-gdpr.md)).
New `AuditAction` constants the runtime PR adds:

- `org.created`
- `org.archetype_changed` (platform-OWNER only)
- `org.archived`
- `org.billing_flow_changed`
- `org.member.invited`
- `org.member.invite_redeemed`
- `org.member.role_changed`
- `org.member.removed`
- `org.member.entitlement_overridden`
- `org.member.client_roster_cap_changed`
- `org.member.revenue_share_changed`
- `org.client.reassigned`
- `org.client.reassigned_due_to_member_removal`
- `org.transfer.scheduled`
- `org.transfer.failed`
- `org.transfer.reversed`
- `assistant.client.read`

Every row carries `tenant_coach_id` (set to the affected sub-coach's
user id when applicable) and a new `tenant_org_id` metadata field
on the JSON `metadata` blob (so the existing append-only `AuditLog`
schema does not change). The admin Audit screen
(`docs/admin/screens-addendum.md` §1) gains a `tenant_org_id`
filter chip.

---

## 14. Telemetry

Every event in §13 has a corresponding PostHog event per
[`data-tracking-contract.md`](./data-tracking-contract.md). The
event vocabulary additions:

- `org_created`
- `org_archetype_changed`
- `org_billing_flow_changed`
- `org_member_invited`
- `org_member_redeemed_invite`
- `org_member_removed`
- `org_client_reassigned`
- `org_transfer_scheduled`
- `org_transfer_failed`
- `org_transfer_reversed`

The PII deny-list and `distinctId = internal user id` invariants
from [`../metrics.md`](../metrics.md) are preserved. Org IDs are
non-PII and are sent in event properties.

The admin metrics endpoint gains aggregate counters in
`/api/admin/metrics?since_days=30`:

```ts
{
  org: {
    total: number,
    by_archetype: { solo: number, gym: number, influencer: number, info_seller: number },
    by_billing_flow: { separate: number, internal_split: number },
    new_in_window: number,
    archived_in_window: number,
    transfer_failures_in_window: number,                   // Flow B only
    transfer_amount_cents_in_window: number                // Flow B only
  }
}
```

---

## 15. Admin-spec gap letters reserved (next admin PR)

The next admin-spec PR adds the following gap letters to
`docs/admin/control-room-spec.md` §11. Wave 2 reserves the names so
the runtime author and the admin UI author share a contract.

- **§11.P** — Organizations table + organization profile endpoint
  family (`GET /api/admin/orgs`, `GET /api/admin/orgs/:id`,
  `GET /api/admin/orgs/:id/tree`).
- **§11.Q** — Organization metrics rollup (`?org_id=...` on every
  existing admin metrics endpoint).
- **§11.R** — Organization audit-scope filter (audit log
  `tenant_org_id` filter chip).
- **§11.S** — Connect-transfer admin (`GET /api/admin/orgs/:id/transfers`,
  retry endpoint).
- **§11.T** — Org-aware GDPR export and scrub previews.

These letters are added to `docs/admin/control-room-spec.md` in the
next admin-spec PR; this spec reserves the names only.

---

## 16. Open questions

These are the deferred decisions a platform-OWNER must close before
the runtime PR opens. None of them block writing the spec; all of
them block writing the migration script.

1. **Default seat caps per archetype per tier.** §6.3 lists
   illustrative numbers. The OWNER must set the actual numbers in
   the Stripe price metadata + the entitlement-set table before the
   gym/influencer archetype goes live.
2. **Cross-org reassignment.** §4.2 declares it out of scope. If a
   future product brief needs it (e.g. a sub-coach leaving one gym
   and joining another with the client following), the spec gains a
   §4.4 with a manual platform-OWNER endpoint and a stricter audit
   trail.
3. **Org-OWNER non-coaching account.** §2 and §10 imply a non-
   coaching gym OWNER. The OWNER may not have any AI surfaces, may
   not author programs, etc. The runtime author confirms the
   `User.role` enum stays unchanged (the OWNER is `role='coach'` at
   the platform level even if `OrgMemberRole='OWNER'`) — the spec's
   recommendation is *yes*, keep `role='coach'` so the existing
   `/api/v1/coach/me/*` plumbing works, and use the org role as the
   gating axis instead.
4. **Sub-coach Stripe Connect onboarding (Flow B).** Whether each
   sub-coach has their own connected account or whether the head
   coach's account is the single Connect account that holds all
   transfers. The spec's recommendation: **head coach is the single
   Connect account**, sub-coach earnings are tracked in
   `CoachOrgTransfer` and paid out through the head coach's payroll-
   adjacent process. The alternative (each sub-coach with their own
   Connect account) is more correct but adds onboarding friction.
   The decision is the OWNER's; the schema does not preclude either.
5. **Per-archetype default invite-link copy.** Listed in
   [`positioning-whop-ai-for-coaches.md`](./positioning-whop-ai-for-coaches.md) §2.
   The actual strings live in the email-template module (see
   [`../emails/`](../emails/)) and are owned by support copywriting,
   not by this spec.

These five questions are tracked in the root
[`PERP_HANDOFF.md`](../../PERP_HANDOFF.md) Wave 2 entry as open
decisions for the platform-OWNER.

---

## 17. Out of scope

- **Stripe Connect onboarding flow.** Owned by PR #125.
- **Marketplace / storefront / offer builder.** Owned by PR #125.
- **Community spaces / events.** Owned by PR #126.
- **AI Program Builder.** Owned by PR #117.
- **Team Mode permission scaffolding ADR.** Owned by PR #118 — see
  §12.5.
- **Removing `User.coach_id`.** Phase-2 cleanup, not v1.
- **Per-tenant scoping of platform-OWNER.** No new auth layer; the
  platform-OWNER is platform-wide.
- **Mobile coach onboarding for sub-coaches.** The mobile flow
  changes are owned by Wave 4 (the mobile-mirror spec). This spec
  defines the API contract the mobile flow consumes.
- **Finance app sub-coach billing-split detail rules.** Owned by
  Wave 5 in the finance app repo.
