# billing

Per-seat coach SaaS billing. Receives Stripe webhooks, mirrors the
relevant subscription / invoice / payment-failure rows, and exposes a
guard that gates coach write paths on subscription state.

The Stripe SDK is **not** a runtime dependency of this module — webhook
signature verification is reimplemented locally so tests never need a
Stripe account, and the webhook handler is the only Stripe-touching path
that receives untrusted input.

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
| `stripe-webhook.controller.ts` | `POST /v1/webhooks/stripe` — public, signature-verified |
| `stripe-signature.ts` | Stripe HMAC-SHA256 v1 signature verification + a test-only signer |
| `billing.service.ts` | Event router and the mirror-table writers |
| `subscription.guard.ts` | `SubscriptionGuard` — used by coach console write paths |
| `coach-billing.controller.ts` | `GET /v1/coach/me/billing`, `POST /v1/coach/me/billing/portal-session` |
| `owner-billing.controller.ts` | `POST /v1/admin/coaches/:id/start-subscription` |

## Webhook flow

1. `StripeWebhookController.stripe` reads `req.rawBody` (set by Nest's
   `rawBody: true` flag in `main.ts`) and falls back to a deterministic
   `JSON.stringify(req.body)` for development.
2. `verifyStripeSignature` parses the `stripe-signature` header,
   recomputes `HMAC-SHA256(t.payload, STRIPE_WEBHOOK_SECRET)`, and
   compares with `timingSafeEqual`. The 300-second tolerance window
   matches Stripe's documented default.
3. The parsed event goes to `BillingService.handleEvent`, which:
   - Short-circuits on duplicate `event.id` via `StripeProcessedEvent`.
   - Routes by `event.type` to the matching applier.
   - Records the event id in a `finally` block so a poison-pill payload
     does not loop through Stripe's retry queue.
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
- OWNER-only writes are mounted under `/v1/admin/...` and are explicitly
  separated from the coach-facing controller so role escalation is not
  a one-line mistake.

## Environment variables

| Var | Tier | Purpose |
|---|---|---|
| `STRIPE_WEBHOOK_SECRET` | prod | HMAC signing secret. Required for every webhook to be accepted. |
| `STRIPE_SECRET_KEY` | prod | Stripe API key. Required for the portal/start-subscription handlers to do real work. |
| `STRIPE_PRICE_ID_FITNESS` | prod | Price id for the flat coach SaaS plan. |
| `STRIPE_PRICE_ID_FINANCE` | optional | Reserved for the second vertical. |
| `BILLING_ENFORCEMENT` | optional | `enforce` blocks `past_due` past grace and `canceled`/`paused` outright. Anything else is observe-only. |

In development, omitting the Stripe vars leaves the routes mounted but
returns deterministic 400 responses (`STRIPE_NOT_CONFIGURED` and
`STRIPE_PORTAL_NOT_IMPLEMENTED`). The console renders the right empty
state without a real Stripe key.

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
| `test/stripe-webhook.spec.ts` | End-to-end flow: signature accept/reject, event idempotency, mirror writes |
| `test/stripe-webhook-fixtures.spec.ts` | Replays the JSON fixtures under `test/fixtures/stripe/` |
| `test/subscription.guard.spec.ts` | Every status × `BILLING_ENFORCEMENT` matrix |

## Operational notes

- `scripts/stripe-webhook-smoke.ts` replays the fixture set against a
  running dev server — useful when iterating on `BillingService` with
  no Stripe account.
- The OWNER `start-subscription` and coach `portal-session` handlers
  return `STRIPE_NOT_CONFIGURED` until `STRIPE_SECRET_KEY` is set in
  the environment, then 501-shaped placeholders until the SDK calls
  land in the follow-up PR.
- A coach can be archived without removing their `CoachSubscription`
  row; the guard will start refusing writes once enforcement is on.
- Watch `PaymentFailure` and the `failed_payments_this_month` counter
  for sustained signal — repeated failures across a billing cycle are
  the trigger for an OWNER outreach.
