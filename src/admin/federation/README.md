# admin/federation

OWNER-only cross-product federation surface. The endpoints in this module
back the Healthie/EHR-style admin console: a single screen where an
operator can search across both the fitness backend (this repo) and the
finance backend (`tgp-finance-app`) and inspect a client's or coach's
product-usage split without flipping between two consoles.

This module also contains the **inbound** federation endpoint that the
finance backend calls to push PTM signals into the fitness pipeline.

## Purpose

- One unified search bar that returns hits from both products with an
  explicit `products` array (`["fitness"]`, `["finance"]`, or both).
- One client-detail view that pulls the fitness Postgres row alongside
  the finance backend's record for the same email, with a coarse 7d
  activity block per product so the console can render usage without a
  follow-up call.
- One coach-detail view that does the same for coaches: roster size and
  subscription state from both products side by side.
- One **inbound** endpoint that accepts finance-backend PTM signals,
  verifies the service-token, resolves the fitness user, and dispatches
  to `PtmService` — fire-and-forget.

The outbound console endpoints are OWNER-only. The inbound PTM-signal
endpoint is service-token gated (see Auth below).

## Endpoints

All paths are mounted under the existing `/api/admin` prefix.

### Outbound (OWNER-only)

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/api/admin/federation/search?q=&limit=` | Unified search across fitness Postgres and finance backend. `limit` clamped to 1..50. |
| `GET` | `/api/admin/federation/clients/lookup?email=` | One-client view. Returns fitness block + finance block + product split. |
| `GET` | `/api/admin/federation/coaches/lookup?email=` | One-coach view. Roster + subscription from each product side by side. |

### Inbound (service-token gated)

| Method | Path | Behavior |
|---|---|---|
| `POST` | `/api/admin/federation/ptm-signal` | Receive a PTM signal from the finance backend. Auth: `Authorization: Bearer <FINANCE_SERVICE_TOKEN>` + `X-Federation-Source: finance-backend`. |

The inbound endpoint is marked `@Public()` so `JwtAuthGuard` (the Supabase
JWT check) is bypassed. Auth is entirely the service-token check inside
`FederationInboundService`. An unset `FINANCE_SERVICE_TOKEN` causes the
endpoint to return 503 `FEDERATION_DISABLED` — fail-closed.

## Inbound endpoint contract

### Request

```http
POST /api/admin/federation/ptm-signal
Authorization: Bearer <FINANCE_SERVICE_TOKEN>
X-Federation-Source: finance-backend
Content-Type: application/json

{
  "user_id": "fitness-uuid-optional",
  "email": "user@example.com",
  "signal_type": "finance_eod",
  "value": 1,
  "metadata": { "milestone_type": "net_worth_100k" },
  "recorded_at": "2025-01-15T10:00:00Z"
}
```

Fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `user_id` | string | one of `user_id` / `email` | Fitness-backend UUID. Preferred — avoids the email join. |
| `email` | string | one of `user_id` / `email` | Matched case-insensitively. |
| `signal_type` | `'finance_eod' \| 'finance_milestone'` | yes | Only finance-owned signal types are accepted. Others → 400. |
| `value` | number | no | Defaults to `1`. |
| `metadata` | object | no | PII-free. Merged with `{ source: 'finance_federation' }`. |
| `recorded_at` | ISO-8601 string | no | When provided, signal is timestamped at this time rather than `now()`. |

### Response

```json
{ "ok": true }
```

### Error codes

| Status | Code | Cause |
|---|---|---|
| 503 | `FEDERATION_DISABLED` | `FINANCE_SERVICE_TOKEN` is unset. |
| 401 | `FEDERATION_UNAUTHENTICATED` | Bearer token missing or wrong. |
| 403 | `FEDERATION_SOURCE_MISMATCH` | `X-Federation-Source` is not `finance-backend`. |
| 400 | `SIGNAL_TYPE_NOT_ACCEPTED` | `signal_type` is not `finance_eod` or `finance_milestone`. |
| 400 | `MISSING_IDENTITY` | Neither `user_id` nor `email` was provided. |
| 404 | `USER_NOT_FOUND` | No active fitness user matches the provided identity. |
| 400 | _(class-validator)_ | Body shape invalid (wrong type, missing required field, etc.). |

## Outbound response shape

Every outbound response carries a `finance.status` field with one of:

- `ok` — finance returned 2xx and parseable JSON
- `not_found` — finance returned 404 (no record for the email)
- `not_configured` — `FINANCE_API_BASE_URL` is unset
- `auth_unconfigured` — `FINANCE_SERVICE_TOKEN` is unset
- `timeout` — outbound call exceeded the per-call timeout (default 2500 ms)
- `network_error` — DNS / connect / mid-flight failure
- `http_error` — finance returned a non-2xx, non-404 status (5xx, 4xx)
- `malformed_response` — finance returned a 2xx but body was non-JSON

`finance.data` is `null` for every status except `ok`. The console
renders a degraded-state pill from `finance.status`; the federation layer
never substitutes fake data when finance is unavailable.

## Identity join key

The initial release joins fitness and finance records on lower-cased
email. This is a documented limitation:

- Two products owned by the same person but registered under different
  emails will appear as two records.
- The wire format already carries an optional `account_id` field on the
  finance side. When the finance backend exposes a durable shared id,
  switch the join in `FederationService.unifiedClient` /
  `unifiedCoach` to prefer `account_id`, falling back to email only when
  the durable id is missing.
- The inbound endpoint accepts an optional `user_id` (fitness UUID)
  to sidestep this limitation when the finance backend knows the fitness
  user's ID directly.

## Environment variables

Three variables, all optional everywhere. Federation degrades cleanly
when any are missing — `FINANCE_API_BASE_URL` unset is the canonical
"finance not configured yet" state and the console renders accordingly.

| Name | Tier | Reason |
|---|---|---|
| `FINANCE_API_BASE_URL` | optional | Base URL of the finance backend, e.g. `https://api.finance.thegrowthproject.app`. Validated as absolute http(s). Used for outbound calls only. |
| `FINANCE_SERVICE_TOKEN` | optional | Service-to-service bearer token. Used in both directions: this backend sends it on outbound calls AND expects to receive it on the inbound PTM-signal endpoint. Must be set on both backends with the same value. Inbound endpoint returns 503 when unset. |
| `FINANCE_FEDERATION_TIMEOUT_MS` | optional | Per-outbound-call timeout in ms. Defaults to 2500; clamp range is 250..15000. Does not affect the inbound endpoint. |

## Service auth strategy

**Outbound (fitness → finance):** `FinanceAdminClient` sends a static
bearer token plus an `X-Federation-Source: fitness-backend` header on
every call. The finance backend's admin federation endpoints verify both.

**Inbound (finance → fitness):** `FederationInboundService` expects a
bearer token equal to `FINANCE_SERVICE_TOKEN` and an
`X-Federation-Source: finance-backend` header. Both must match. The
endpoint is fail-closed — a missing or wrong token is a hard rejection,
not a degraded state.

## Failure modes and console behavior

| Outcome | Console renders | Notes |
|---|---|---|
| `ok` | Full unified view | Both blocks present; product pills lit. |
| `not_found` (finance only) | Fitness block + "no finance account" pill | Common case when a coach hasn't enrolled in the finance product. |
| `not_configured` | Fitness block + "finance not configured" pill | Set `FINANCE_API_BASE_URL` to enable. |
| `auth_unconfigured` | Fitness block + "finance auth missing" pill | Set `FINANCE_SERVICE_TOKEN`. |
| `timeout` / `network_error` / `http_error` | Fitness block + "finance temporarily unavailable, retry" | Federation already retried once; the second failure is shown. |
| `malformed_response` | Fitness block + "finance returned an unparseable response" | Implies a finance-side bug; route to the finance team. |

## Tests

| File | Covers |
|---|---|
| `test/finance-admin.client.spec.ts` | Header shaping, retry on 5xx + timeout, 404 mapping, malformed body, env-driven configuration, timeout clamping. |
| `test/federation.service.spec.ts` | Unified search merge by email, finance degraded does not block fitness, client/coach product split derivation, archived users, empty-email short-circuit. |
| `test/federation-inbound.spec.ts` | Token gating (503/401/403), source-header check (403), unknown signal type (400), missing identity (400), user not found (404/404), happy path with user_id, happy path with email lookup, `recorded_at` routes to `recordSignal`, metadata passthrough. |

## Finance backend wire contract

### Outbound

`FinanceAdminClient` calls the following endpoints on the finance backend
(`tgp-finance-app`, PR #93). All paths require
`Authorization: Bearer <FINANCE_SERVICE_TOKEN>` and
`X-Federation-Source: fitness-backend`.

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/admin/federation/health` | `{ ok, service: 'tgp-finance', identityMapping: 'email', surface: 'admin-federation' }` |
| `GET` | `/api/admin/federation/users/search?q=&limit=` | Bare JSON array of `{ id, email, name, role, has_coach, created_at }`. |
| `GET` | `/api/admin/federation/clients/by-email/:email` | Client finance summary including net worth, wealth velocity, EOD streak. |
| `GET` | `/api/admin/federation/coaches/by-email/:email` | Coach business summary. |
| `GET` | `/api/admin/federation/usage/product` | Aggregate product usage stats. |

### Inbound

The finance backend calls `POST /api/admin/federation/ptm-signal` on this
backend (see Inbound endpoint contract above) with
`Authorization: Bearer <FINANCE_SERVICE_TOKEN>` and
`X-Federation-Source: finance-backend`.

## Remaining integration steps

1. **Finance backend deployment** — `tgp-finance-app` PR #93 ships the
   outbound contract endpoints above.
2. **Inbound wiring on finance side** — the finance backend must call
   `POST /api/admin/federation/ptm-signal` on this backend whenever a
   user submits an EOD review (`finance_eod`) or achieves a financial
   milestone (`finance_milestone`).
3. **Service-token issuance**: provision a single shared secret
   (`openssl rand -hex 32`) and set it as `FINANCE_SERVICE_TOKEN` on
   both this backend and the finance backend. The variable name is
   identical on both sides — the legacy `FEDERATION_SERVICE_TOKEN`
   alias was renamed in audit fix H-2 (see commit history). Operators
   rotating this secret should set it under the same name in both
   `fly secrets set` calls.
4. **Durable identity**: when finance starts emitting a shared
   `account_id`, populate the optional `account_id` field on the client
   /coach summary contracts and switch `FederationService` to prefer
   the durable id, keeping email as a fallback for legacy records.
5. **Console wiring**: the admin console calls the alias surface in
   `src/admin/console/` with the operator's bearer token.
