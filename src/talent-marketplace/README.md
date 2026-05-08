# Talent Marketplace — `src/talent-marketplace/`

Phase 11 / Track 8. Provides the foundation for the coach talent marketplace: application ingestion, admin review queue, talent pool search, Stripe Connect Express onboarding, and offer lifecycle.

## Overview

The marketplace lets external coaches apply to join the platform's talent pool. Owners review applications and move them into the pool. Scale+ head-coaches can browse the pool and extend offers. On offer acceptance, Stripe Connect Express onboarding is triggered so the coach can receive payouts.

## Data model

| Model | Purpose |
|-------|---------|
| `CoachApplication` | Coach application form. Submitted publicly (no auth). Reviewed by OWNER admins. |
| `CoachConnectAccount` | Stripe Connect Express account mirror (1:1 with User). |
| `CoachOffer` | Head-coach offer to a pool applicant. |

See `prisma/schema.prisma` for field definitions and `prisma/migrations/20260507000000_phase11_talent_marketplace/migration.sql` for the DDL.

## API surface

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/apply/coach` | Public | Submit a coach application |
| `GET` | `/applications/me` | Auth | Applicant reads own application status |
| `GET` | `/admin/applications` | Owner | List all applications (filterable by status) |
| `PATCH` | `/admin/applications/:id/review` | Owner | Score + advance an application |
| `GET` | `/talent/pool` | Auth (Scale+) | Search the talent pool |
| `POST` | `/talent/connect/onboarding-link` | Auth | Request a Stripe Connect Express onboarding URL |
| `GET` | `/talent/connect/status` | Auth | Get Connect account status |
| `POST` | `/talent/offers` | Auth | Head-coach extends an offer |
| `PATCH` | `/talent/offers/:id/accept` | Auth | Accept an offer |
| `PATCH` | `/talent/offers/:id/reject` | Auth | Reject an offer |

## Stripe Connect integration

Uses the existing `fetch`-based pattern from `billing/stripe-api.service.ts` — the `stripe` npm package is intentionally not a runtime dependency.

**Env vars required:**

| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Already required by billing module |
| `STRIPE_CONNECT_CLIENT_ID` | Connect platform client ID (from Stripe Dashboard > Connect settings). Must be provisioned in Fly.io secrets before the onboarding link endpoint is used. |
| `TALENT_POOL_PRICE_ID` | Stripe price ID that grants talent pool access (Scale+ plan). If unset, any active subscription is granted access (dev/staging only). |

**Provisioning:**

```bash
fly secrets set STRIPE_CONNECT_CLIENT_ID=ca_xxx
fly secrets set TALENT_POOL_PRICE_ID=price_xxx
```

## Application status state machine

```
pending → reviewed → approved → pool → placed
                                      ↘ inactive
```

Transitions are managed by `CoachApplicationService.reviewApplication` (admin) and `CoachOfferService.acceptOffer` (applicant). The `placed` status can only be set via offer acceptance, not directly via the review endpoint.

## Revenue routing scaffold

`RevenueRoutingService` documents the `application_fee_amount` + `transfer_data.destination` Stripe Connect pattern but does **not** make live API calls. Full integration is deferred to Track 8.5. See the JSDoc in `revenue-routing.service.ts` for the implementation pattern.

## Out of scope (this PR)

- Head-coach browse/hire UI (Track 8.5)
- Marketing-site public application form (Track 8.5 / marketing-site PR)
- Revenue-split payment intent integration (Track 8.5)
- Stripe Connect `account.updated` webhook handler (Track 8.5)
- 1099 / tax reporting (Track 8.5)

## Tests

```bash
npm test -- --testPathPattern=talent-marketplace
```

Two service-level test suites: `coach-application.service.spec.ts` and `connect-account.service.spec.ts`. PrismaService and the Stripe HTTP layer are both mocked — no network calls.
