# Product specs — Wave 2

This directory holds the canonical product-layer specs that sit on top
of the runtime backend (`growth-project-backend`) and feed the admin
console (`docs/admin/`), the mobile apps (`growth-project-mobile`), and
the finance app (`tgp-finance-app`). The runtime today (PR #116 and
prior) is a single-coach SaaS with per-coach Stripe subscriptions, a
coach console BFF, an OWNER admin/federation surface, and a Perplexity
(`sonar-pro`) AI assistant. The Wave 2 specs in this directory describe
the next product layer — the one that turns The Growth Project from a
single-coach billing platform into a multi-tier coaching organization
platform — without touching runtime code.

This directory is **docs only**. Every spec in here is the contract a
future runtime PR will be graded against.

## Reading order

The eight files are designed to be read top-to-bottom. Each later file
assumes the earlier ones have been internalized.

1. **[`positioning-whop-ai-for-coaches.md`](./positioning-whop-ai-for-coaches.md)** —
   the brand frame, the four buyer archetypes (solo trainers, gyms,
   influencers, info-sellers), the AI angle that makes us *Whop AI* and
   not just Whop, and the four-phase AI roadmap. Every later spec
   inherits this frame; reading it first prevents you from inventing
   product opinions that contradict it.
2. **[`sub-coach-hierarchy.md`](./sub-coach-hierarchy.md)** — the
   single largest schema and RBAC change in the wave. Defines
   `CoachOrganization`, `CoachMembership`, the four-role enum
   (`OWNER`, `HEAD_COACH`, `SUB_COACH`, `ASSISTANT`), entitlement
   inheritance, the two billing flows (Flow A separate billing, Flow B
   internal split via Stripe Connect), the `/api/v1/org/*` and
   `/api/admin/orgs/*` API surface, audit, and the migration strategy
   from today's single-coach world. Mobile and admin both depend on
   this.
3. **[`retention-progression-system.md`](./retention-progression-system.md)** —
   the **engine**: level/milestone/badge ladder for both clients and
   coaches, adapted from Iman Gadzhi's Digital Launchpad transcript
   onto The Growth Project's "right-fit member, not buyer" CEO
   doctrine. Defines `ProgressionLevel`, `Milestone`,
   `MilestoneCompletion`, `Badge`, `BadgeAward`, `JoiningIncentive`,
   the Charter Members loyal-member panel, the yearly-plan upsell with
   auto-promotion, and the gamification ethics statement.
4. **[`retention-progression-rewards.md`](./retention-progression-rewards.md)** —
   the **rewards layer** the engine evaluates against. Captures the
   OWNER-decided coach tenure ladder (M1–M36 — onboarding call,
   leads, mastermind, spotlight, funnel audit, priority requests,
   lifetime pricing, retreat), the coach achievement track (First
   Win, Trusted, Builder, Operator, Authority, Top Performer,
   Comeback Coach, Referrer), the three-track client model
   (Consistency / Outcome / Community), the Year One golden-ticket
   cross-coach exception, and the tier-overlap upsell policy. Split
   from the engine doc on purpose so reward content can iterate
   without schema migrations.
5. **[`onboarding-clients.md`](./onboarding-clients.md)** — the
   first-win moment design and the 5-step product layer that sits on
   top of the existing 10-step + 4-step Lean mobile onboarding. Defines
   what "first win" looks like per archetype, drop-off recovery
   (24h/72h/7d), funnel telemetry, and acceptance criteria.
6. **[`onboarding-coaches.md`](./onboarding-coaches.md)** — the
   6-step coach setup flow, archetype-specific templates, and time-to-
   first-client targets. Cross-references the mobile coach screens
   already shipped (`audit-mobile.md` §2 lists `CoachHomeScreen`,
   `ClientsListScreen`, `InviteCodesScreen`, `ProgramTemplatesScreen`,
   `ClientDetailScreen`).
7. **[`data-tracking-contract.md`](./data-tracking-contract.md)** —
   the "we track everything" contract. Maps every progression event,
   onboarding step, and org action to the existing PostHog +
   `AuditLog` stack, defines the analytics events vocabulary
   additions, and codifies the no-PII-in-PostHog-properties invariant
   (already enforced by `AnalyticsService.capture()` per
   [`../metrics.md`](../metrics.md)).

## Cross-references

This directory does not duplicate anything that already lives in the
canonical runtime docs. Every spec instead points at the existing
source of truth and layers on top of it.

| Existing canonical doc | What Wave 2 specs assume / reuse |
|---|---|
| [`../api-conventions.md`](../api-conventions.md) | All new routes follow the existing `/api/v1/*` and `/api/admin/*` conventions, error-envelope shape, OWNER `@Roles('owner')` gating, and `Authorization: Bearer <supabase-jwt>` model. |
| [`../audit-and-gdpr.md`](../audit-and-gdpr.md) | All state-changing org / progression / billing-split actions emit an `AuditLog` row through `AuditService.write`. New `AuditAction` constants are listed per spec; the append-only invariant is preserved. |
| [`../entitlements.md`](../entitlements.md) | The Wave 2 entitlement model extends the existing `entitlements` read shape with an `org` block and a `progression_unlocks` block. The `unknown` semantics (never silently downgraded to `inactive`) carry over unchanged. |
| [`../metrics.md`](../metrics.md) | Every Wave 2 PostHog event is added to `src/analytics/events.ts` (the canonical taxonomy). The PII deny-list and `distinctId = internal user id` invariants are preserved. The admin metrics endpoint gains org-scoped variants (`?org_id=...`). |
| [`../admin/control-room-spec.md`](../admin/control-room-spec.md) | Sub-coach hierarchy adds an `Organization` column to the Coaches table (§4 of the control-room spec) and an `Organization tree` panel to the Person profile (§7). Progression adds level/badge chips to Person profile and a per-coach breakdown to the Coach profile. The §11.A–O gap inventory is preserved; Wave 2 introduces new gap letters (§11.P+ in the next admin-spec PR) for `/api/admin/orgs/*`, progression rollups, and the Charter Members panel — those letters are listed in §15 of [`sub-coach-hierarchy.md`](./sub-coach-hierarchy.md) but not yet stitched into the canonical spec to keep this PR scoped to docs/product/. |
| [`../admin/deployment-and-rbac.md`](../admin/deployment-and-rbac.md) | The advisory capability matrix gains `act:org_invite_sub_coach`, `act:org_billing_split_change`, `view:progression_admin`, `act:charter_member_admit`, and a few others listed per spec. The Phase-2 sub-OWNER triad is unchanged. |
| [`../admin/screens-addendum.md`](../admin/screens-addendum.md) | The "AI & Audit" screen gains a filter chip for org-scoped audit. The "Privacy & GDPR" screen gains an org-tree-aware delete cascade preview. The "Reports & Exports" screen gains a `progression_completions_by_cohort` report manifest entry. None of these are runtime in this PR. |
| [`../coach-console-integration.md`](../coach-console-integration.md) | All `/api/v1/coach/me/*` paths are preserved; `/api/v1/org/*` is the new family. Existing coaches keep working unchanged in Phase 0 (see [`sub-coach-hierarchy.md`](./sub-coach-hierarchy.md) §12 migration). |

## What Wave 2 is NOT

The spec PR for Wave 2 is **strictly docs-only**. It does not:

- Modify `prisma/schema.prisma`. The Prisma-style schema sketches in
  the specs are illustrative; they are intentionally written in
  ```prisma``` fences in markdown so a future runtime PR can lift
  them, but no `migrate dev`/`migrate deploy` is implied by this PR.
- Modify any file under `src/`.
- Modify environment variable validation (`src/common/env-validation.ts`).
- Modify CI, Fly configuration, the Dockerfile, or any GitHub Action.
- Touch `package.json` or `package-lock.json`.
- Modify `new-website` (no such directory in this repo).
- Open or close any other PR. PR-disposition decisions are tracked in
  the root [`PERP_HANDOFF.md`](../../PERP_HANDOFF.md) for the operator
  to take action on.

## Out-of-scope companion specs

Several adjacent product surfaces have their own canonical homes
elsewhere. Wave 2 references them but does not duplicate them.

| Surface | Lives in | Wave 2 relationship |
|---|---|---|
| Stripe Connect onboarding (account-level) | PR #125 commerce wave (`docs/architecture/expansion-roadmap-addendum-commerce.md`) | Sub-coach billing Flow B (internal split) **consumes** the Stripe Connect plumbing that #125 specs. Wave 2 does not respec it; it cites the contract. |
| Coach storefront / offer builder / marketplace | PR #125 commerce wave | Out of scope. Sub-coach hierarchy applies once a head coach has a storefront, but the storefront spec is owned by #125. |
| Community spaces / events / live calls / replays | PR #126 engagement wave | Out of scope. Charter Members chat surface is *not* a community space; it is an in-app private channel reusing the existing `src/messaging/` module (see [`retention-progression-system.md`](./retention-progression-system.md) §9). |
| AI Program Builder | PR #117 RFC | Surfaced as a Phase-2 entry point in [`positioning-whop-ai-for-coaches.md`](./positioning-whop-ai-for-coaches.md) §6.2. The runtime contract lives in the #117 RFC. |
| Team Mode permission scaffolding | PR #118 ADR | Sub-coach hierarchy is the **product layer** of what #118's permission scaffolding is the **runtime substrate** for. Wave 2 supersedes #118's product framing; #118's ADR remains the runtime substrate. See [`sub-coach-hierarchy.md`](./sub-coach-hierarchy.md) §12. |
| Admin web dashboard / EHR control room | PR #130 (canonical), PRs #127/#128 (superseded) | Wave 2 ships docs in `docs/product/`, not `docs/admin/`. The admin console renders Wave 2 product surfaces via endpoints listed per spec; the next admin-spec PR will fold those endpoints into `control-room-spec.md` §11. |
| Federation to `tgp-finance-app` | `src/admin/federation/` README, `docs/entitlements.md` | The org-aware entitlement read model in Wave 2 layers on top of the existing federation client without rewiring it. |

## Status

Every file in this directory is **draft**. None of them is merged.
The canonical state is tracked in the root
[`PERP_HANDOFF.md`](../../PERP_HANDOFF.md). When a Wave 2 file
graduates to runtime, the runtime PR adds an "Implements" line back to
the spec, and the spec gets an "Implemented in PR #N" line at the top.
Until that round-trip happens, treat every Wave 2 file as draft.
