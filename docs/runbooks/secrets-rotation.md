# Secrets Rotation Runbook

**Who this is for:** Bradley (and any operator who manages The Growth Project backend).

**Plain-English summary:** This document tells you how to rotate (change) every secret the app uses, step by step. A "secret" is a password, API key, or signing key that the backend needs to work. Rotating a secret means generating a new one, putting it in the right place, and making sure the old one stops working. All of this happens with zero downtime — users will not notice.

**Time required per secret:** 5–15 minutes of commands + up to 24 hours of waiting for JWT keys.

---

## Before you start

You need:
- `flyctl` installed and logged in: `fly auth login`
- Access to the Fly app `backend-spring-lake-3890`
- Your admin JWT token (from logging into the app as an owner)
- Access to each provider's dashboard (Stripe, Supabase, Sentry, etc.)

If you do not have `flyctl`, install it: https://fly.io/docs/hands-on/install-flyctl/

---

## How to set a secret in Fly

Every secret in this playbook is set the same way:

```sh
flyctl secrets set SECRET_NAME="the-new-value" -a backend-spring-lake-3890
```

Fly redeploys the app automatically after you set secrets. You do not need to do anything else to make the new secret active.

To see which secrets are currently set (names only, not values):

```sh
flyctl secrets list -a backend-spring-lake-3890
```

---

## How to record a rotation in the audit log

After every rotation, record it so the `/admin/secrets/status` endpoint stays up to date:

```sh
curl -X POST https://api.trygrowthproject.com/api/admin/secrets/SECRET_NAME/rotation-log \
  -H "Authorization: Bearer YOUR_ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"notes": "Reason for this rotation"}'
```

Replace `SECRET_NAME` with the exact name (e.g. `JWT_SIGNING_KEY`).

---

## Secret-by-secret playbook

---

### JWT_SIGNING_KEY

| Field | Details |
|---|---|
| **Purpose** | Signs internal JWT tokens. If someone gets this key, they can forge any user's identity. |
| **Cadence** | Every 90 days |
| **Tier** | Critical — rotate immediately if exposed |
| **Who knows it** | Bradley only (stored in Fly secrets) |

**How to generate a new key:**

```sh
openssl rand -hex 32
```

This prints a 64-character hex string. That is your new key.

**Zero-downtime rotation (takes 24 hours):**

The app supports dual-key rotation — it accepts tokens signed with EITHER the current key OR the previous key for a 24-hour window. This means no one gets logged out.

```sh
# Step 1: Set new key + move old key to "previous" (do both in one command)
flyctl secrets set \
  JWT_SIGNING_KEY="<new-key-from-openssl>" \
  JWT_SIGNING_KEY_PREVIOUS="<your-current-key>" \
  -a backend-spring-lake-3890
```

```sh
# Step 2: Wait 24 hours. New tokens are being signed with the new key.
#         Old tokens (signed with the old key) are still accepted.
```

```sh
# Step 3: After 24 hours, retire the old key
flyctl secrets unset JWT_SIGNING_KEY_PREVIOUS -a backend-spring-lake-3890
```

**Or, use the helper script:**

```sh
npx ts-node scripts/secrets/rotate-jwt.ts
```

This generates the key and prints every command for you, step by step.

**Verify:**

```sh
# Should show JWT_SIGNING_KEY set, JWT_SIGNING_KEY_PREVIOUS absent
flyctl secrets list -a backend-spring-lake-3890 | grep JWT
```

**What breaks if it's wrong:** Every user gets logged out immediately (all JWTs fail verification). The fix is to set the correct key and redeploy.

**Rollback:** Re-set the old value: `flyctl secrets set JWT_SIGNING_KEY="<old-value>" -a backend-spring-lake-3890`

---

### JWT_SIGNING_KEY_PREVIOUS

| Field | Details |
|---|---|
| **Purpose** | Temporary second JWT key, active only during a 24h rotation window. |
| **Cadence** | Set/unset during every JWT_SIGNING_KEY rotation — not independently rotated. |
| **Tier** | Critical |
| **Who knows it** | Bradley only |

This secret is set as part of JWT_SIGNING_KEY rotation (see above) and cleared 24h later. You should never have both `JWT_SIGNING_KEY` and `JWT_SIGNING_KEY_PREVIOUS` set for longer than 24h.

---

### DATABASE_URL

| Field | Details |
|---|---|
| **Purpose** | Postgres connection string. The app cannot read or write any data without it. |
| **Cadence** | Every 180 days, or immediately if exposed |
| **Tier** | Critical — if exposed, all user data is at risk |
| **Who knows it** | Bradley + anyone with Supabase dashboard access |

**How to rotate:**

Supabase lets you reset the database password in Settings → Database → Reset database password.

1. Go to Supabase dashboard → your project → Settings → Database
2. Click "Reset database password"
3. Copy the new connection string (use the "Session pooler" URL)
4. Set it in Fly:

```sh
flyctl secrets set DATABASE_URL="postgresql://postgres.xxx:NEW_PASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres" \
  -a backend-spring-lake-3890
```

**What breaks if it's wrong:** The app crashes on boot with a Prisma connection error. All API calls fail with 500.

**Rollback:** Re-set the previous connection string while you investigate.

**Important:** DATABASE_URL contains your Postgres password. Never paste it into Slack, email, or a GitHub issue.

---

### SUPABASE_SERVICE_ROLE_KEY

| Field | Details |
|---|---|
| **Purpose** | Supabase admin key that bypasses Row-Level Security. Used for server-side user management. |
| **Cadence** | Every 90 days, or immediately if exposed |
| **Tier** | Critical — bypass of all database security rules |
| **Who knows it** | Bradley only |

**How to rotate:**

Supabase does not support rotating the service-role key without generating a new one and disabling the old one.

1. Go to Supabase dashboard → your project → Settings → API
2. Click "Roll" next to the service_role key
3. Copy the new key
4. Set it in Fly immediately:

```sh
flyctl secrets set SUPABASE_SERVICE_ROLE_KEY="eyJhbGci..." -a backend-spring-lake-3890
```

**What breaks if it's wrong:** Any endpoint that calls Supabase Admin API (user creation, user deletion, auth admin) returns 500. Normal user-facing auth (JWT verification via JWKS) is unaffected.

**Rollback:** Set the old key back while you investigate.

---

### STRIPE_SECRET_KEY

| Field | Details |
|---|---|
| **Purpose** | Stripe API key for processing payments and subscriptions. |
| **Cadence** | Every 180 days, or immediately if exposed |
| **Tier** | Critical — can initiate refunds, create charges, read payment data |
| **Who knows it** | Bradley only |

**How to rotate:**

1. Go to Stripe dashboard → Developers → API keys
2. Click "Roll key" on the Secret key. Stripe lets you set a transition period (hours/days) during which both the old and new key work.
3. Copy the new key (starts with `sk_live_`)
4. Set it in Fly:

```sh
flyctl secrets set STRIPE_SECRET_KEY="sk_live_new..." -a backend-spring-lake-3890
```

5. After the transition period ends, the old key is automatically disabled.

**What breaks if it's wrong:** All Stripe calls fail. Billing endpoints return 500.

**Rollback:** Stripe's "roll key" feature keeps the old key active for the transition period — you can set the old key back in Fly if needed.

---

### STRIPE_WEBHOOK_SECRET

| Field | Details |
|---|---|
| **Purpose** | Validates that webhook events from Stripe are genuine. Prevents fake payment events. |
| **Cadence** | Every 180 days, or if the webhook endpoint is recreated |
| **Tier** | High |
| **Who knows it** | Bradley only |

**How to rotate:**

1. Go to Stripe dashboard → Developers → Webhooks
2. Click on your webhook endpoint
3. Click "Roll signing secret"
4. Copy the new secret (starts with `whsec_`)
5. Set it in Fly:

```sh
flyctl secrets set STRIPE_WEBHOOK_SECRET="whsec_new..." -a backend-spring-lake-3890
```

**What breaks if it's wrong:** Stripe webhook events (subscription changes, payment completions) are rejected with 400. Billing state stops updating.

---

### SENTRY_DSN

| Field | Details |
|---|---|
| **Purpose** | Sentry project identifier for error reporting. Not a secret in the traditional sense but rotating it is good practice. |
| **Cadence** | Every 365 days |
| **Tier** | Standard |
| **Who knows it** | Bradley + anyone with Sentry dashboard access |

**How to rotate:**

1. Go to Sentry dashboard → your project → Settings → Client Keys (DSN)
2. Generate a new DSN (or revoke the current one and get the new value)
3. Set it in Fly:

```sh
flyctl secrets set SENTRY_DSN="https://xxx@yyy.ingest.sentry.io/zzz" -a backend-spring-lake-3890
```

**What breaks if it's wrong:** Errors stop being reported to Sentry. The app continues to work normally.

---

### FLY_API_TOKEN

| Field | Details |
|---|---|
| **Purpose** | Allows GitHub Actions to deploy to Fly automatically on every `main` merge. |
| **Cadence** | Every 90 days |
| **Tier** | High — can deploy arbitrary code to production |
| **Who knows it** | Bradley (stored as a GitHub Actions secret, not a Fly secret) |

**How to rotate:**

1. Generate a new deploy token:

```sh
fly tokens create deploy -a backend-spring-lake-3890
```

2. Copy the token (starts with `fo1_`)
3. Go to GitHub → BradleyGleavePortfolio/growth-project-backend → Settings → Secrets and variables → Actions
4. Find `FLY_API_TOKEN` and click "Update"
5. Paste the new token
6. Save

**What breaks if it's wrong:** Deployments stop working. Every `main` push shows a red CI failure on the "Fly Deploy" workflow. The app itself keeps running — it just won't get updates.

**Rollback:** Generate another token and update the GitHub secret again.

---

### PERPLEXITY_API_KEY

| Field | Details |
|---|---|
| **Purpose** | Perplexity AI API key used for the AI chat feature. |
| **Cadence** | Every 180 days |
| **Tier** | Standard |
| **Who knows it** | Bradley only |

**How to rotate:**

1. Go to Perplexity API settings → API keys
2. Generate a new key
3. Set it in Fly:

```sh
flyctl secrets set PERPLEXITY_API_KEY="pplx-..." -a backend-spring-lake-3890
```

**What breaks if it's wrong:** AI chat falls back to a deterministic responder. No crashes.

---

### FINANCE_SERVICE_TOKEN

| Field | Details |
|---|---|
| **Purpose** | Bearer token for service-to-service calls between the fitness and finance backends. Must be identical on both backends. |
| **Cadence** | Every 90 days |
| **Tier** | Critical |
| **Who knows it** | Bradley only (must be set on both backends simultaneously) |

**How to rotate:**

1. Generate a new shared token:

```sh
openssl rand -hex 32
```

2. Set it on BOTH backends at the same time:

```sh
# Fitness backend
flyctl secrets set FINANCE_SERVICE_TOKEN="<new-token>" -a backend-spring-lake-3890

# Finance backend (replace with your finance app name)
flyctl secrets set FINANCE_SERVICE_TOKEN="<new-token>" -a backend-finance-app-name
```

**What breaks if it's wrong:** The `/admin/federation/*` endpoints return 503. The fitness and finance backends cannot communicate.

---

## Viewing current rotation status

```sh
# Check all secrets — which are stale, when they were last rotated
curl -s https://api.trygrowthproject.com/api/admin/secrets/status \
  -H "Authorization: Bearer YOUR_ADMIN_JWT" | jq .
```

Or run the staleness check script:

```sh
DATABASE_URL="$DATABASE_URL" npx ts-node scripts/secrets/check-staleness.ts
```

---

## Quick reference: flyctl commands

```sh
# List all secrets (names only, not values)
flyctl secrets list -a backend-spring-lake-3890

# Set a secret
flyctl secrets set SECRET_NAME="value" -a backend-spring-lake-3890

# Remove a secret
flyctl secrets unset SECRET_NAME -a backend-spring-lake-3890

# Set multiple secrets at once (one Fly deploy)
flyctl secrets set KEY1="val1" KEY2="val2" -a backend-spring-lake-3890
```

---

## After any rotation

1. Set the secret in Fly (commands above)
2. Wait for Fly to redeploy (~2 minutes)
3. Check the app is healthy: `curl https://api.trygrowthproject.com/api/health`
4. Record the rotation: `POST /admin/secrets/:name/rotation-log`

---

*This runbook was generated as part of Phase 10 (Secrets Rotation) of The Growth Project backend. Last updated: 2026-05-08.*
