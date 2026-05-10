# ADR 0001: Team Mode foundation — multi-staff coaching businesses

- **Status:** Draft (proposed; not yet accepted)
- **Date:** 2026-04-30
- **Supersedes:** —
- **Superseded by:** —

## Summary

Today, a coach in The Growth Project is a single `User` row with
`role=coach` and a 1:1 `CoachProfile`. Their clients are `User` rows
with `role=student` and a `coach_id` self-reference back to the coach.
This is sufficient for a solo operator but does not model the next
business shape we want to support: a coaching business where one
human owns the book of clients but employs other humans — junior
coaches, setters, ops/admin staff — who interact with the same clients
under explicit permissions.

This ADR proposes the data model, permission model, and rollout plan
for "Team Mode": the foundation for a coach to grow their business
without a separate accounts-and-rebilling story per employee. It is
deliberately a *foundation* document. Concrete migrations, controllers
and console UI land in follow-up PRs that reference this ADR.

The associated PR (titled "[DRAFT] feat(team-mode): foundation —
ADR + permission scaffolding") is **not for merge** until the open
questions in §10 are resolved by Bradley. It contains:

1. This ADR.
2. Pure-TypeScript permission scaffolding under
   `src/common/team-mode/` (types, constants, a permission matrix,
   and a deterministic `can(...)` resolver). All scaffolding is
   tree-shake-clean: no module imports it, no controller wires it,
   no migration changes runtime.
3. Tests covering the permission matrix.

The scaffolding is a contract, not a feature. Removing it must be
trivial — it is one directory and one test file.

## 1. Goals

1. **Top priority — coaches having their own coaches.** A coach must
   be able to operate as a small business: hire one or more junior
   coaches and assign clients to them, without giving up ownership of
   the book of clients or their billing relationship with the
   platform.
2. **Single billing relationship per business.** Owners of a team
   continue to pay their per-seat SaaS fee to The Growth Project.
   Their employees do not have their own subscriptions; they are
   actors *under* the owner's subscription.
3. **Granular roles with deterministic permissions.** "Setter",
   "junior coach", and "ops/admin" are not the same thing. Each role
   has a documented permission set; the permission matrix is the
   single source of truth.
4. **Mini admin metrics later.** The owner can see how their team is
   performing — assigned-client counts, recent activity, response
   times — without exposing one employee's metrics to another
   employee unless they are above them in the hierarchy.
5. **Backwards compatible.** Every existing coach keeps working
   unchanged. They are an "owner of a team of one" by default. We
   never force a migration on a solo coach who does not opt in.
6. **Enterprise grade and reversible.** Each step ships behind a flag,
   under audit, with a clearly documented rollback. We optimize for
   confidence over speed.

## 2. Non-goals

1. **Not a multi-tenant rebrand.** Each team uses the standard mobile
   app and coach console. We are not building white-label
   subdomains, custom auth, or per-team theming beyond what
   `CoachProfile.branding_*` already supports.
2. **Not a marketplace.** A team belongs to one owner. We are not
   modeling cross-team coach hiring, contractor pools, or
   client-portable assignment.
3. **Not a chat-platform pivot.** Existing messaging stays
   coach<->client. Team-internal chat is out of scope; we use
   audit + activity events for coordination, plus the existing
   coach-console UI.
4. **Not a finance/payroll system.** How an owner pays their employees
   is the owner's problem. We do not handle 1099s, splits, or
   commissions.
5. **Not a Healthie-style "group" practice with shared clients across
   organizations.** A client belongs to exactly one team at a time.

## 3. Current state (as of 2026-04-30)

The relevant pieces of today's data model:

- `User` — every authenticated person. Holds `role` (`owner`, `coach`,
  `student`), and for clients, a self-relation `coach_id` →
  `User.id`. See `prisma/schema.prisma` lines 108–180.
- `CoachProfile` — 1:1 with a coach `User`. Holds business name,
  branding, default invite code, Stripe customer/subscription,
  subscription status, AI spend cap, plan tier, and the OWNER who
  created the coach. See `prisma/schema.prisma` lines 194–219.
- `CoachSubscription` — 1:1 with a coach `User`. Stripe-mirror
  subscription state used by the v1 coach-console BFF.
- `InviteCode` — many per coach. The shareable per-coach code.
- `ActivityEvent`, `AuditLog` — generic event/audit streams keyed on
  `coach_id` + `client_id` + `actor_id`.

The relevant pieces of today's permission model:

- `JwtAuthGuard` — verifies the Supabase JWT and sets `req.user`.
- `RolesGuard` (`src/auth/roles.guard.ts`) — reads the `@Roles(...)`
  decorator and enforces `OWNER > COACH > STUDENT`. OWNER is an
  unconditional pass-through.
- `CoachGuard` (`src/auth/coach.guard.ts`) — gate for coach-only
  controllers. OWNER bypass already wired in.
- `SubscriptionGuard` — gates coach **writes** by SaaS subscription
  status (`active`, `trialing`, `grandfathered` always allowed).

The single load-bearing relationship for "who owns this client" is
`User.coach_id`. Every coach-console read either goes through that FK
or filters `ActivityEvent.coach_id` / `CoachMessage.coach_id` /
`MealPlan.coach_id` etc. Every one of those `coach_id` columns is the
**owner's** id today.

## 4. Glossary

These terms have a fixed meaning in this ADR and in the scaffolding
shipped with it:

- **Team** — the smallest unit of business. Exactly one owner, zero
  or more staff, zero or more clients. Every team has a billing
  relationship with The Growth Project.
- **Team owner** — the legal owner of the business. Holds the Stripe
  subscription, can hire/fire staff, can never be demoted by another
  team member. This is the human that today is `role=coach` with a
  `CoachProfile`.
- **Head coach** — staff with full client-roster access and the right
  to assign clients to other staff. May not change billing or remove
  the owner. Optional role; small teams may have zero head coaches.
- **Junior coach** — staff with access to *only* their assigned
  clients. Cannot reassign clients. Cannot view team-wide metrics.
- **Setter** — sales-focused staff. Can view inbound leads and
  prospects, can send messages to leads, **cannot** view or modify
  paying clients' programs.
- **Ops** — administrative staff. Can manage team-wide non-clinical
  settings (branding, invite codes, billing-portal hand-off) but
  **cannot** view client health/check-in data.
- **Platform owner** — the existing OWNER role on `User`. The Growth
  Project staff. Unchanged by this ADR. Never confused with a
  "team owner" — when ambiguity matters, this ADR uses the full
  phrase "platform OWNER" vs "team owner".
- **Member** — a generic term for any person attached to a team in
  any role (owner, head coach, junior coach, setter, ops, or a
  client).

## 5. Proposed model

### 5.1 New entities

```
Team
├── id                  uuid, pk
├── owner_user_id       uuid, fk → User.id, unique
├── name                string                  (defaults to CoachProfile.business_name)
├── created_at          timestamptz
└── archived_at         timestamptz?            (soft-archive; never hard-delete a paying business)

TeamMembership
├── id                  uuid, pk
├── team_id             uuid, fk → Team.id
├── user_id             uuid, fk → User.id
├── role                enum TeamRole           (see 5.2)
├── invited_by_user_id  uuid, fk → User.id?
├── invited_at          timestamptz
├── accepted_at         timestamptz?
├── revoked_at          timestamptz?
└── unique (team_id, user_id) where revoked_at IS NULL

ClientAssignment
├── id                  uuid, pk
├── team_id             uuid, fk → Team.id
├── client_user_id      uuid, fk → User.id
├── assigned_to_user_id uuid, fk → User.id      (must be a member of team_id)
├── assigned_by_user_id uuid, fk → User.id      (must be owner or head_coach)
├── assigned_at         timestamptz
├── revoked_at          timestamptz?
└── unique (team_id, client_user_id) where revoked_at IS NULL
```

### 5.2 New enum

```
enum TeamRole {
  team_owner       // exactly one per team; corresponds to today's role=coach with a CoachProfile
  head_coach       // optional; full team access except billing + member-management of owner
  junior_coach     // assigned-clients-only access
  setter           // leads/prospects only
  ops              // non-clinical team admin only
  client           // a User with role=student attached to this team
}
```

`TeamRole.client` is included so a single table — `TeamMembership` —
can answer "is this user attached to this team in any capacity?"
without joining `User.coach_id`. This subsumes the client-side of the
`User.coach_id` self-relation **without removing it**: see §6 on
backwards compatibility.

### 5.3 Relationship to existing tables

- `Team` is created lazily for any `User` with `role=coach`. The
  backfill is one row per existing coach, with `name` copied from
  `CoachProfile.business_name`. Solo coaches end up with a team of
  size 1 (just themselves as `team_owner`) and zero non-client
  members.
- `User.coach_id` stays. It still points at the **team owner** for a
  client of a solo team, and continues to point at the team owner for
  a multi-staff team. Per-staff assignment is *additive* and lives in
  `ClientAssignment.assigned_to_user_id`. Existing controllers that
  read `User.coach_id` keep returning correct results without change.
- `CoachProfile` stays. There is exactly one `CoachProfile` per
  team — the owner's. Branding, invite codes, billing all stay on the
  owner.
- `CoachSubscription`, `Invoice`, `PaymentFailure` stay keyed on the
  owner. Junior coaches and setters never have their own
  subscription rows.
- `ActivityEvent.coach_id` and `CoachMessage.coach_id` stay set to the
  **team owner's** id. A new column,
  `acted_by_member_user_id`, is proposed (additive, nullable) so the
  console can show "Sent by Junior Coach Sam" without losing the
  coach<->client thread shape that mobile already understands.

This separation is the load-bearing design choice in this ADR: the
coach<->client relationship that mobile sees is unchanged. Team Mode
adds a *who-acted* dimension behind the scenes.

### 5.4 Cardinality rules

- A `User` can be a **member** of at most one team (excluding
  `team_owner` and `client` roles, which are also one-team-only).
  Cross-hire is out of scope (see §2).
- A `Team` has exactly one `team_owner` membership at any time. The
  `Team.owner_user_id` column is denormalized for fast lookup; the
  invariant is maintained by `TeamMembership` and a deferred
  database constraint (proposed in §7).
- A `ClientAssignment.assigned_to_user_id` must reference a
  non-revoked `TeamMembership` in the same team with role in
  (`team_owner`, `head_coach`, `junior_coach`). Setters and ops are
  not eligible assignees: they cannot own clients.

## 6. Backwards compatibility

This ADR's **single most important constraint** is that no existing
mobile build, no existing coach-console build, and no existing
production query plan changes meaning the day Team Mode lands.

The compatibility plan:

1. **No existing column changes meaning.** `User.role`,
   `User.coach_id`, `CoachProfile.*`, `CoachSubscription.*`,
   `ActivityEvent.coach_id`, `CoachMessage.coach_id`, etc. all stay
   exactly as they are today. New columns are additive and nullable.
2. **Solo-coach reads stay one-hop.** A solo coach's reads still
   return clients via `User.coach_id`. They never need to JOIN
   through `Team` / `TeamMembership` to get the same answer.
3. **All Team Mode features are flag-gated.** `TEAM_MODE_ENABLED`
   defaults to off. When off, the new entities exist but are unused
   by any controller; the console does not render team-management
   surfaces.
4. **Permission scaffolding is a no-op until wired.** The TypeScript
   files added in this PR define a permission matrix and a
   `can(...)` resolver, but no module imports them. Removing the
   directory is a clean revert.
5. **No existing test changes behavior.** The PR adds tests; it does
   not edit existing tests.

## 7. Migration plan

This ADR does **not** ship a migration. Migrations are forward-only
on this project (`prisma migrate deploy` at boot) and we do not want
the foundational PR to land schema changes before the model is
reviewed. The migration plan below is the recommended sequence for
follow-up PRs.

### Migration 1 — additive tables only

Adds `Team`, `TeamMembership`, `ClientAssignment`, and the
`TeamRole` enum. All columns nullable on existing tables (no
existing columns change). No data backfill.

Rollback: drop the three tables and the enum. Safe because no
existing controller reads them.

**Do not merge** until this ADR is accepted.

### Migration 2 — backfill solo teams

Idempotent script (`scripts/backfill-team-mode.ts`) that:

1. For each `User` with `role=coach`, creates exactly one `Team` row
   if one does not already exist.
2. Creates a `TeamMembership(team_owner)` row for the owner.
3. For each `User` with `role=student` and non-null `coach_id`,
   creates a `TeamMembership(client)` row in the corresponding team.

The script is read-mostly and resumable. It writes nothing if every
team already exists.

Rollback: truncate `TeamMembership` and `Team`. The platform reverts
to the pre-Team-Mode state because no controller reads those tables
yet.

### Migration 3 — additive instrumentation

Adds `acted_by_member_user_id` (nullable) to `ActivityEvent`,
`CoachMessage`, `MealPlan`, `CoachNudge`. Defaults to NULL for all
existing rows; new writes set it to the actual member when the
acting user is not the owner. The mobile shape (which only sees
`coach_id`) is unaffected.

Rollback: drop the columns. Safe; no existing code depends on the
column.

### Migration 4 — enforce invariants

Adds DB-level constraints once the backfill is verified:

- `Team.owner_user_id` references a `TeamMembership(team_owner)`.
- `ClientAssignment.assigned_to_user_id` references a non-revoked
  `TeamMembership` in the same team with an eligible role.

Done as a separate migration so the assertion runs against
already-backfilled data.

Rollback: drop the constraints.

### Migration 5 — feature flag flip

`TEAM_MODE_ENABLED=true`. Controllers begin reading
`ClientAssignment` and the permission matrix begins gating
team-internal routes. Mobile shape is unchanged.

Rollback: set the flag back to off. The DB stays correct because the
new tables are still being written to; reads simply ignore them.

## 8. Permission model

The full permission matrix is the source of truth and lives in code
at `src/common/team-mode/permissions.ts`. The TypeScript export is
authoritative; the table below mirrors it for convenience.

Legend: `Y` = allowed, `n` = denied, `S` = self only,
`A` = assigned-clients only, `T` = team-wide.

| Action                                  | platform OWNER | team_owner | head_coach | junior_coach | setter | ops |
|-----------------------------------------|----------------|------------|------------|--------------|--------|-----|
| view team roster                        | Y              | Y (T)      | Y (T)      | Y (S)        | n      | Y (T) |
| invite a new staff member               | Y              | Y          | n          | n            | n      | n   |
| revoke a staff membership               | Y              | Y          | n          | n            | n      | n   |
| view a client's profile                 | Y              | Y (T)      | Y (T)      | Y (A)        | n      | n   |
| view a client's check-ins / health      | Y              | Y (T)      | Y (T)      | Y (A)        | n      | n   |
| send a message to a client              | Y              | Y (T)      | Y (T)      | Y (A)        | n      | n   |
| message a *lead* (not a paying client)  | Y              | Y (T)      | Y (T)      | Y (A)        | Y      | n   |
| reassign a client to another coach      | Y              | Y          | Y          | n            | n      | n   |
| edit team branding / invite code        | Y              | Y          | n          | n            | n      | Y   |
| open billing portal / manage Stripe     | Y              | Y          | n          | n            | n      | n   |
| view team-wide metrics                  | Y              | Y          | Y          | n            | n      | n   |
| view *own* metrics only                 | Y              | Y          | Y          | Y            | Y      | Y   |
| promote a member to head_coach          | Y              | Y          | n          | n            | n      | n   |
| demote a head_coach to junior_coach     | Y              | Y          | n          | n            | n      | n   |
| transfer team ownership                 | Y              | n*         | n          | n            | n      | n   |

\* Team-ownership transfer is a platform OWNER operation by design.
This prevents a compromised team-owner account from rugging their
own employees, and matches the existing OWNER-only promote/demote
pattern at `POST /admin/users/:id/promote`. A future ADR may
introduce an owner-initiated transfer with a 7-day cool-off and
email confirmation; out of scope here.

### 8.1 The `can(...)` resolver

The resolver is a pure function with no I/O:

```ts
can({
  actor: { role: TeamRole, isPlatformOwner: boolean },
  action: TeamAction,
  scope: { kind: 'self' | 'assigned' | 'team' | 'global', clientId?, teamId? },
  context: { isAssigned?: boolean, sameTeam?: boolean },
}): boolean
```

The caller is responsible for resolving `isAssigned` and `sameTeam`
from the database before calling `can`. This keeps the resolver
trivial to unit test (no Prisma mocking) and lets us reuse it in
batch contexts (e.g. CSV exports, admin reports) where pre-loading
assignment state is much cheaper than doing it per-row.

### 8.2 Wiring (future PR, not this one)

A new `TeamPermissionGuard` will compose with `JwtAuthGuard` and
`RolesGuard`. Per-route, controllers declare:

```ts
@TeamPermission('view_client_health', { scope: 'assigned' })
@UseGuards(JwtAuthGuard, RolesGuard, TeamPermissionGuard)
@Get('clients/:id/check-ins')
```

The guard is responsible for loading `ClientAssignment` and resolving
`isAssigned` before calling `can`. Behavior when
`TEAM_MODE_ENABLED=false`: the guard short-circuits to "use the
existing CoachGuard semantics" — i.e. the coach must own the
client via `User.coach_id`. This makes the guard safe to merge
before the flag flip.

## 9. Mini admin metrics (later)

Out of scope for the foundation PR but in scope for this ADR's
contract. A team owner's "mini admin" view will surface:

- Active client count per non-client member (assigned, not revoked).
- 7-day and 30-day message volume per non-client member.
- Average response time per non-client member (median + p95).
- Last-seen-at per non-client member.
- Stripe subscription health (already exists; just exposed in the
  team view).

The metrics use only existing event sources (`CoachMessage`,
`ActivityEvent`, `AuditLog`). No new event ingestion is required.
The query plan for each metric is one indexed scan keyed on
`team_id` and `created_at`. Each metric is read-only and lives
behind `@TeamPermission('view_team_metrics', { scope: 'team' })`,
which the matrix in §8 grants only to `team_owner`, `head_coach`,
and platform `OWNER`.

A future ADR will detail the metrics surface itself; the foundation
PR only commits to the permission shape.

## 10. Open questions (to resolve before merging the foundation PR)

These are the questions the foundation PR is **blocked on**. None of
them is technical; all of them are product/policy. Each is a yes/no
or pick-one.

1. **Lead vs. paying-client distinction.** Setters get message access
   to leads but not paying clients. Today, "lead" is not a modeled
   concept — every `User` is either coach or student. Should we
   model leads as `User(role=student, coach_id=NULL, lead=true)`,
   or as a separate `Lead` entity? Recommendation in this ADR:
   add a nullable `User.lead_status` rather than a new table, on
   the grounds that a lead frequently converts and we'd otherwise
   be migrating rows across tables.
2. **How many head coaches per team?** Default proposal: unbounded.
   Soft cap (visible warning above 10) optional.
3. **Setter visibility on conversion.** When a lead becomes a paying
   client, does the setter who closed them retain visibility?
   Default proposal: **no** — the setter loses access on conversion;
   a head coach assigns the new client to a junior coach. This keeps
   the matrix clean.
4. **Billing impact of staff seats.** Today the SaaS plan is flat
   ($300/mo per coach). Do team members count as additional seats?
   Default proposal: **no for v1** — staff are free, the team owner
   pays one flat seat. This is the simplest story to ship and the
   easiest to revisit later.
5. **Audit verbosity.** Every staff action must be auditable per §8.
   Existing `AuditLog` has the schema for it (`actor_id`,
   `target_id`, `action`). Confirm: every mutation that today logs
   `coach.*` should log the **acting member's** id in `actor_id` and
   the **team owner's** id under `metadata.team_owner_id` for
   downstream filtering. Recommendation: yes; this is the smallest
   change.
6. **Self-service team creation.** Can a coach add staff without
   contacting platform OWNER? Default proposal: **yes for
   head_coach / junior_coach / setter**, **no for transferring
   ownership** (platform-OWNER gated, see §8 footnote).

The remainder of the open issues — UI surfaces, email copy, how
self-service invite emails are rate-limited, etc. — are deferred to
the implementation ADRs.

## 10a. §10 resolutions (locked 2026-05-10)

Bradley resolved the six product questions inside the foundation PR
itself. The resolutions superseded the v1 defaults proposed above
and are the source of truth for the implementation.

| # | Question | Resolution |
|---|----------|------------|
| Q1 | Staff seat billing | Pro: each staff seat is a paid Stripe quantity line. Enterprise: included unlimited. Growth: feature blocked at the controller. |
| Q2 | Sub-coach assignment relationships | Sub-coach is many-to-many of head coaches, capped at 2. Enforced by service-layer guard + DB trigger. |
| Q3 | Sub-coach removal | Auto-reassign clients to the initiating head coach in a single transaction. One audit row per reassigned client + one `sub_coach_removed` event. |
| Q4 | Audit log scope | Curated 15-event_kind ledger. Not a CRUD firehose. See `team_audit_event_kind` enum in the migration. |
| Q5 | Sub-coach client invite permissions | Sub-coaches may invite clients directly. Attribution lives on `InviteCode.invited_by_user_id`. |
| Q6 | Tier gating | Pro and Enterprise pass. Growth and unknown blocked with `{ kind: 'team_mode_locked', current_tier, required_tier: 'pro', upsell_url: '/pricing' }` envelope. |

The earlier v1-default proposals in the table above (e.g. "staff are
free", "every team unbounded head-coach count") were superseded.
The current proposal model retains them only as historical record.

### Tier label mapping

The three canonical tiers (verified 2026-05-10 from public
`/llms.txt`) are:

| Tier | Price | Sub-coaches |
|------|-------|-------------|
| Growth | $1,079 / mo | Not available (upsell to Pro) |
| Pro | $2,499 / mo | Paid Stripe staff seat per sub-coach |
| Enterprise | $6,225 / mo | Included, unlimited |

The fitness backend resolves tier from `CoachSubscription.stripe_price_id`
via env-var mapping (`STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_PRO`,
`STRIPE_PRICE_ENTERPRISE`). When the price id does not match any
configured value the resolver returns `unknown` and the team-mode
controllers deny by default — paid features default to closed.

### Required env vars (set in production secrets before launch)

- `STRIPE_PRICE_GROWTH` — Growth tier price id
- `STRIPE_PRICE_PRO` — Pro tier price id
- `STRIPE_PRICE_ENTERPRISE` — Enterprise tier price id
- `STRIPE_PRICE_STAFF_SEAT` — recurring price id for the Pro paid
  staff seat line item (one quantity = one sub-coach)

When `STRIPE_PRICE_STAFF_SEAT` is unset OR `STRIPE_SECRET_KEY` is
unset, the assignment service still creates the local row and audit
events but logs a warning and skips the Stripe call. This is
intentional — preview deploys without Stripe credentials must not
500. Production must set all four.

### Endpoints shipped in this PR

- `POST   /team/sub-coaches`           assign a sub-coach (Q1, Q2, Q6 enforced)
- `GET    /team/sub-coaches`           list active sub-coaches under the head coach
- `DELETE /team/sub-coaches/:subCoachId` remove + auto-reassign (Q3)
- `GET    /team/audit-events`          paginated curated audit feed (Q4)

All four require `JwtAuthGuard + CoachGuard` (per-route) matching
the pattern enforced by Sprint B v2.1 fix sprint. Throttled at 30/min
on writes.

### Schema additions (migration `20260510000000_add_team_mode`)

- `TeamSubCoachAssignment(id, head_coach_id, sub_coach_id, stripe_subscription_item_id, created_at, archived_at)`
  with unique `(head_coach_id, sub_coach_id)`, indexes on both ids
  and `archived_at`, and a Postgres trigger enforcing the 2-head-cap.
- `TeamAuditEvent(id, head_coach_id, actor_user_id, target_client_id?, event_kind, summary, metadata?, occurred_at)`
  with indexes for the head-coach feed read and per-client drill-down.
- `TeamAuditEventKind` enum with 15 values.
- `InviteCode.invited_by_user_id` nullable column + FK + index.

## 11. Risks

1. **Permission drift.** A permission matrix maintained in two places
   (code + this ADR) will drift. Mitigation: code is authoritative;
   the table here is generated-once and a `route-doc-drift`-style
   test (existing pattern at `test/route-doc-drift.spec.ts`) is
   added in the *wiring* PR, not this one.
2. **N+1 on assignment lookups.** Loading `ClientAssignment` per
   request will be a hot path. Mitigation: `ClientAssignment` is
   indexed on `(team_id, client_user_id)` and on
   `(assigned_to_user_id, revoked_at)`. The console BFF already
   batches per-coach reads; we extend the same pattern for staff.
3. **Subscription-status confusion.** A junior coach's "is my account
   active" check is the **team owner's** Stripe state. Mitigation:
   `SubscriptionGuard` already accepts a `coachId` indirection; we
   pass the team owner's id rather than the actor's id.
4. **Backfill correctness.** A buggy backfill that creates duplicate
   teams or misassigns clients would be very visible. Mitigation:
   the backfill is idempotent, dry-run-able
   (`TEAM_BACKFILL_DRY_RUN=true`), and produces a summary
   row-by-row diff before writing. Same pattern as
   `scripts/gdpr-scrub.ts` and `scripts/backfill-coach-subscriptions.ts`.
5. **Client communication.** Clients will start seeing messages from
   "Sam, junior coach" instead of "Coach Alex". Mitigation: the
   coach-console UI controls the from-line; mobile renders
   `coach_id`'s display name unchanged unless the team owner opts
   in to per-staff attribution. Setting lives on `CoachProfile`,
   added in the wiring PR, not this one.

## 12. Rollout

| Phase | Trigger | Action | Rollback |
|---|---|---|---|
| 0 | This PR accepted | ADR + permission scaffolding merged. No DB change. | Revert PR. |
| 1 | After §10 resolved | Migration 1 (additive tables). | Drop new tables. |
| 2 | After phase 1 stable | Backfill script (dry-run first). | Truncate new tables. |
| 3 | After phase 2 verified | Migration 3 (additive instrumentation columns). | Drop new columns. |
| 4 | After phase 3 stable | Wire `TeamPermissionGuard`; ship UI behind `TEAM_MODE_ENABLED=false`. | Set flag off and revert guard wiring. |
| 5 | When ready | Migration 4 (DB constraints). | Drop constraints. |
| 6 | Bradley signs off | `TEAM_MODE_ENABLED=true`. | Set flag off. |

Each phase is its own PR. Each PR is mergeable, deployable, and
revertable on its own.

## 13. Alternatives considered

### Alt A: shared accounts ("share your password with your junior coach")

Cheapest. Already possible. **Rejected** because every action is
attributed to the wrong human, audit is useless, and one staff
firing requires a password reset that locks everyone out.

### Alt B: a separate `Organization` entity disjoint from `User`

Closer to a true B2B SaaS. **Rejected** for now because it requires
moving billing, invite codes, and branding off `CoachProfile` onto
`Organization`, which means a long backwards-incompatible migration
for every existing coach. The proposal here keeps the coach as the
center of gravity and adds team-shaped data around them.

### Alt C: per-staff `coach_id` (i.e. clients belong directly to a junior coach)

Looks simple. **Rejected** because billing, branding, AI spend caps,
and the Stripe relationship are all per-team, not per-staff. Putting
clients under a junior coach's `coach_id` would force every existing
billing query to learn about a "real coach behind this coach" idea,
which is exactly the indirection this ADR is designed to *contain*.

## 14. Acceptance criteria for the foundation PR

The PR accompanying this ADR ("[DRAFT] feat(team-mode): foundation —
ADR + permission scaffolding") is acceptable to merge **only** when:

1. The §10 open questions have been resolved by Bradley.
2. CI is green: `npm run lint && npm test && npx tsc --noEmit && npm run build`.
3. The permission matrix in `src/common/team-mode/permissions.ts`
   exactly matches the table in §8.
4. The PR contains zero changes outside `docs/architecture/`,
   `src/common/team-mode/`, and `test/team-mode-permissions.spec.ts`.
   No `prisma/schema.prisma` change. No `app.module.ts` change. No
   migration directory change.

The **do-not-merge** instructions are repeated on the PR
description itself.
