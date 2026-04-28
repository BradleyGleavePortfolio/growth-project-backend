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

`AdminConsoleService.getCoachOverview` and `getClientUnified` translate
the user-id the console hands us into a fitness-side email and delegate
to `FederationService` so the unified payload (fitness block + finance
block + product split) is identical to what the search hit returned.

`FinanceFederationService.getHealth` runs a real probe against the
finance backend's `lookup` endpoint with a deterministic, well-known
probe email and reports the actual outcome — `ok`, `not_found` (still
healthy), `not_configured`, `auth_unconfigured`, or `degraded` with the
underlying `reason`. No values are synthesized; missing config short-
circuits the probe and surfaces the missing piece directly.

## Why aliases

The federation routes (`/api/admin/federation/*`) are the canonical
interface for cross-product reads. The console talks in id-keyed verbs
(open coach by id, open client by id) and asks separate questions about
integration health that should not be answered by the per-record
federation endpoints. Keeping the alias layer thin and explicit means a
future move to a durable `account_id` join key only needs to change the
federation service — these aliases stay valid.
