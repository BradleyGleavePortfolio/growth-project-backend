# src/secrets — Secrets Rotation Module

## Purpose

This module gives operators a way to track when secrets were last rotated and whether any are overdue. It provides:

1. **An admin API endpoint** — `GET /admin/secrets/status` returns the full secret inventory with rotation metadata (dates, staleness, tier). Secret values are never returned.
2. **A rotation log** — every time you rotate a secret, you record it via `POST /admin/secrets/:name/rotation-log`. This is how the status endpoint knows when things were last changed.
3. **A service** — `SecretsService` contains the canonical `SECRET_INVENTORY` list. This is the single source of truth for what secrets the app uses.

This module is `~30%` of the Phase 10 Secrets Rotation track. The other `~70%` is documentation and helper scripts (see `docs/runbooks/` and `scripts/secrets/`).

---

## Endpoints

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| `GET` | `/admin/secrets/status` | OWNER role | — | Summary + per-secret status (no values) |
| `POST` | `/admin/secrets/:name/rotation-log` | OWNER role | `{ notes?: string }` | `{ id, secretName, rotatedAt }` |

### GET /admin/secrets/status

Returns which secrets are tracked, when they were last rotated, and whether they are stale (overdue for rotation based on the configured cadence). Never returns secret values.

Example response:

```json
{
  "summary": {
    "totalTracked": 13,
    "staleCount": 2,
    "neverRotatedCount": 5,
    "healthyCount": 11
  },
  "secrets": [
    {
      "name": "JWT_SIGNING_KEY",
      "description": "HMAC-SHA256 key used to sign internal JWT tokens...",
      "cadenceDays": 90,
      "tier": "critical",
      "lastRotatedAt": "2026-02-08T00:00:00.000Z",
      "rotatedByUserId": "abc-123",
      "notes": "Routine 90-day rotation",
      "isStale": false,
      "daysSinceRotation": 89
    }
  ]
}
```

### POST /admin/secrets/:name/rotation-log

Call this AFTER you have rotated the secret in Fly (via `flyctl secrets set`). This endpoint does not rotate anything — it only records that you did.

```sh
curl -X POST https://api.trygrowthproject.com/api/admin/secrets/JWT_SIGNING_KEY/rotation-log \
  -H "Authorization: Bearer YOUR_ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"notes": "Routine 90-day rotation"}'
```

---

## Prisma models touched

| Model | Table | Fields |
|---|---|---|
| `SecretRotationLog` | `secret_rotation_log` | `id`, `secret_name`, `rotated_at`, `rotated_by_user_id`, `notes` |

---

## Environment variables

This module adds two env vars for JWT dual-key rotation support:

| Variable | Tier | Default | Purpose |
|---|---|---|---|
| `JWT_SIGNING_KEY` | feature | — | Current HMAC-SHA256 JWT signing key. New tokens are signed with this key. |
| `JWT_SIGNING_KEY_PREVIOUS` | feature | — | Previous signing key. Set during a 24h rotation window. Clear after 24h. |

See `src/auth/README.md` for full JWT dual-key rotation documentation.

---

## Secret inventory

The `SECRET_INVENTORY` constant in `secrets.service.ts` is the canonical list of all secrets the app reads, with rotation cadence, tier, and description. Currently tracks 13 secrets:

| Secret | Cadence | Tier |
|---|---|---|
| `JWT_SIGNING_KEY` | 90d | critical |
| `JWT_SIGNING_KEY_PREVIOUS` | 90d | critical |
| `DATABASE_URL` | 180d | critical |
| `SUPABASE_SERVICE_ROLE_KEY` | 90d | critical |
| `STRIPE_SECRET_KEY` | 180d | critical |
| `STRIPE_WEBHOOK_SECRET` | 180d | high |
| `SENTRY_DSN` | 365d | standard |
| `FLY_API_TOKEN` | 90d | high |
| `PERPLEXITY_API_KEY` | 180d | standard |
| `POSTHOG_KEY` | 365d | standard |
| `USDA_API_KEY` | 365d | standard |
| `REDIS_URL` | 180d | high |
| `FINANCE_SERVICE_TOKEN` | 90d | critical |

---

## Test coverage

| File | What it asserts |
|---|---|
| `test/secrets/secrets-dual-key.spec.ts` | Old JWT key still works during transition; new key works; after clearing previous key, old key fails |
| `test/secrets/check-staleness.spec.ts` | Staleness check script outputs warnings for overdue secrets and exits 1 |

---

## Helper scripts

| Script | Purpose |
|---|---|
| `scripts/secrets/list.ts` | Scans source code for `process.env.X` references, compares against inventory |
| `scripts/secrets/rotate-jwt.ts` | Generates a new JWT signing key and prints step-by-step flyctl commands |
| `scripts/secrets/check-staleness.ts` | Queries the rotation log and reports overdue secrets |

---

## Security invariants

- Secret values are **never** accepted by any endpoint in this module
- Secret values are **never** stored in the `secret_rotation_log` table
- All log entries contain only: secret name, timestamp, user ID (who recorded it), and optional notes
- The `notes` field has a 500-character limit to prevent accidental secret paste
- All error messages go through `redactSecrets()` from `src/common/redact-secrets.ts`
- All routes are OWNER-only — a coach or student hitting these endpoints gets a 403

---

## Future work

- Automated staleness alerts: a cron job could run `check-staleness.ts` and send a notification (email or Slack) when a secret crosses the cadence threshold.
- Fly API integration: with a `FLY_API_TOKEN` (already tracked), the `list.ts` script could call the Fly secrets API to verify which secrets are actually set, not just which ones the code references.
