# Stripe Connect setup — Phase 1

This is the operator-facing setup guide for Phase 1 of the Connect master
plan (`/CONNECT_MASTER_PLAN.md`). Phase 1 ships:

- `ConnectAccount` Prisma model (1 row per coach).
- `POST /api/v1/connect/accounts/create` — idempotent Express account
  creation.
- `POST /api/v1/connect/accounts/onboarding-link` — one-time
  Stripe-hosted onboarding URL.
- `POST /api/v1/connect/accounts/dashboard-link` — Express Dashboard
  login URL (only after `charges_enabled=true`).
- `GET /api/v1/connect/accounts/me` — current Connect status for the
  signed-in coach.
- Stripe webhook handlers for `account.updated`, `capability.updated`,
  `account.application.deauthorized`.

The backend will refuse to register the routes (every endpoint returns
503) until the Stripe Connect platform itself is enabled. This is the
"real or flagged, never fake" gate — no mocked Connect state is ever
returned.

## Owner-only Stripe Dashboard steps

> Order matters: do these in sequence. Steps 1–5 enable Connect; steps
> 6–8 polish the coach-facing experience.

### 1. Enable Connect on the platform Stripe account

1. Sign in to https://dashboard.stripe.com and switch to the TGP
   platform account.
2. Visit https://dashboard.stripe.com/connect/overview.
3. Click **Get started**.
4. Choose **Platform or marketplace**.

> [screenshot placeholder] dashboard-connect-overview.png

### 2. Complete the platform profile

- Business name: `The Growth Project, LLC`
- Industry: `Health & Fitness`
- Description: `Personal training and coaching marketplace`
- Estimated transaction volume: leave defaults; Stripe re-asks at the
  100-tx milestone.

> [screenshot placeholder] platform-profile.png

### 3. Branding (Connect → Settings → Branding)

Coaches see this branding inside the Stripe Express onboarding webview.

- Upload the TGP logo (square, ≥ 128×128 px, transparent background).
- Set primary brand color to the TGP teal (hex value lives in
  `docs/brand.md`).
- Optionally upload an icon for the Express Dashboard tab.

> [screenshot placeholder] branding.png

### 4. Express accounts (Connect → Settings → Express)

- Toggle **Allow Express accounts** on.
- Default country: `US` (Phase 1 scope is US-only; international is a
  v2 item).
- Default currency: `USD`.
- Disable Standard if the toggle is on by default — Phase 1 uses
  Express exclusively.

> [screenshot placeholder] express-toggle.png

### 5. Confirm API version

Stripe Dashboard → **Developers → API version**.

Confirm the dashboard API version matches the version pinned in
`src/billing/stripe-api.service.ts` (currently
`STRIPE_API_VERSION = '2024-09-30.acacia'`). If they differ, leave the
dashboard pinned to the backend's version — moving the dashboard alone
will not break anything (webhooks carry the version we requested), but
operators reading the dashboard will see slightly different payload
shapes.

### 6. Webhook endpoint — add Connect events

The backend already exposes a single Stripe webhook endpoint at
`POST /api/v1/webhooks/stripe` with HMAC signature verification and
dual-secret support (see `docs/stripe-setup.md` §6).

Phase 1 adds three event types. In Stripe Dashboard →
**Developers → Webhooks → [the TGP endpoint] → Add events**, subscribe
to:

- `account.updated`
- `capability.updated`
- `account.application.deauthorized`

> Test mode and live mode webhooks both route through the same backend
> endpoint. Both modes process identically — `livemode` is intentionally
> not branched on.

### 7. Set the Fly secrets

```bash
fly secrets set \
  STRIPE_CONNECT_REFRESH_URL=growthproject://connect/onboarding/refresh \
  STRIPE_CONNECT_RETURN_URL=growthproject://connect/onboarding/return
```

(Use `https://` URLs in dev if you're hitting the backend from a
browser; the Stripe-hosted onboarding webview accepts any absolute URL.)

### 8. Redeploy and verify

```bash
fly deploy --build-arg GIT_SHA=$(git rev-parse HEAD)
```

Expected boot log line:

```
[ConnectModule] Stripe Connect platform check passed — routes enabled.
```

If the platform probe fails, the log instead contains:

```
[ConnectModule] Connect routes disabled: Stripe Connect platform not enabled —
  visit https://dashboard.stripe.com/connect/overview and click "Get started".
```

## End-to-end smoke (Bradley, in staging)

1. Create a test coach in staging (via the existing OWNER onboarding
   surface).
2. From the coach session, `POST /api/v1/connect/accounts/create`.
   Expect a 200 with `stripe_account_id` and `is_fully_onboarded: false`.
3. `POST /api/v1/connect/accounts/onboarding-link`. Open the returned
   `url` in a mobile browser (or `xdg-open` from terminal).
4. Complete Stripe's Express onboarding with test data (use SSN `000-00-0000`
   and bank routing `110000000` / account `000123456789`).
5. Land back on the `return_url` — the mobile app deep-link handles it.
6. `GET /api/v1/connect/accounts/me` — expect `charges_enabled: true`,
   `payouts_enabled: true`, `is_fully_onboarded: true`.
7. `POST /api/v1/connect/accounts/dashboard-link` — open the URL,
   confirm the Express Dashboard renders.

## What is NOT yet built (out of Phase 1 scope)

- Coach packages (Phase 2).
- Client checkout with `application_fee_percent` (Phase 3).
- Payouts UI (Phase 6).
- Admin Connect surface on `tgp-platform-site/admin` (Phase 7-8).

If any of those are needed sooner, escalate to the owner — Phase 1 is
just the foundation.
