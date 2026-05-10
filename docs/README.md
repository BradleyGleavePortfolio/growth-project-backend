# Documentation index

A map of the long-form docs in this folder and the per-module READMEs
that live alongside the code. The module READMEs are the source of
truth for **how a module behaves**; the runbooks here are the source
of truth for **how to operate the platform**.

The repository root [`README.md`](../README.md) is the single
operator-facing summary of every environment variable, every feature
flag, the platform-level data structures (Role, OWNER + COACH +
STUDENT, CoachProfile, CoachSubscription, Invoice, PaymentFailure,
MessageDraft, ActivityEvent, audit + GDPR posture), the route
contracts the mobile app and coach console depend on, the deployment
shape, and the smoke-test contract. Read it first.

## Operator runbooks

| Doc | What it covers |
|---|---|
| [`deploy-runbook.md`](./deploy-runbook.md) | End-to-end deploy procedure for staging and production: env validation tiers, migrations, OWNER bootstrap, feature-flag rollout order, Stripe wiring, smoke tests, rollback, operator workflow for production secrets. Also covers Supabase project/key cross-pinning (§0.1), app-`Role.owner` vs Supabase project owner (§0.2), Fly secrets being write-only (§1.1), Prisma migration baseline requirement on a non-greenfield production DB (§2.1), the post-deploy migration smoke (§5.1), federation-token rotation across both apps (§7c), and the deploy-affecting PR docs rule (§10). |
| [`stripe-setup.md`](./stripe-setup.md) | Stripe dashboard configuration: products, prices, webhook secrets, customer portal. |
| [`audit-and-gdpr.md`](./audit-and-gdpr.md) | `AuditLog` schema and call sites; GDPR data-export and soft-delete account-lifecycle endpoints; operator path for honoring a manual deletion request; PII scrub follow-up. |
| [`entitlements.md`](./entitlements.md) | Product-entitlement read model: `fitness_only` / `finance_only` / `performance_os` bundles, per-product status (trialing/active/past_due/canceled/suspended/inactive/unknown), how degraded finance maps to `unknown` (never silently to `inactive`), how GDPR grace period collapses to `suspended`, and the additive Phase-2 override-table shape kept here so a future migration is mechanical. No migration in Phase 1. |
| [`metrics.md`](./metrics.md) | Server-side metrics: PostHog event taxonomy in `src/analytics/events.ts`, OWNER-only `/api/admin/metrics` counter shape, what is and is not synthesized. |
| [`admin-reports.md`](./admin-reports.md) | OWNER-only operational reports / CSV+JSON exports under `/api/admin/reports/*`: when to use which report, common curl recipes, output envelope contract, privacy contract (no per-record activity in the clients CSV), failure modes when finance federation is degraded. |
| [`admin/control-room-spec.md`](./admin/control-room-spec.md) | **Docs-only target spec** for the OWNER admin console as a Healthie/EHR-style operator control room: KPI cards, ARR/MRR math, coach/client cohorts, retention/dunning, universal person search, person profile timeline, finance federation, product usage, support flags, integrations health, audit/RBAC, safety confirmations. Reconciles every existing `/api/admin/*` endpoint against the future-state UI and enumerates the exact endpoint gaps a follow-up runtime PR must close. |
| [`staging-execution-tracker.md`](./staging-execution-tracker.md) | Staging cut-over checklist and validation tracker. |
| [`e2e-qa-runbook.md`](./e2e-qa-runbook.md) | Manual end-to-end QA sweep against a deployed environment. Run after smoke green. Lists the credentialled prereqs the smoke script intentionally does not exercise. |
| [`invite-landing.md`](./invite-landing.md) | Deep-link / universal-link contract and the QR validation harness. |
| [`coach-console-integration.md`](./coach-console-integration.md) | BFF contract followed for `tgp-coach-console`. |
| [`AI_MOBILE_PATCH_INSTRUCTIONS.md`](./AI_MOBILE_PATCH_INSTRUCTIONS.md) | Mobile-side patch notes for the AI assistant. |
| [`ptm.md`](./ptm.md) | Predictive Tracking Model (Phase 1) operator guide: the three tables (`ClientSignal`, `ClientOutcome`, `PtmPrediction`), the fire-and-forget signal-collection contract, score interpretation (advisory only), the privacy posture (mobile clients never see raw scores), and the forward path through Phase 1B (heuristic + nightly recompute), 1C (admin teaching surface), and 1D (weighted v2 engine). |

## Coach-facing content

| Folder | What it covers |
|---|---|
| [`help/`](./help/README.md) | Public coach help: setup checklist, first-invite walkthrough, console tour, FAQ, support boundaries, contact intake spec. Also houses the `_tokens.md` registry and the `_decisions.md` editorial log. |
| [`emails/onboarding/`](./emails/onboarding/README.md) | Coach onboarding email sequence. Each file is one email with frontmatter capturing trigger, subject, and CTA. The sequence is opt-in by behavior, not a fixed cadence. |

## Module READMEs

Each major module owns a README next to its source. Read these first
when modifying a feature.

### Identity, gating, and platform admin

- [`src/auth/README.md`](../src/auth/README.md): Supabase JWKS auth,
  role hierarchy (OWNER, COACH, STUDENT), Google OAuth bridge,
  signup-with-code, throttling.
- [`src/admin/README.md`](../src/admin/README.md): OWNER-only
  promotion, coach inventory, lazy `CoachProfile` provisioning,
  metrics counter, audit-log read.
- [`src/admin/federation/README.md`](../src/admin/federation/README.md):
  Cross-product federation (fitness + finance) for the
  Healthie/EHR-style admin console. `/admin/federation/*` routes,
  `FINANCE_*` env vars, `finance.status` envelope, the
  email-vs-`account_id` join-key roadmap. (Open: PR #79.)
- [`src/admin/console/README.md`](../src/admin/console/README.md):
  Console-friendly alias routes (`/admin/search`,
  `/admin/coaches/:id/overview`, `/admin/clients/:id`,
  `/admin/clients/:id/unified`, `/admin/finance/health`,
  `/admin/integrations/status`). Thin layer above the federation
  service; delegates so the unified payload is identical. (Open:
  PR #80, depends on #79.)
- [`src/audit/`](../src/audit/) (no README; see
  [`docs/audit-and-gdpr.md`](./audit-and-gdpr.md)): `AuditService.write`,
  `AuditAction` constants, append-only convention.
- [`src/invite-codes/README.md`](../src/invite-codes/README.md):
  Default per-coach invite link, legacy multi-row codes, atomic
  attach.

### Coach surfaces

- [`src/coach/README.md`](../src/coach/README.md): Mobile coach
  dashboard, roster, timeline, alerts, guidelines.
- [`src/v1/README.md`](../src/v1/README.md): Coach-console BFF.
  Subscription-gated message and draft writes.
- [`src/messaging/README.md`](../src/messaging/README.md): Coach +
  client messaging, Supabase Realtime ping, read markers, unread
  counts.

### Billing

- [`src/billing/README.md`](../src/billing/README.md): Stripe
  webhook handler, mirror tables (`CoachSubscription`, `Invoice`,
  `PaymentFailure`, `StripeProcessedEvent`), `SubscriptionGuard`,
  OWNER and coach billing surfaces.

### AI

- [`src/ai/README.md`](../src/ai/README.md): GP assistant: typed
  `ClientAIContext`, system-prompt assembly, post-response
  guardrails, deterministic fallback.

### Public surfaces

- [`src/invite-landing/README.md`](../src/invite-landing/README.md):
  HTML landing at `/join/:code` and `/invite/:code`.
- [`src/public-pages/README.md`](../src/public-pages/README.md):
  Durable `/download/*`, `/signup`, `/privacy`, `/terms`,
  `/security`, `/status` pages.

### Data and tooling

- [`prisma/README.md`](../prisma/README.md): Schema, migration
  policy, migration index, schema highlights for the platform-level
  rows (User, CoachProfile, CoachSubscription, Invoice,
  PaymentFailure, MessageDraft, CoachGuideline, ActivityEvent).
- [`scripts/README.md`](../scripts/README.md): `release.sh`,
  `bootstrap-owners.ts`, env-secret printer, smoke, Stripe webhook
  smoke replay.

## Reading order

If you are new to the codebase, read in this order:

1. The repository root [`README.md`](../README.md) for stack, env
   vars, feature flags, structures, route contracts, deployment, and
   the smoke contract.
2. [`src/auth/README.md`](../src/auth/README.md): every
   authenticated route flows through this.
3. The README for the module you are modifying.
4. The runbook closest to the change you are about to make.

## What "backend live" means

The smoke script (`scripts/smoke.ts`, `npm run smoke:staging` and
`npm run smoke:prod`) is a boot-and-shape signal. Smoke green means
the app booted, env validation passed, the global guards are wired,
the BFF and Stripe routes are mounted, and the public invite landing
renders. It does **not** mean a real user can sign up, redeem a
coach invite, exchange a message, get an AI reply, and complete a
Stripe checkout end-to-end. The full SaaS end-to-end pass is the
manual sweep in [`e2e-qa-runbook.md`](./e2e-qa-runbook.md) and runs
after smoke. Treat backend live and full SaaS E2E green as separate
gates; do not infer one from the other.
