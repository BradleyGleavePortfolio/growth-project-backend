# 03 — Security, RBAC, & tenant boundaries

> **Last reviewed:** 2026-04-30. Docs-only. No runtime change.

## WHY

Three patterns in the codebase encode "who is allowed to see
this row":

1. **Role hierarchy.** OWNER > COACH > STUDENT. Documented in
   `src/auth/README.md` and the root README.
2. **Per-coach tenancy.** Most user-owned rows scope by
   `coach_id` — a client's check-ins, meal plans, messages,
   guidelines, audit entries. The `User` self-relation
   (`User.coach_id`) is the join key.
3. **Stripe-mirror rows.** Scope by `coach_id` (subscription,
   invoices, payment failures) — coaches do not see other
   coaches' billing.

Team Mode (PR #118) widens (2) from per-coach to per-team. Public
profiles (planned) introduce a *fourth* scope — public,
unauthenticated, but redacted. Templates marketplace (planned)
introduces a *fifth* — visible to many tenants but owned by one.

Without an explicit tenant-boundary invariant and a test that
holds it, every new feature has the chance to leak data across
coaches. The classic shape — a controller resolves a row by id
without scoping by `coach_id` — is the most common cross-tenant
bug class in N-tenant SaaS. We've avoided it so far by
convention; that convention needs to become a tested invariant.

**Cross-feature impact:**

| Feature | Why this lane carries it |
|---|---|
| Team Mode | Tenant boundary widens from `coach_id` to `team_id`. Every existing scoped query needs the team-aware variant. |
| AI Program Builder | Coach assets are per-coach (later: per-team). LLM prompts must never include another coach's asset chunks. |
| Check-ins v2 | New columns must inherit the same scope as the existing check-in row. |
| Public profiles | Inverted scope — *public* by default, with a redaction rule that excludes any client-identifying field. |
| Templates marketplace | Owned by one coach, visible to many. Mutation is owner-only; reads are scoped by entitlement. |
| Revenue dashboards | OWNER sees all; coach sees own. The same pattern as today's billing surface. |

## WHEN

This brief is the precondition for **any** new
data-touching surface. Settle it before:

- Team Mode wires its first runtime route (because Team Mode is
  the largest tenant-boundary widening).
- Templates marketplace ships any read endpoint.

## WHERE

- `src/auth/` — `RolesGuard`, `JwtStrategy`, role hierarchy.
- `src/common/access/` — proposed home of the unified resolver
  (lane #01). The tenant-boundary check is one of the four sub-
  decisions inside `can(...)`.
- `src/billing/SubscriptionGuard` — tenant-aware enforcement.
- `prisma/schema.prisma` — every model that has a `coach_id`
  column. The full list is in `prisma/README.md`.
- `src/admin/federation/` — already cross-tenant-by-design (OWNER
  reading across coaches and across products).

## WHO

- **Owner:** backend lead.
- **Reviewers:** founder (for the redaction rule on public
  profiles), security advisor if one is engaged.
- **On the hook in production:** OWNER. Any cross-tenant leak is
  a P0; see lane #06 for the incident-response template.

## WHAT

### What already exists

- Role hierarchy (`src/auth/README.md`).
- `RolesGuard`, request-scoped role decoration.
- `coach_id` scope on all per-client rows.
- Helmet middleware (`src/main.ts`, PR #92).
- Throttler with user-keyed tracker (PR #93).
- Forgot-password throttle hardening (PR #92).
- Sentry server-side error reporting (PR #95 sourcemaps).
- Audit log for OWNER-side actions (`src/audit/`).
- GDPR scrub on schedule (PR #91).

### What is missing

- An explicit, documented invariant: "every controller that
  reads or mutates a `coach_id`-scoped row resolves the
  authenticated coach first, then queries with `WHERE
  coach_id = $authCoachId`. No `findUnique({ id })` without a
  scope check."
- A test pattern (one helper, used per controller) that proves
  the invariant for every new endpoint.
- A short doc — `docs/security-posture.md` — describing the
  threat model: who we defend against, what we explicitly do
  not (e.g., we do not run a WAF; we rely on Fly's edge plus
  Helmet plus rate-limiting).
- A documented secret-handling posture: which env vars are
  considered secrets (the full `secrets:print` set), how they
  rotate (operator workflow in `deploy-runbook.md` §7c), and
  what the blast radius is for a leak.
- A documented rule for cross-tenant federation reads
  (`/admin/federation/*` is already explicit; the doc just
  needs a one-line "this is intentionally cross-tenant" note
  for reviewers).
- A periodic review cadence (proposed: quarterly) to walk every
  `coach_id` model and re-assert the scope is enforced on every
  controller that touches it.

### Threat model (proposed sketch)

In scope:

- **Cross-tenant data leak** between coaches. Single highest
  priority.
- **Privilege escalation** from STUDENT → COACH or COACH →
  OWNER.
- **Token replay** against the auth flow.
- **Webhook forgery** against `/v1/webhooks/stripe`.
- **Public-page injection** (XSS into invite landing or trust
  pages).
- **Secret-leak via logs** (Sentry, app logs, audit log).

Out of scope (for the operator's awareness — not us pretending
they don't exist, just that they aren't this codebase's job):

- DDoS at the network edge — Fly handles this.
- Account takeover via Supabase Auth — Supabase handles this;
  we hard-pin issuer to one Supabase project (root README §0.1).
- Mobile app reverse engineering — out of scope.

### Tenant boundary invariant (the rule)

Every Prisma query in a controller path that reads or mutates a
row carrying `coach_id` (or, future, `team_id`) MUST include the
authenticated coach (or team) in its `where` clause. The two
allowed exceptions are:

1. **OWNER-only routes.** OWNER bypasses the per-coach scope by
   design. The route path includes `/admin/` or
   `/admin/federation/` and the route guard restricts to OWNER.
2. **Federation routes.** `/admin/federation/*` is OWNER-only
   AND the federation envelope itself carries the
   `finance.status` redaction described in
   `src/admin/federation/README.md`.

Anything else is a bug.

## HOW

### Operator handoff

- Secret rotation: documented in `docs/deploy-runbook.md` §7c.
- Cross-tenant leak detection: Sentry alerts on every 500 from a
  scoped controller; the OWNER triages within the
  incident-response template (lane #06).
- The threat model doc lives at `docs/security-posture.md` and
  is updated quarterly during the standing review.

### Test pattern (proposed)

A small helper, `expectScopedToCoach(controllerCall, otherCoachId)`,
asserts that calling the controller with a JWT for one coach but
a row id belonging to another coach returns 403 or 404 (never the
row). This helper is used in the integration test for every new
controller that reads a `coach_id`-scoped row.

### Public-profiles redaction (proposed)

When public profiles ship, the read-model excludes:

- Any column listed in `docs/audit-and-gdpr.md` as PII.
- Any column with `client_*` prefix.
- Anything in the `MessageDraft` / `Message` / `CheckIn` /
  `MealPlan` set.
- Stripe-mirror columns.

The redaction is a single allow-list, not a deny-list. The
allow-list lives next to the public-profile read controller and
is reviewed by the operator before every shipped change.

## Risks

- **A new controller forgets the scope.** Mitigation: the
  invariant is documented, the test helper is in CI, and the
  PR template asks "does this read a `coach_id` row? Have you
  scoped the query?".
- **OWNER-only routes get accidentally exposed to COACH.**
  Mitigation: the existing `RolesGuard` is the wall; the lane
  #01 resolver makes the role check explicit at the call site.
- **Public profiles leak via a new field.** Mitigation: redaction
  is allow-list, not deny-list, so a new field defaults to
  hidden.
- **Federation cross-product reads leak finance data.**
  Mitigation: the `finance.status` envelope already exists
  (`src/admin/federation/README.md`).

## Dependencies

- Lane #01 (the unified resolver consumes this lane's invariant
  as one of its four decisions).
- `src/auth/` — already in place.
- `RolesGuard` — already in place.

## Acceptance criteria

1. ✅ `docs/security-posture.md` exists with the threat model
   above and the in-scope / out-of-scope split.
2. ✅ The tenant-boundary invariant is a one-liner at the top of
   `docs/security-posture.md` and is referenced from every
   controller-touching PR template line.
3. ✅ The `expectScopedToCoach` test helper exists in
   `test/helpers/` and is used in at least one controller test
   per major surface (auth, messaging, billing, check-ins, AI).
4. ✅ A quarterly review entry exists in
   `docs/security-posture.md` listing the next scheduled review
   date.
5. ✅ The federation routes are documented as the explicit
   exception, with a one-liner in
   `src/admin/federation/README.md`.

## Test strategy

- **Unit:** the lane #01 resolver covers role + tenancy
  decisions.
- **Integration:** `expectScopedToCoach(...)` per major surface.
- **Manual / red-team:** quarterly walkthrough — pick a coach
  account, attempt to read another coach's data through every
  authenticated route. Document findings in the security-posture
  doc.

## Rollout & kill-switch

- Lane is procedural — no runtime change to roll out.
- Kill switch is moot — there is nothing to disable. If the
  invariant is violated by a specific PR, the runtime kill
  switch is the lane #01 resolver returning `{ allowed: false }`.
