# Admin console aliases

This directory holds the OWNER-only services that back the console-friendly
alias routes the admin console (Healthie/EHR-style account-management
surface) calls. The federation primitives live in `../federation/`; this
directory is a thin layer above them that speaks in the language the
console renders (search, coach overview, client unified record, finance
health, integrations status) instead of the federation path layout.

## Routes

All routes are mounted under `/api/admin/...` by the global Nest prefix
and gated by `JwtAuthGuard + RolesGuard + @Roles('owner')`.

| Method | Path | Backed by |
|---|---|---|
| `GET` | `/api/admin/search?q=&limit=` | `FederationService.unifiedSearch` |
| `GET` | `/api/admin/coaches/:id/overview` | `AdminConsoleService.getCoachOverview` |
| `GET` | `/api/admin/clients/:id` | `AdminConsoleService.getClientUnified` |
| `GET` | `/api/admin/clients/:id/unified` | `AdminConsoleService.getClientUnified` |
| `GET` | `/api/admin/finance/health` | `FinanceFederationService.getHealth` |
| `GET` | `/api/admin/integrations/status` | `FinanceFederationService.getIntegrationsStatus` |
| `GET` | `/api/admin/product/usage` | `FinanceFederationService.getProductUsage` |

`AdminConsoleService.getCoachOverview` and `getClientUnified` translate
the user-id the console hands us into a fitness-side email and delegate
to `FederationService` so the unified payload (fitness block + finance
block + product split) is identical to what the search hit returned.

`FinanceFederationService.getHealth` calls the finance backend's
`/api/admin/federation/health` endpoint — a static contract object the
finance side ships with the same service-token guard as the rest of the
federation surface. The probe never touches per-record tables, so there
is no risk of a noisy probe email appearing in finance-side audit logs.
Outcomes: `ok` (with `identity_mapping` and `service` echoed from the
contract), `not_configured`, `auth_unconfigured`, or `degraded` with the
underlying `reason`. No values are synthesized; missing config short-
circuits the probe and surfaces the missing piece directly.

`FinanceFederationService.getProductUsage` calls the finance backend's
`/api/admin/federation/usage/product` endpoint and surfaces the
aggregate counters (DAU/WAU/MAU, role split, EOD submissions, what-if
scenarios, coach notes, milestones unlocked) for the console's
product-usage widget. When finance is unreachable, `data` is `null` and
`status`/`reason` carry the failure mode so the console renders a
degraded pill instead of an empty chart.

## Why aliases

The federation routes (`/api/admin/federation/*`) are the canonical
interface for cross-product reads. The console talks in id-keyed verbs
(open coach by id, open client by id) and asks separate questions about
integration health that should not be answered by the per-record
federation endpoints. Keeping the alias layer thin and explicit means a
future move to a durable `account_id` join key only needs to change the
federation service — these aliases stay valid.
