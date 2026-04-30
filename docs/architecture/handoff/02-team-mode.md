# Handoff brief 02 — Team Mode foundation

> Operator-facing pre-work brief for expansion-roadmap item **#02**.
> Companion to the engineer-facing ADR at
> [`adr-0001-team-mode-foundation.md`](../adr-0001-team-mode-foundation.md)
> and to draft PR **#118**. Read this brief first, then the ADR.

**Status:** In discovery — ADR drafted, permission scaffolding
present in `src/common/team-mode/`, no runtime wiring.
**Last updated:** 2026-04-30.
**Roadmap row:** [`expansion-roadmap.md` row 02](../expansion-roadmap.md).

---

## WHY

Today, a coach is a single `User` row with `role=coach` and a 1:1
`CoachProfile`. Their clients are `User` rows with `role=student`
and a `coach_id` self-reference. This is correct for a solo
operator and we deliberately **keep** that shape working unchanged.

What it does not model is the next business shape: a coach who
employs other humans — junior coaches, setters, ops/admin staff —
who interact with the same clients under explicit permissions. The
ADR's top-priority goal (§1.1) is *"coaches having their own
coaches"*: letting a coach grow into a small business without
giving up ownership of the book of clients or the billing
relationship with the platform.

Team Mode adds a **separate team layer** (`Team` +
`TeamMembership` + `ClientAssignment`) **around** the existing
coach so the existing data model is unchanged for solo coaches and
the mobile app keeps seeing one `coach_id` per client. Per-staff
attribution is added behind the scenes via a new nullable
`acted_by_member_user_id` column in a future migration.

This is the substrate item #09 (group programs) depends on, and
forward-compatibility for Team Mode is already woven into the
AI Program Builder RFC (item #01, §22) so neither feature requires
a redesign of the other.

## WHEN

Not yet. The work is gated on:

1. **Six product decisions** enumerated in §10 of the ADR. The
   founder (Bradley) must answer each yes/no question before the
   wiring PRs can be opened. They are:
   - Lead modeling — do "leads" get first-class entity status, or
     stay as `User.role=student` with a flag?
   - Head-coach cap — is there a max staff count per team in the
     foundation rollout?
   - Setter visibility on conversion — when a setter converts a
     lead, what stays attributable to the setter post-conversion?
   - Billing impact of staff seats — are staff free under the
     owner's seat, or do they cost the owner per seat?
   - Audit verbosity — do team-internal actions (assignment
     changes, role changes) emit `AuditLog` rows in addition to
     `ActivityEvent` rows?
   - Self-service team creation — can a coach create a team in
     the console, or is this OWNER-gated in Phase 1?
2. **A `TEAM_MODE_ENABLED` feature flag** gating every code path
   added by the wiring PRs. The flag must default to **off** in
   every environment until the §12 rollout reaches Stage 5.
3. **Permission-matrix sign-off.** §8 of the ADR is a table; the
   matrix in [`src/common/team-mode/permissions.ts`](../../../src/common/team-mode/permissions.ts)
   is the executable form. Both must be eyeballed against each
   other and the §8 table accepted before the wiring PR opens.
4. **Conversion of PR #118 from Draft → Ready for review.**
   Converting the draft PR is itself a checkpoint: until it is
   converted, the wiring PR does not start.

## WHERE

The ADR proposes additive entities and a permission-resolver layer.
Existing entities are not renamed and existing relations are not
rewritten.

- **New module (already present, not yet wired):**
  `src/common/team-mode/` — pure TypeScript scaffolding.
  - `roles.ts` — `TeamRole` enum + `TeamAction` action vocabulary
    + `TeamScope`.
  - `permissions.ts` — the matrix and the deterministic
    `can(...)` resolver. Pure function; no I/O. The single
    source of truth for §8 of the ADR.
  - `types.ts` — DTO-shaped types for `Team`, `TeamMembership`,
    `ClientAssignment`. These are *contracts*, not Prisma models.
  - `README.md` — orientation note. **Nothing in `src/` imports
    this directory.** Removing the directory and
    `test/team-mode-permissions.spec.ts` is a clean revert.
- **New tables (additive, in a future migration — not in PR #118):**
  - `Team` — id, owner `coach_id`, name, branding-pass-through
    fields per §5.1 of the ADR.
  - `TeamMembership` — `team_id` × `user_id` × `TeamRole`.
  - `ClientAssignment` — `team_id` × `client_user_id` × assigned
    `member_user_id`.
- **New enum:** `TeamRole` per §5.2 of the ADR.
- **Existing tables touched only additively:** per §5.3 — new
  nullable columns only. The §7 migration plan (5 migrations)
  enforces this.
- **New env var (described in ADR, not yet added to
  `env-validation.ts`):** `TEAM_MODE_ENABLED`.
- **Routes:** new controllers under `/api/team/*` and
  `/api/admin/teams/*`, all gated by a `TeamPermissionGuard` that
  reads `can(...)` from `src/common/team-mode/permissions.ts`. None
  of these exist in PR #118 — they land in the wiring PR(s).
- **Mobile shape:** unchanged for solo coaches. The mobile app
  continues to read `coach_id` per client. Per-staff attribution is
  surfaced via the new `acted_by_member_user_id` column on the
  events the mobile already consumes.
- **Billing:** the owner's existing `CoachSubscription` continues
  to be the single billing relationship (open question in §10 of
  the ADR will confirm whether staff seats are free or paid).

## WHO

- **Owner / decision-maker:** founder (Bradley) for the six §10
  open questions; backend lead for technical acceptance of the
  permission matrix.
- **On the hook for the runtime work:** backend platform — the
  schema, the migrations, the guard, the controllers, the audit
  hook-ups.
- **Stakeholders that must sign off before the wiring PR opens:**
  - Founder — for §10 open questions and the §11 risks
    acknowledgement.
  - Backend lead — for the §5 data model and §7 migration plan.
  - Product — for the mini-admin metrics shape in §9 of the ADR.
- **Audience for the *output* of this work:** team-owner coaches
  (mini-admin metrics), staff coaches (their assigned clients),
  and the OWNER admin console (federation views adjust for
  team-aware reads — see roadmap item #12).

## WHAT

**Already exists (what a future operator can read today):**

- The ADR at
  [`docs/architecture/adr-0001-team-mode-foundation.md`](../adr-0001-team-mode-foundation.md)
  — covering goals, non-goals, glossary, current state, proposed
  data model, backwards compatibility, 5-phase migration plan,
  permission matrix, mini admin metrics, six open questions,
  risks, rollout, alternatives considered, acceptance criteria.
- The architecture-docs index at
  [`docs/architecture/README.md`](../README.md) — describes the
  difference between operator docs and architecture/ADR docs and
  the ADR file-naming conventions.
- Pure TypeScript scaffolding under `src/common/team-mode/` with
  the permission matrix and `can(...)` resolver.
- 73 unit tests at `test/team-mode-permissions.spec.ts` covering
  platform-OWNER bypass, every staff role, the platform-OWNER-only
  `team.transfer_ownership` rule, and matrix completeness — so a
  future row added to the matrix without a test fails CI.
- Draft PR **#118** carrying all of the above. The PR is
  intentionally **non-destructive**: zero runtime changes, no
  imports, no migrations.

**Still to produce (in roughly this order, per §7 of the ADR):**

1. Closure on the six §10 open questions.
2. Migration 1 — additive: create `Team`, `TeamMembership`,
   `ClientAssignment`, and the `TeamRole` enum. Tables start empty.
3. Migration 2 — backfill solo teams: every existing coach gets an
   implicit `Team` of one with themselves as the owner-membership.
4. Migration 3 — additive instrumentation: new nullable
   `acted_by_member_user_id` columns on the rows that need
   per-staff attribution.
5. Migration 4 — enforce invariants: NOT NULL where now safe;
   indexes; partial uniques.
6. Migration 5 — feature-flag flip: `TEAM_MODE_ENABLED` defaults
   on for the first cohort.
7. Wiring PR — `TeamPermissionGuard` + `@TeamPermission(...)`
   decorator + the controllers under `/api/team/*` and
   `/api/admin/teams/*`. The guard delegates to the existing
   `can(...)` resolver — no logic duplication.
8. Console PR — the mini-admin metrics surface in §9 of the ADR.
9. Drift test — locks the §8 ADR table against the matrix in
   `permissions.ts` (mentioned in the README of the scaffolding
   directory as a follow-up).

Each runtime PR must update the §8 table in the ADR if the matrix
changes, must add the new env var to `env-validation.ts` if it
flips a flag, and must update [`docs/deploy-runbook.md`](../../deploy-runbook.md)
if it changes deploy ordering or migration shape.

## HOW

Rollout follows §12 of the ADR end-to-end. The smallest first
non-doc PR is **Migration 1 (additive tables only) behind
`TEAM_MODE_ENABLED`**.

- The migration is purely additive: dropping the migration is
  reversible because nothing reads from the new tables yet.
- The flag is off in every environment.
- It passes the existing CI: `npm test`, `npm run lint`,
  `npm run build`, `npx tsc --noEmit`.
- It does not require any mobile or coach-console change.

The wiring PR follows once Migrations 1–4 are in production. The
flag flip (Migration 5) is the visible-to-coach change; everything
prior is invisible.

When the wiring PR merges and the flag is on for the first cohort,
this brief moves to **in flight** in
[`expansion-roadmap.md`](../expansion-roadmap.md). When the §12
rollout completes and team owners are operating at steady state,
the row moves to **shipped** and this brief is rewritten to point
at the live `src/team/` (or whichever name the wiring PR chooses)
README instead of the ADR.
