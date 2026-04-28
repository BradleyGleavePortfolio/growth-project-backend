# admin/federation

OWNER-only cross-product federation surface. The endpoints in this module
back the Healthie/EHR-style admin console: a single screen where an
operator can search across both the fitness backend (this repo) and the
finance backend (`tgp-finance-app`) and inspect a client's or coach's
product-usage split without flipping between two consoles.

## Purpose

- One unified search bar that returns hits from both products with an
  explicit `products` array (`["fitness"]`, `["finance"]`, or both).
- One client-detail view that pulls the fitness Postgres row alongside
  the finance backend's record for the same email, with a coarse 7d
  activity block per product so the console can render usage without a
  follow-up call.
- One coach-detail view that does the same for coaches: roster size and
  subscription state from both products side by side.

The console is the only consumer. Every endpoint is class-gated by
`JwtAuthGuard + RolesGuard` with `@Roles('owner')` — coach and student
tokens get a clean 403, and the routes never leak data when the gate is
bypassed by a misconfigured upstream.

## Endpoints

All paths are mounted under the existing `/api/admin` prefix.

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/admin/federation/search?q=&limit=` | Unified search across fitness Postgres and finance backend. `limit` clamped to 1..50. |
| `GET` | `/admin/federation/clients/lookup?email=` | One-client view. Returns fitness block + finance block + product split. |
| `GET` | `/admin/federation/coaches/lookup?email=` | One-coach view. Roster + subscription from each product side by side. |

Every response carries a `finance.status` field with one of:

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

## Environment variables

Three variables, all optional everywhere. Federation degrades cleanly
when any are missing — `FINANCE_API_BASE_URL` unset is the canonical
"finance not configured yet" state and the console renders accordingly.

| Name | Tier | Reason |
|---|---|---|
| `FINANCE_API_BASE_URL` | optional | Base URL of the finance backend, e.g. `https://api.finance.thegrowthproject.app`. Validated as absolute http(s). |
| `FINANCE_SERVICE_TOKEN` | optional | Service-to-service bearer token sent on every federation call. Required when `FINANCE_API_BASE_URL` is set. |
| `FINANCE_FEDERATION_TIMEOUT_MS` | optional | Per-call timeout in ms. Defaults to 2500; clamp range is 250..15000. |

## Service auth strategy

`FinanceAdminClient` sends a static bearer token plus an
`X-Federation-Source: fitness-backend` header on every call. The finance
backend admin federation endpoints are expected to:

1. Verify the bearer token matches a service-account allow-list.
2. Verify `X-Federation-Source` matches the expected upstream label.
3. Reject any other source/auth combination with 401/403.

Static service tokens are fine for the initial cut. If the finance
backend later moves to short-lived JWTs minted by an account service,
the only swap is in `FinanceAdminClient.attempt` where the bearer is
attached. The contract types and service shape are unaffected.

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

## Remaining integration steps

1. **Finance backend** must expose three endpoints with the shapes in
   `finance-contracts.ts` — `/admin/federation/clients/search`,
   `/admin/federation/clients/lookup`,
   `/admin/federation/coaches/lookup`. The contract types here are the
   single source of truth; copy them into the finance repo or share via
   a small published package once the surface stabilizes.
2. **Service-token issuance**: provision a finance-side service-account
   token, set it as `FINANCE_SERVICE_TOKEN` in this backend's Fly
   secrets, and list this backend's source label
   (`fitness-backend`) in the finance backend's allow-list.
3. **Durable identity**: when finance starts emitting a shared
   `account_id`, switch `FederationService` to prefer the durable id and
   keep email as a fallback for legacy records.
4. **Console wiring**: the admin console (`tgp-admin-console`) should
   call these three endpoints with the operator's bearer token and
   render the `finance.status` field as a status pill. No console
   changes are required to deploy this PR — the endpoints fail closed
   when the operator role is missing.
