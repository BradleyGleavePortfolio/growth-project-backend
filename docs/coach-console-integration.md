# Coach Console Backend Integration

This document tracks the v1 BFF surface that backs the Next.js
`tgp-coach-console` web app. It is the practical companion to
`tgp-coach-console/INTEGRATION_NOTES.md` — the spec lives there, this file
records what is actually wired in this backend today.

## Path layout

The backend runs with the global prefix `/api`. Every v1 route in this PR is
mounted under `/v1/...` inside controllers, so the live URL on the coach
console origin is `/api/v1/...`. The integration notes use `/v1/...`
directly; deploy-time path rewriting (or pointing the console at the
`/api`-prefixed origin) reconciles the two without touching either end.

## Mounted in this PR

| Method | Path                                              | Auth                          |
| ------ | ------------------------------------------------- | ----------------------------- |
| GET    | `/v1/coach/me`                                    | JWT + COACH or OWNER          |
| GET    | `/v1/coach/me/clients`                            | JWT + COACH or OWNER          |
| GET    | `/v1/coach/me/threads`                            | JWT + COACH or OWNER          |
| GET    | `/v1/coach/me/threads/:clientId`                  | JWT + COACH or OWNER          |
| POST   | `/v1/coach/me/threads/:clientId/messages`         | JWT + COACH or OWNER + SubGuard |
| GET    | `/v1/coach/me/threads/:clientId/draft`            | JWT + COACH or OWNER          |
| POST   | `/v1/coach/me/threads/:clientId/draft`            | JWT + COACH or OWNER + SubGuard |
| GET    | `/v1/coach/me/billing`                            | JWT + COACH or OWNER          |
| POST   | `/v1/coach/me/billing/portal-session`             | JWT + COACH or OWNER          |
| POST   | `/v1/admin/coaches/:id/start-subscription`        | JWT + OWNER only              |
| POST   | `/api/v1/webhooks/stripe`                         | Public + HMAC signature       |

## Scoping rules

- COACH callers see only their own roster. The service derives the coach id
  from the session — never from a path parameter — so a coach cannot read
  another coach's roster by guessing IDs.
- OWNER callers bypass coach scoping. When an OWNER sends a message, the
  message row is recorded against the client's actual coach (`coach_id`),
  and the OWNER is recorded as the `sender_id`. This keeps the thread
  attached to the right roster while preserving the audit trail.
- STUDENT callers are rejected at `CoachOrOwnerGuard` (403). The mobile
  app's existing `/messages` and `/coach/clients/:id/messages` routes are
  unchanged.

## SubscriptionGuard

`SubscriptionGuard` runs only on coach console write paths
(`POST /v1/coach/me/threads/:clientId/messages` and `POST .../draft`). It
reads from the `CoachSubscription` mirror table and blocks coaches whose
subscription is canceled, paused, or past_due past the 7-day grace window.
OWNER bypasses entirely.

The guard has a deliberate rollout escape hatch: `BILLING_ENFORCEMENT` env
var. While unset (or set to anything other than `enforce`), every coach is
allowed through regardless of mirror state. Production must set
`BILLING_ENFORCEMENT=enforce` after the first webhook delivery has
populated `CoachSubscription` rows for every coach. Until then the guard is
in observe-only mode and is safe to deploy.

The student app (mobile) is never gated by `SubscriptionGuard`. Per the
spec, billing problems on the coach side never block the client experience.

## Stripe webhook

`POST /api/v1/webhooks/stripe` accepts HMAC-signed events from Stripe. The
controller reads the raw request body (Nest 11 `rawBody: true` flag in
`main.ts`), verifies the signature against `STRIPE_WEBHOOK_SECRET`, and
hands the parsed event to `BillingService.handleEvent`.

Mirror tables touched per event type:

| Event                           | Effect                                                        |
| ------------------------------- | ------------------------------------------------------------- |
| `customer.subscription.created` | Upserts `CoachSubscription` (status, period end, trial end)   |
| `customer.subscription.updated` | Same as `.created`                                            |
| `customer.subscription.deleted` | Sets status = `canceled`                                      |
| `invoice.paid`                  | Inserts `Invoice`, clears `last_payment_failed_at`            |
| `invoice.payment_failed`        | Inserts `PaymentFailure`, increments failure counter          |
| `customer.updated`              | Syncs `billing_email` and `card_last4`                        |

Idempotency is enforced via the `StripeProcessedEvent` table. Stripe retries
on non-2xx responses; duplicate event ids return `{ alreadyProcessed: true }`
and the response is still 200.

## Stripe SDK

We do not depend on the `stripe` npm package. The webhook signature
verification is implemented from first principles in
`src/billing/stripe-signature.ts` so tests do not require a real Stripe
account or library mock. When the next PR wires
`POST /v1/coach/me/billing/portal-session` and
`POST /v1/admin/coaches/:id/start-subscription` to real Stripe API calls,
the SDK will be added as a dependency at that point. Today these endpoints
return `STRIPE_NOT_CONFIGURED` when `STRIPE_SECRET_KEY` is unset, and
return `STRIPE_*_NOT_IMPLEMENTED` when it is set, so the contract is live
for the console without forcing a Stripe key in dev.

## What is intentionally NOT in this PR

- Real Stripe SDK calls for portal session / subscription start. Those land
  in the next PR alongside the daily reconciliation cron.
- `OWNER` role bootstrapping (creating the first OWNER row). The `Role`
  enum has been extended to include `owner`, but the bootstrap script lives
  in the larger Phase 1A schema migration and is out of scope here.
- The full coach console BFF for owner mode (`/v1/admin/overview`,
  `/v1/admin/coaches`, `/v1/admin/clients`, `/v1/admin/billing`). This PR
  ships the messaging + billing foundations; admin read views are scoped to
  a follow-up.
- Mobile-side handling of coach paused/canceled state on the client app.
  The student experience is intentionally unaffected.
