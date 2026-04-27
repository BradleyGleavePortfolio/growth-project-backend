# Documentation index

A map of the long-form docs in this folder and the per-module READMEs
that live alongside the code. The module READMEs are the source of
truth for *how a module behaves*; the runbooks here are the source of
truth for *how to operate the platform*.

## Operator runbooks

| Doc | What it covers |
|---|---|
| [`deploy-runbook.md`](./deploy-runbook.md) | End-to-end deploy procedure for staging and production: env validation, migrations, OWNER bootstrap, feature-flag rollout, Stripe wiring, smoke tests, rollback. |
| [`stripe-setup.md`](./stripe-setup.md) | Stripe dashboard configuration: products, prices, webhook secrets, customer portal. |
| [`staging-execution-tracker.md`](./staging-execution-tracker.md) | Staging cut-over checklist and validation tracker. |
| [`e2e-qa-runbook.md`](./e2e-qa-runbook.md) | End-to-end QA flow against a deployed environment. |
| [`invite-landing.md`](./invite-landing.md) | Deep-link / universal-link contract and the QR validation harness. |
| [`coach-console-integration.md`](./coach-console-integration.md) | Notes the BFF surface follows for `tgp-coach-console`. |
| [`AI_MOBILE_PATCH_INSTRUCTIONS.md`](./AI_MOBILE_PATCH_INSTRUCTIONS.md) | Mobile-side patch notes for the AI assistant. |

## Module READMEs

Each major module owns a README next to its source. Read these first
when modifying a feature.

### Identity, gating, and platform admin

- [`src/auth/README.md`](../src/auth/README.md) — Supabase JWKS auth,
  role hierarchy (OWNER → COACH → STUDENT), Google OAuth bridge,
  signup-with-code.
- [`src/admin/README.md`](../src/admin/README.md) — OWNER-only
  promotion, coach inventory, lazy `CoachProfile` provisioning.
- [`src/invite-codes/README.md`](../src/invite-codes/README.md) —
  Default per-coach invite link, legacy multi-row codes, atomic
  attach.

### Coach surfaces

- [`src/coach/README.md`](../src/coach/README.md) — Mobile coach
  dashboard, roster, timeline, alerts, guidelines.
- [`src/v1/README.md`](../src/v1/README.md) — Coach-console BFF.
  Subscription-gated message and draft writes.
- [`src/messaging/README.md`](../src/messaging/README.md) — Coach ↔
  client messaging, Supabase Realtime ping, read markers, unread
  counts.

### Billing

- [`src/billing/README.md`](../src/billing/README.md) — Stripe
  webhook handler, mirror tables, `SubscriptionGuard`, OWNER /
  coach billing surfaces.

### AI

- [`src/ai/README.md`](../src/ai/README.md) — GP assistant: typed
  context, system-prompt assembly, post-response guardrails,
  fallback responder.

### Public surfaces

- [`src/invite-landing/README.md`](../src/invite-landing/README.md) —
  `/join/:code` and `/invite/:code` HTML landing.
- [`src/public-pages/README.md`](../src/public-pages/README.md) —
  Durable `/download/*` and `/signup` pages.

### Data and tooling

- [`prisma/README.md`](../prisma/README.md) — Schema, migration
  policy, migration index.
- [`scripts/README.md`](../scripts/README.md) — `release.sh`,
  bootstrap, env-secret printer, smoke, Stripe webhook smoke.

## Reading order

If you are new to the codebase, read in this order:

1. The repository root `README.md` (stack, setup, env vars).
2. [`src/auth/README.md`](../src/auth/README.md) — every authenticated
   route flows through this.
3. The README for the module you are modifying.
4. The runbook closest to the change you are about to make.
