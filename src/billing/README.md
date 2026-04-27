# billing

Per-seat coach SaaS billing. Receives Stripe webhooks, mirrors the
relevant subscription / invoice / payment-failure rows, and exposes a
guard that gates coach write paths on subscription state.

The Stripe SDK is **not** a runtime dependency of this module — webhook
signature verification is reimplemented locally and outbound calls to
Stripe go through a hand-rolled REST client (`StripeApiService`). Tests
never need a Stripe account, and the webhook handler is the only
Stripe-touching path that receives untrusted input.

## Purpose

- Verify and ingest Stripe webhook events into the local mirror tables
  (`CoachSubscription`, `Invoice`, `PaymentFailure`,
  `StripeProcessedEvent`).
- Idempotently apply each event so a Stripe retry never double-counts.
- Read the mirror for the coach-facing billing screen.
- Provide `SubscriptionGuard`: gate coach writes behind subscription
  state, with a 7-day grace on `past_due` and a feature-flag escape
  hatch for safe rollout.
- Surface OWNER-only write skeletons (`start-subscription`,
  `portal-session`) that fail closed when Stripe is not configured for
  the environment.

## Key files

| File | What it owns |
|---|---|
| `stripe-webhook.controller.ts` | `POST /api/v1/webhooks/stripe` — public, signature-verified |
| `stripe-signature.ts` | Stripe HMAC-SHA256 v1 signature verification + a test-only signer |
| `stripe-api.service.ts` | Outbound REST client for Customer / Subscription / BillingPortal session creation |
| `billing.service.ts` | Event router and the mirror-table writers |
| `subscription.guard.ts` | `SubscriptionGuard` — used by coach console write paths |
| `coach-billing.controller.ts` | `GET /api/v1/coach/me/billing`, `POST /api/v1/coach/me/billing/portal-session` |
| `owner-billing.controller.ts` | `POST /api/v1/admin/coaches/:id/start-subscription` |

## Webhook flow

1. `StripeWebhookController.stripe` reads `req.rawBody` (set by Nest's
   `rawBody: true` flag in `main.ts`) and falls back to a deterministic
   `JSON.stringify(req.body)` for development.
2. `verifyStripeSignature` parses the `stripe-signature` header,
   recomputes `HMAC-SHA256(t.payload, STRIPE_WEBHOOK_SECRET)`, and
   compares with `timingSafeEqual`. The 300-second tolerance window
   matches Stripe's documented default.
3. The parsed event goes to `BillingService.handleEvent`, which:
   - Claims the event id by inserting into `StripeProcessedEvent`
     **before** routing — concurrent deliveries of the same event id
     race on the `@id` unique constraint and the loser short-circuits as
     `alreadyProcessed: true`. This closes the read-then-write race the
     prior implementation had.
   - Routes by `event.type` to the matching applier.
   - Logs handler errors but leaves the claimed row in place so a
     poison-pill payload does not loop through Stripe's retry queue.
4. `applySubscription` upserts `CoachSubscription` keyed by `coach_id`,
   resolved from `CoachProfile.stripe_customer_id`.
5. `applyInvoicePaid` upserts `Invoice` and clears
   `last_payment_failed_at` / `failed_payments_this_month` on the coach
   sub row.
6. `applyInvoicePaymentFailed` writes a `PaymentFailure` and increments
   `failed_payments_this_month`.
7. `applyCustomerUpdated` keeps `billing_email` and `card_last4` fresh
   on the mirror.

Events with no resolvable coach (`stripe_customer_id` not on any
`CoachProfile`) are logged and skipped — better to refuse than to
clobber an unrelated row.

## Subscription guard policy

`SubscriptionGuard` runs after `JwtAuthGuard`. Policy by
`CoachSubscription.status`:

| Status | Behavior |
|---|---|
| `active` / `trialing` | Allow |
| `past_due` | Allow within 7 days of `last_payment_failed_at`; otherwise deny when enforce mode is on |
| `canceled` / `paused` | Deny when enforce mode is on |
| `incomplete` / `unpaid` / unknown | Deny when enforce mode is on |
| Missing row | Allow (rollout state — every live coach has a row once Stripe is wired) |

OWNER bypasses this check entirely — Tier-0 platform admin.

The `BILLING_ENFORCEMENT` env var controls the verdict when policy
fails. Anything other than `enforce` puts the guard in observe-only
mode and lets the request through. Production must flip it to
`enforce` after Stripe goes live.

## Security and tenancy rules

- The webhook is `@Public()`. All security flows from HMAC verification.
  When `STRIPE_WEBHOOK_SECRET` is unset, every request is rejected with
  400 — fail loud beats silent acceptance.
- The signature verifier uses `timingSafeEqual` and tolerates multiple
  `v1` candidates so signing-secret rotations do not break in flight.
- Coach write endpoints attach `SubscriptionGuard` after
  `CoachOrOwnerGuard`. STUDENTs never reach this guard; the layered
  defense exists so a routing mistake does not silently bypass billing.
- Coach-facing billing reads only the caller's own
  `CoachSubscription`. There is no cross-tenant read path on this
  controller.
- OWNER-only writes are mounted under `/api/v1/admin/...` and are explicitly
  separated from the coach-facing controller so role escalation is not
  a one-line mistake.

## Outbound Stripe calls

`StripeApiService` is a thin REST client over `fetch`. Three methods:

- `createCustomer({ email, name, metadata, idempotencyKey })`
- `createSubscription({ customer, priceId, trialPeriodDays?, metadata, idempotencyKey })`
- `createBillingPortalSession({ customer, returnUrl })` — no idempotency key needed (cheap, short-lived)

Posture:

- API version pinned to `2024-09-30.acacia` via the `Stripe-Version`
  header. This must match the version configured on the webhook endpoint
  in the Stripe dashboard so payload shapes stay aligned.
- All write requests are form-encoded in Stripe's bracketed convention
  (`metadata[key]=value`, `items[0][price]=price_…`).
- `Idempotency-Key` is forwarded on customer + subscription creation so
  a retried OWNER request doesn't double-create on Stripe's side.
- Errors are normalized into `StripeApiError { httpStatus, stripeCode,
  stripeType }` so controllers can translate to a matching HTTP status.
- `STRIPE_SECRET_KEY` is read at call time so tests can mutate env per
  case. `fetchImpl` is `protected` for subclass-based test doubles —
  same philosophy as the hand-rolled HMAC verifier (no Stripe npm SDK
  runtime dep).

## OWNER start-subscription flow

`POST /v1/admin/coaches/:id/start-subscription` — body `{ plan?:
'flat_300', trialDays?: 0..90 }`.

1. Validate target user is `role=coach` with a `CoachProfile`.
2. Validate `STRIPE_SECRET_KEY` and `STRIPE_PRICE_ID_FITNESS` are set.
3. Validate `body.trialDays` is integer `0..90` when provided.
4. Refuse if existing subscription is `active|trialing|past_due`
   (`SUBSCRIPTION_ALREADY_ACTIVE`) — plan changes go through the portal.
5. Create the Stripe Customer if `CoachProfile.stripe_customer_id` is
   null. Idempotency key: `coach_customer_<coach_id>`.
6. Create the Subscription on the configured price. Idempotency key:
   `coach_subscription_<coach_id>_<price_id>`. Metadata includes
   `coach_id`, `plan_tier`, `started_by_owner_id`.
7. Upsert `CoachSubscription` immediately so the console reflects state
   without waiting for the webhook (which will idempotently re-apply on
   arrival).
8. Mirror id/status/period back onto `CoachProfile`. The
   `subscription_status` column is a Prisma enum with five members; we
   only write it when the Stripe status maps cleanly
   (`incomplete`/`unpaid` are still carried in full on
   `CoachSubscription.status`).

## Coach portal-session flow

`POST /v1/coach/me/billing/portal-session` — no body.

1. 400 `STRIPE_NOT_CONFIGURED` when `STRIPE_SECRET_KEY` is unset.
2. Resolve `stripe_customer_id` from `CoachSubscription` first, falling
   back to `CoachProfile`.
3. 400 `BILLING_NOT_PROVISIONED` when neither has a customer id.
4. Mint a Stripe Billing Portal session with
   `STRIPE_BILLING_PORTAL_RETURN_URL` (default
   `https://console.thegrowthproject.app/billing`).
5. Return `{ url }` on success. `StripeApiError` is translated into a
   matching HTTP status with body
   `{ error: 'STRIPE_PORTAL_ERROR', stripeCode }`.

## Environment variables

| Var | Tier | Purpose |
|---|---|---|
| `STRIPE_WEBHOOK_SECRET` | prod | HMAC signing secret. Required for every webhook to be accepted. |
| `STRIPE_SECRET_KEY` | prod | Stripe API key. Required for the portal/start-subscription handlers to do real work. |
| `STRIPE_PRICE_ID_FITNESS` | prod | Price id for the flat coach SaaS plan. |
| `STRIPE_PRICE_ID_FINANCE` | optional | Reserved for the second vertical. |
| `STRIPE_BILLING_PORTAL_RETURN_URL` | optional | Where Stripe sends coaches after the portal session ends. Defaults to the production console URL. |
| `BILLING_ENFORCEMENT` | optional | `enforce` blocks `past_due` past grace and `canceled`/`paused` outright. Anything else is observe-only. |

In development, omitting `STRIPE_SECRET_KEY` leaves the routes mounted
but returns `STRIPE_NOT_CONFIGURED` for both the portal-session and
start-subscription handlers. The console renders the right empty state
without a real Stripe key.

## Failure modes

- Missing `STRIPE_WEBHOOK_SECRET` → 400 `Stripe webhook secret not
  configured`. Stripe will retry; rotating the secret on Fly fixes it.
- Bad signature, expired timestamp, malformed header → 400 with a
  `Stripe signature: …` message. Stripe stops retrying after a 4xx, so
  a misconfigured secret in prod is loud (the webhook dashboard will
  go red) rather than silent.
- Unresolvable `customer` (no matching `CoachProfile.stripe_customer_id`)
  → event is recorded as processed and ignored. Investigate via the
  `StripeProcessedEvent` table.
- Duplicate `event.id` → `{ processed: false, alreadyProcessed: true }`,
  200. Stripe stops retrying and the mirror is unchanged.
- Handler throws → the event id is still recorded so a poison payload
  does not loop forever. Inspect logs and replay manually after fixing
  the bug.

## Tests

| File | Covers |
|---|---|
| `test/stripe-webhook.spec.ts` | End-to-end flow: signature accept/reject, event idempotency (insert-first race), mirror writes |
| `test/stripe-webhook-fixtures.spec.ts` | Replays the JSON fixtures under `test/fixtures/stripe/` |
| `test/subscription.guard.spec.ts` | Every status × `BILLING_ENFORCEMENT` matrix + observe-mode telemetry |
| `test/stripe-api.service.spec.ts` | Outbound REST client: form encoding, idempotency keys, error envelope parsing |
| `test/coach-billing.controller.spec.ts` | Portal-session minting: not-configured, not-provisioned, customer-id resolution, error translation |
| `test/owner-billing.controller.spec.ts` | start-subscription: validation, idempotency keys, mirror writes, Stripe error translation |

## Operational notes

- `scripts/stripe-webhook-smoke.ts` replays the fixture set against a
  running dev server — useful when iterating on `BillingService` with
  no Stripe account.
- The OWNER `start-subscription` and coach `portal-session` handlers
  return `STRIPE_NOT_CONFIGURED` until `STRIPE_SECRET_KEY` is set in
  the environment. Once set, they call Stripe for real.
- `SubscriptionGuard` in observe-mode emits PostHog
  `server_billing_enforcement_observed` with `{ status, reason, route,
  method }` (no PII) so we can size the impact of a future
  `BILLING_ENFORCEMENT=enforce` flip without enabling enforcement
  blindly.
- A coach can be archived without removing their `CoachSubscription`
  row; the guard will start refusing writes once enforcement is on.
- Watch `PaymentFailure` and the `failed_payments_this_month` counter
  for sustained signal — repeated failures across a billing cycle are
  the trigger for an OWNER outreach.
