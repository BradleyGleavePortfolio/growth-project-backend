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
| `GET` | `/api/admin/federation/search?q=&limit=` | Unified search across fitness Postgres and finance backend. `limit` clamped to 1..50. |
| `GET` | `/api/admin/federation/clients/lookup?email=` | One-client view. Returns fitness block + finance block + product split. |
| `GET` | `/api/admin/federation/coaches/lookup?email=` | One-coach view. Roster + subscription from each product side by side. |

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

## Finance backend wire contract

`FinanceAdminClient` calls the following endpoints on the finance backend
(`tgp-finance-app`, PR #93). All paths are absolute under
`FINANCE_API_BASE_URL` and require a `Authorization: Bearer
<FINANCE_SERVICE_TOKEN>` header plus `X-Federation-Source: fitness-backend`.
The same secret value must be configured on the finance side under
`FEDERATION_SERVICE_TOKEN` (env name differs per side; the value is shared).

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/admin/federation/health` | `{ ok, service: 'tgp-finance', identityMapping: 'email', surface: 'admin-federation' }` |
| `GET` | `/api/admin/federation/users/search?q=&limit=` | Bare JSON array of `{ id, email, name, role, has_coach, created_at }`. Limit clamped to 1..100 on the finance side. |
| `GET` | `/api/admin/federation/clients/by-email/:email` | Client finance summary: `net_worth`, `asset_total`, `debt_total`, `cash_total`, `streak_days`, `last_eod_date`, `wealth_velocity_score`, `activity_last_7d`, optional `coach` pointer. |
| `GET` | `/api/admin/federation/coaches/by-email/:email` | Coach business summary: `invite_code`, `student_count`, `active_students_7d`, `eod_submissions_7d`, `coach_notes_total`, `program_templates_total`. |
| `GET` | `/api/admin/federation/usage/product` | Aggregate product usage: `users.{total, by_role, onboarding_complete}`, `engagement.{dau,wau,mau}`, `product.{eod_submissions_last_7_days, what_if_scenarios_last_30_days, coach_notes_total, milestones_unlocked_total}`. |

Email path params are URL-encoded by the client (`alice+beta@x.test` →
`alice%2Bbeta%40x.test`). Search returns a bare array, every other endpoint
returns a JSON object; the client validates this on the way in and surfaces
unexpected shapes as `degraded(malformed_response)`.

## Remaining integration steps

1. **Finance backend deployment** — `tgp-finance-app` PR #93 ships the
   five endpoints above. The contract types in `finance-contracts.ts`
   are the single source of truth on the fitness side; finance has its
   own typed handlers. Keep both sides in sync when the contract evolves.
2. **Service-token issuance**: provision a single shared secret
   (`openssl rand -hex 32`), set it as `FEDERATION_SERVICE_TOKEN` on the
   finance backend and `FINANCE_SERVICE_TOKEN` on this backend. Both
   names must point at the same value; the finance side rejects with
   401 `FEDERATION_UNAUTHENTICATED` when the bearer mismatches and 503
   `FEDERATION_DISABLED` when its own token env is unset.
3. **Durable identity**: when finance starts emitting a shared
   `account_id`, populate the optional `account_id` field on the client
   /coach summary contracts and switch `FederationService` to prefer
   the durable id, keeping email as a fallback for legacy records.
4. **Console wiring**: the admin console calls the alias surface in
   `src/admin/console/` with the operator's bearer token. The alias
   routes fan out into this federation layer so the console only needs
   to know about the console-facing path layout.
