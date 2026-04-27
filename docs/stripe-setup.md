# Stripe Setup — Coach SaaS Billing

Operational guide for provisioning Stripe for the per-seat coach SaaS plan
backed by the Stripe-mirror tables introduced in PR #53. The mirror lives
in `src/billing/` and the Prisma models `CoachSubscription`, `Invoice`,
`PaymentFailure`, and `StripeProcessedEvent`.

This doc is for operators (Bradley/Dynasia) standing up Stripe in staging
and production. It does **not** require code changes — every step is
performed in the Stripe dashboard or via Fly secrets.

> **No secrets in this repo.** Never commit a real `sk_live_*`, `whsec_*`,
> or `price_*` value. All Stripe credentials are deployed via
> `fly secrets set` (production) or `.env.local` (developer machines).

---

## 1. Plan shape

One product, one recurring price, one Customer Portal config. The pricing
model is intentionally simple to keep the per-seat-billing decision in
human hands (OWNERs decide who goes live; coaches do not self-serve plan
changes).

| Field         | Value                                       |
| ------------- | ------------------------------------------- |
| Product name  | **Coach SaaS — Flat Plan**                  |
| Description   | Per-coach platform fee, billed monthly.     |
| Tax behavior  | Inclusive (or per Stripe Tax config)        |
| Price         | **$300.00 USD / month**, recurring          |
| Billing       | Monthly, charge automatically               |
| Trial         | None at the price level (set per-coach via `start-subscription`) |
| Metadata      | `plan_tier=flat_300`                        |

The `metadata.plan_tier` value is read by `BillingService.applySubscription`
indirectly through `stripe_price_id` on `CoachSubscription` — keep it stable
across staging and production so the mirror stays portable.

---

## 2. Stripe dashboard — step by step

Repeat sections 2.1–2.5 once per environment (staging and production are
**separate Stripe accounts** — see §6 below).

### 2.1 Create the product

1. Stripe dashboard → **Catalog → Products → + Add product**.
2. Name: `Coach SaaS — Flat Plan`.
3. Description: `Per-coach platform fee, billed monthly.`
4. Pricing model: **Standard pricing**.
5. Price: `$300.00`, currency `USD`, billing period `Monthly`, recurring.
6. Save. Copy the resulting `price_...` id — this becomes
   `STRIPE_PRICE_ID_FITNESS` in the env.

> **Naming note.** The env var is `STRIPE_PRICE_ID_FITNESS` for historical
> reasons (the original Phase 2A spec anticipated a separate
> `STRIPE_PRICE_ID_FINANCE` price for a finance vertical). Today both
> verticals use the same flat $300 price; leave `STRIPE_PRICE_ID_FINANCE`
> unset until a second price is actually created.

### 2.2 Configure the webhook endpoint

1. Stripe dashboard → **Developers → Webhooks → + Add endpoint**.
2. Endpoint URL:
   - Production: `https://api.thegrowthproject.app/api/v1/webhooks/stripe`
   - Staging: `https://api-staging.thegrowthproject.app/api/v1/webhooks/stripe`
   - (Substitute your actual API host. The path is fixed:
     `/api/v1/webhooks/stripe`.)
3. API version: pin to a specific version (e.g. `2024-09-30.acacia`). Do
   **not** track `latest`; locked versions prevent silent payload-shape
   regressions.
4. Events to send — select exactly:
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.paid`
   - `invoice.payment_failed`
   - `customer.updated`
5. Save the endpoint. Copy the **Signing secret** (`whsec_...`) — this
   becomes `STRIPE_WEBHOOK_SECRET`.

> Any other event type the webhook receives is dropped through the
> `default` case in `BillingService.handleEvent` and logged. Adding more
> events is safe but unnecessary; subscribing to fewer breaks the mirror.

### 2.3 Configure the Customer Portal

The `/v1/coach/me/billing/portal-session` endpoint mints a live Stripe
Billing Portal session and requires a published Portal config. The
endpoint resolves the coach's `stripe_customer_id` from
`CoachSubscription` (or `CoachProfile` as fallback) and calls
`POST /v1/billing_portal/sessions` with `customer` and `return_url`. The
return URL comes from `STRIPE_BILLING_PORTAL_RETURN_URL` and defaults to
`https://console.thegrowthproject.app/billing`.

1. Stripe dashboard → **Settings → Billing → Customer portal**.
2. Branding: upload product logo and accent colour.
3. **Functionality**:
   - Update payment method: ✅
   - View billing history & invoices: ✅
   - Update billing/shipping address: ✅
   - Cancel subscriptions: ❌ (cancellation goes through OWNER tooling so
     we can reconcile against `CoachProfile`)
   - Switch plans: ❌ (single price today)
   - Pause subscriptions: ❌
4. **Business information**: privacy policy URL, terms of service URL,
   support email/phone.
5. Save.

### 2.4 Configure Stripe Tax (optional but recommended)

Per-coach plans are US-domestic today, so registering for Tax is optional.
If/when Tax is enabled, set `automatic_tax[enabled]=true` on subscription
creation in the Phase 2A follow-up PR.

### 2.5 Smoke-test the endpoint with the Stripe CLI

See §5. Do this **before** flipping `BILLING_ENFORCEMENT=enforce`.

---

## 3. Environment variables

Listed in `.env.example`. Production values go in `fly secrets set`.

| Var                          | Required in prod | Source / format         | Example (placeholder)     |
| ---------------------------- | ---------------- | ----------------------- | ------------------------- |
| `STRIPE_SECRET_KEY`          | Yes              | Stripe dashboard → Developers → API keys → Secret key | `sk_live_xxx` |
| `STRIPE_WEBHOOK_SECRET`      | Yes              | Endpoint signing secret | `whsec_xxx`               |
| `STRIPE_PRICE_ID_FITNESS`    | Yes              | Product price id        | `price_xxx`               |
| `STRIPE_PRICE_ID_FINANCE`    | No               | Future second vertical  | (unset)                   |
| `STRIPE_BILLING_PORTAL_RETURN_URL` | No         | URL Stripe redirects coaches back to after the portal session | `https://console.thegrowthproject.app/billing` |
| `BILLING_ENFORCEMENT`        | Yes (after rollout) | `observe` (default) or `enforce` | `enforce`        |

Behavior when unset:

- **All `STRIPE_*` unset.** `/v1/coach/me/billing` returns the empty
  mirror (`{ subscription: null, invoices: [] }`). The portal-session and
  start-subscription endpoints return `STRIPE_NOT_CONFIGURED`. The webhook
  endpoint rejects every request with `400`. Tests do not require any of
  these to be set.
- **`BILLING_ENFORCEMENT` unset or anything other than `enforce`.**
  `SubscriptionGuard` runs in observe-only mode: the lookup happens but
  every request is allowed through. This is the correct posture during
  rollout.
- **`BILLING_ENFORCEMENT=enforce`.** The guard denies inactive,
  past-due-past-grace, canceled, and paused subscriptions. Set this
  **only after** every active coach has a `CoachSubscription` row written
  by the `customer.subscription.created` webhook.

### Setting prod secrets (Fly)

```sh
fly secrets set \
  STRIPE_SECRET_KEY=sk_live_REPLACE \
  STRIPE_WEBHOOK_SECRET=whsec_REPLACE \
  STRIPE_PRICE_ID_FITNESS=price_REPLACE \
  -a growth-project-backend
# Leave BILLING_ENFORCEMENT off for the first deploy; flip it after smoke.
```

### Setting staging secrets

Use the staging Stripe account's test-mode keys (`sk_test_*`, `whsec_*`,
`price_*`). Same command, against the staging Fly app name.

---

## 4. Rollout sequence

The mirror was designed so each step is independently revertible.

1. **Deploy the code** (already on `main` via PR #53). No Stripe
   credentials configured — the routes return `STRIPE_NOT_CONFIGURED` and
   the webhook returns `400`. This is safe; nothing is gated yet.
2. **Provision Stripe products and webhook endpoint** (this doc, §2).
3. **Set staging secrets**, run §5 smoke, verify mirror rows appear in the
   staging DB.
4. **Set production secrets** (without `BILLING_ENFORCEMENT`).
5. **Onboard each existing coach** by calling
   `POST /v1/admin/coaches/:id/start-subscription` with body
   `{ "plan": "flat_300", "trialDays": 0 }` (or up to 90). The handler
   creates the Stripe Customer + Subscription, mirrors immediately into
   `CoachSubscription` and `CoachProfile`, and the
   `customer.subscription.created` webhook idempotently re-applies the
   same row.
6. **Verify** every active coach has a `CoachSubscription` row with
   `status` in `(active, trialing)`.
7. **Flip `BILLING_ENFORCEMENT=enforce`.** Re-deploy or run
   `fly secrets set BILLING_ENFORCEMENT=enforce`. The guard now blocks
   coaches without an active subscription.

---

## 5. Replay testing with the Stripe CLI

Goal: confirm the deployed webhook endpoint accepts a real Stripe-signed
delivery, the mirror tables get updated, and idempotency holds. This is
the only test that exercises the live HMAC verification path.

### 5.1 Install the CLI

```sh
brew install stripe/stripe-cli/stripe   # mac
# or download the binary: https://docs.stripe.com/stripe-cli
stripe login                            # opens browser, picks an account
```

### 5.2 Smoke-test against a deployed staging endpoint

```sh
# Forwarding mode (best for local dev): pipes events to a local server
stripe listen --forward-to localhost:3000/api/v1/webhooks/stripe
# CLI prints a temporary webhook secret — use it as STRIPE_WEBHOOK_SECRET
# while running locally. Revoke it by Ctrl-C.

# Trigger a synthetic event end-to-end through Stripe (CLI generates and
# signs the event, Stripe delivers it to your endpoint):
stripe trigger customer.subscription.created
stripe trigger customer.subscription.updated
stripe trigger customer.subscription.deleted
stripe trigger invoice.paid
stripe trigger invoice.payment_failed
stripe trigger customer.updated
```

Expected response: `200 OK` with body `{"processed": true}` (first
delivery) or `{"processed": false, "alreadyProcessed": true}` (duplicate).

### 5.3 Replay a real past event

Useful when investigating an incident.

```sh
stripe events resend evt_1Nx... \
  --webhook-endpoint we_1NxYZ...
```

The signing secret on the endpoint is unchanged, so the resent event has
the same id and our idempotency table short-circuits the duplicate
without writing again.

### 5.4 Local smoke without the Stripe CLI

For tightest-loop development (no Stripe account needed), use the
in-repo replay script:

```sh
npx ts-node scripts/stripe-webhook-smoke.ts
# or feed a custom fixture:
npx ts-node scripts/stripe-webhook-smoke.ts subscription.created
```

The script signs fixture payloads with a local `whsec_` value, posts them
to a running dev server, and asserts the response. It does **not** call
Stripe — there is no network egress and no real key required. See the
script header comment for fixture names.

---

## 6. Staging vs. production separation

- **Separate Stripe accounts.** Do not mix test-mode and live-mode keys
  on the same account-mode endpoint. Stripe rejects it, but more
  importantly the mirror rows would commingle.
- **Separate webhook secrets.** Each environment has its own
  `STRIPE_WEBHOOK_SECRET`. A signature signed by staging will not verify
  in production and vice versa — by design.
- **Separate price ids.** Even if the price is "the same $300 plan",
  Stripe assigns distinct `price_...` ids per account/mode. Set
  `STRIPE_PRICE_ID_FITNESS` per environment.
- **Separate Customer Portal configs.** The Portal config is per-account;
  no cross-environment sharing.

---

## 7. Rollback

The architecture supports per-component rollback. From safest to most
disruptive:

1. **Disable enforcement only.** `fly secrets unset BILLING_ENFORCEMENT`
   (or set to `observe`). The guard reverts to observe-only; all coach
   writes succeed regardless of subscription state. Mirror updates
   continue.
2. **Disable the webhook endpoint.** In the Stripe dashboard, set the
   endpoint to **Disabled**. New deliveries stop arriving; the mirror
   freezes at the last accepted event. No application changes needed.
3. **Disable Stripe entirely.** `fly secrets unset STRIPE_SECRET_KEY
   STRIPE_WEBHOOK_SECRET STRIPE_PRICE_ID_FITNESS`. The webhook endpoint
   returns `400`, and `start-subscription` / `portal-session` return
   `STRIPE_NOT_CONFIGURED`. Existing mirror rows remain readable; the
   coach console renders the empty billing state.
4. **Roll back the deploy.** `fly releases rollback` to a release before
   PR #53. The mirror tables remain (Prisma migrations are
   forward-compatible) but the routes disappear.

> Do **not** drop the mirror tables on rollback — they are the only
> record of which coach owns which `stripe_customer_id`, and Stripe's
> retry buffer is a few days at most. Replaying lost deliveries from
> Stripe is straightforward (`stripe events resend`); reconstructing the
> coach↔customer mapping is not.

---

## 8. Incident playbook (abbreviated)

- **Webhook deliveries failing (4xx in Stripe dashboard).** Check
  `STRIPE_WEBHOOK_SECRET` matches the endpoint's signing secret. Stripe
  rotates secrets when an endpoint is recreated.
- **Coach blocked unexpectedly.** Set `BILLING_ENFORCEMENT=observe` to
  unblock immediately; investigate the `CoachSubscription.status` for the
  coach and resend the most recent `customer.subscription.updated` event
  via the CLI.
- **Duplicate billing.** Should not happen — `Invoice.stripe_invoice_id`
  is `@unique` and `StripeProcessedEvent.stripe_event_id` is the primary
  key. Confirm by `SELECT count(*), stripe_invoice_id FROM "Invoice"
  GROUP BY 2 HAVING count(*) > 1`. If duplicates exist, file an incident
  — the schema makes this a hard error.

---

## 9. References

- Stripe webhook signing: <https://docs.stripe.com/webhooks#verify-manually>
- Stripe CLI: <https://docs.stripe.com/stripe-cli>
- Customer Portal config: <https://docs.stripe.com/customer-management>
- Companion code: `src/billing/`, `prisma/schema.prisma` (mirror models),
  `test/stripe-webhook.spec.ts`, `test/subscription.guard.spec.ts`.
