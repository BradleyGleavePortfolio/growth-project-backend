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

The `/v1/coach/me/billing/portal-session` endpoint requires a configured
Portal. The endpoint has two paths:

- **Per-coach SDK session** (preferred). When `STRIPE_SECRET_KEY` is set,
  the endpoint resolves the coach's `stripe_customer_id` from
  `CoachSubscription` (or `CoachProfile` as fallback) and calls
  `POST /v1/billing_portal/sessions` with `customer` and `return_url`,
  taking each coach straight into their own account with no extra auth.
  The return URL comes from `STRIPE_BILLING_PORTAL_RETURN_URL` and
  defaults to `https://console.thegrowthproject.app/billing`. Returns
  `{ url }`.
- **Hosted login-link fallback**. When `STRIPE_SECRET_KEY` is unset but
  `STRIPE_CUSTOMER_PORTAL_LOGIN_URL` is set, the endpoint returns the
  hosted Customer Portal login link with `fallback: true`. The coach
  authenticates by entering the email Stripe has on file. Useful for
  environments without server-side Stripe credentials, and as a break-glass
  while the SDK path is rolled out. When neither is set the endpoint
  returns `STRIPE_NOT_CONFIGURED` and the console renders the empty state.

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
5. **Login link**: enable the hosted login page. Copy the resulting URL
   (shape `https://billing.stripe.com/p/login/<token>`) — this becomes
   `STRIPE_CUSTOMER_PORTAL_LOGIN_URL`. The current production link is
   `https://billing.stripe.com/p/login/28EbJ1bSi0VVf9keaG4Ni00`; treat
   this as the source of truth for the prod value and never paste it
   into a non-prod environment. Login links are not secrets (they are
   safe to share with end users) but environment separation still
   matters — staging coaches must not be sent to a prod portal.
6. Save.

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
| `STRIPE_CUSTOMER_PORTAL_LOGIN_URL` | No (recommended) | Stripe dashboard → Settings → Billing → Customer portal → Login link | `https://billing.stripe.com/p/login/...` |
| `BILLING_ENFORCEMENT`        | Yes (after rollout) | `observe` (default) or `enforce` | `enforce`        |

Behavior when unset:

- **All `STRIPE_*` unset.** `/v1/coach/me/billing` returns the empty
  mirror (`{ subscription: null, invoices: [] }`). The portal-session and
  start-subscription endpoints return `STRIPE_NOT_CONFIGURED`. The webhook
  endpoint rejects every request with `400`. Tests do not require any of
  these to be set.
- **`STRIPE_CUSTOMER_PORTAL_LOGIN_URL` set, `STRIPE_SECRET_KEY` unset.**
  `/v1/coach/me/billing/portal-session` returns
  `{ url, fallback: true, coachId }` pointing at the hosted Customer
  Portal login page. The coach authenticates with the email Stripe has on
  file. The webhook and start-subscription endpoints still report
  `STRIPE_NOT_CONFIGURED` — only the portal-session path uses this var.
- **Both `STRIPE_SECRET_KEY` and `STRIPE_CUSTOMER_PORTAL_LOGIN_URL` set.**
  The per-coach SDK session takes precedence (returns `fallback: false`).
  The login URL is unused but keeping it set is fine and gives operators
  a documented break-glass if the SDK path ever needs to be disabled.
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

## 6. Webhook secret rotation (zero-downtime)

`STRIPE_WEBHOOK_SECRET` can be rotated without an in-flight delivery
gap. The webhook controller accepts a signature that verifies against
EITHER `STRIPE_WEBHOOK_SECRET` (steady state) or
`STRIPE_WEBHOOK_SECRET_NEXT` (rotation window). Procedure:

1. Stripe dashboard → Developers → Webhooks → endpoint → "Roll signing
   secret". Stripe issues a new `whsec_...` and keeps the old one valid
   for a configurable window (default 24 h).
2. `fly secrets set STRIPE_WEBHOOK_SECRET_NEXT=whsec_NEW -a growth-project-backend`.
   The current secret stays put. Both are now configured.
3. Deploy / wait for restart. Confirm new deliveries verify under
   either secret (Stripe will sign with the new one immediately; the
   controller tries both transparently).
4. In Stripe dashboard, flip the endpoint to the new secret only (this
   is automatic once Stripe completes the rotation window).
5. `fly secrets set STRIPE_WEBHOOK_SECRET=whsec_NEW STRIPE_WEBHOOK_SECRET_NEXT='' -a growth-project-backend`.
   This promotes the new value to the steady-state slot and clears the
   rotation slot. Confirm the next delivery verifies, then close the
   change ticket.

If a rotation needs to be aborted mid-way, simply unset
`STRIPE_WEBHOOK_SECRET_NEXT` and the system reverts to the pre-rotation
state.

---

## 6.5. Team-mode tier prices (ADR-0001 §10)

The flat `$300` plan above is the legacy single-tier SKU. Team Mode adds three
canonical tiers consumed by `TeamModeTierResolverService` for the per-coach
tier gate and the staff-seat billing posture:

| Tier         | Public price (from /llms.txt) | Env var                    |
| ------------ | ----------------------------- | -------------------------- |
| Growth       | $1,079 / month                | `STRIPE_PRICE_GROWTH`      |
| Pro          | $2,499 / month                | `STRIPE_PRICE_PRO`         |
| Enterprise   | $6,225 / month                | `STRIPE_PRICE_ENTERPRISE`  |

Provision each tier as a separate Stripe Product (or as three prices on a
shared product) and copy the resulting `price_...` ids into Fly secrets.
The resolver maps `CoachSubscription.stripe_price_id` to one of
`growth | pro | enterprise | unknown`. An unmatched id falls through to
`unknown`, which the team-mode controllers treat as "deny by default".

**Smoke check before flipping enforcement:** `test/team-mode-tier-resolver.spec.ts`
contains a `configuredTiers()` round-trip that catches three common
misconfigurations: blank env, duplicate price id pasted into two tiers,
and resolver / mapping drift. Run the suite as part of the deploy
pipeline; do not flip `BILLING_ENFORCEMENT=enforce` until it passes
against the prod-equivalent env.

`STRIPE_PRICE_STAFF_SEAT` is the recurring subscription-item price the
Pro tier uses to bill per assigned sub-coach (quantity=1 per seat).
Enterprise has staff seats bundled into the base price, so this price
is not used for Enterprise tenants.

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
