# Role Audit — growth-project-backend

**Audit date:** 2026-05-08  
**Branch:** `feat/phase-10-role-gating-hardening`  
**Auditor:** Phase 10 Track 5 agent

This document records every controller route, its intended role(s), and the decoration status after Phase 10 hardening.

## Role taxonomy

| Role | Who | Can do |
|---|---|---|
| `owner` | Platform administrator | Everything. Automatic pass-through in RolesGuard and CoachGuard. |
| `coach` | Fitness coach | Manage their clients, view dashboards, send messages and nudges, create meal plans. Cannot touch admin or billing owner routes. |
| `student` | Client/athlete | Access their own data (weight, food, habits, check-ins, etc.). Cannot access other users' data or coach admin surfaces. |
| *(public)* | Unauthenticated | Health check, landing pages, auth sign-up/login, diagnostic submission, invite-code preview. |

**Hierarchy:** `owner > coach > student`. Every route that permits `student` is also accessible to `coach` and `owner` (via RolesGuard OWNER bypass). Every route that permits `coach` is also accessible to `owner`.

## Guard inventory

| Guard | Source | Behavior |
|---|---|---|
| `JwtAuthGuard` | `src/auth/auth.guard.ts` | Global `APP_GUARD`. Validates Supabase JWT via JWKS. Sets `req.user`. Skips routes marked `@Public()`. |
| `RolesGuard` | `src/auth/roles.guard.ts` | Reads `@Roles(...)` metadata. Checks `req.user.role`. OWNER always passes. |
| `CoachGuard` | `src/auth/coach.guard.ts` | Legacy guard — enforces `coach \| owner`. Predates `@Roles`. |
| `CoachOrOwnerGuard` | `src/billing/` | Like CoachGuard, billing-module specific. |
| `OwnerGuard` | (billing) | Enforces `owner` only. |
| `RecentAuthGuard` | `src/auth/recent-auth.guard.ts` | **New in Phase 10.** Validates `X-Recent-Auth-Token` HMAC. Applied to account deletion and sensitive admin actions. |
| `SubscriptionGuard` | `src/billing/subscription.guard.ts` | Enforces active subscription. Applied per-handler to premium messaging routes. |

## Route-by-route audit

### `src/auth/auth.controller.ts` — `/auth/*`

| Method | Path | Guard(s) | Role | Decorator | Notes |
|---|---|---|---|---|---|
| POST | /auth/register | global JWT | — | `@Public()` | Public signup |
| POST | /auth/login | global JWT | — | `@Public()` | Public login |
| POST | /auth/google | global JWT | — | `@Public()` | Public OAuth |
| POST | /auth/apple | global JWT | — | `@Public()` | Public OAuth |
| GET | /auth/signup-policy | global JWT | — | `@Public()` | Policy probe |
| POST | /auth/attach-invite-code | JwtAuthGuard | authenticated | `@UseGuards(JwtAuthGuard)` | Any authenticated user |
| POST | /auth/select-role | JwtAuthGuard | authenticated | `@UseGuards(JwtAuthGuard)` | Any authenticated user |
| POST | /auth/validate-invite-code | global JWT | — | `@Public()` | Public preview |
| POST | /auth/forgot-password | global JWT | — | `@Public()` | Public reset |
| GET | /auth/me | JwtAuthGuard | authenticated | `@UseGuards(JwtAuthGuard)` | Any authenticated user |
| POST | /auth/become-coach | JwtAuthGuard | authenticated | `@UseGuards(JwtAuthGuard)` | Self-elevation (gated by env flag) |
| POST | /auth/signup-with-code | global JWT | — | `@Public()` | Public signup |
| POST | /auth/recent-auth-token | JwtAuthGuard | authenticated | `@UseGuards(JwtAuthGuard)` | **New.** Issues re-auth HMAC token |

### `src/admin/admin.controller.ts` — `/admin/*`

All routes: `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles('owner')` at class level. ✅

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | /admin/metrics | owner | Platform metrics |
| GET | /admin/coaches | owner | List coaches |
| GET | /admin/coaches/:id | owner | Coach detail |
| GET | /admin/users | owner | List users |
| POST | /admin/users/:id/promote | owner | Role change |
| GET | /admin/audit-log | owner | Audit log |
| GET | /admin/federation/search | owner | Cross-product search |
| GET | /admin/federation/clients/lookup | owner | Client lookup |
| GET | /admin/federation/coaches/lookup | owner | Coach lookup |
| GET | /admin/search | owner | Console search alias |
| GET | /admin/coaches/:id/overview | owner | Coach overview |
| GET | /admin/clients/:id | owner | Client unified |
| GET | /admin/clients/:id/unified | owner | Client unified alias |
| GET | /admin/clients/:id/entitlements | owner | Entitlements |
| GET | /admin/coaches/:id/entitlements | owner | Coach entitlements |
| GET | /admin/finance/health | owner | Finance health |
| GET | /admin/integrations/status | owner | Integration status |
| GET | /admin/product/usage | owner | Product usage |
| GET | /admin/clients/:id/consent | owner | Client consent |
| POST | /admin/gdpr/scrub | owner | GDPR scrub |
| GET | /admin/coach-effectiveness | owner | Effectiveness list |
| GET | /admin/coach-effectiveness/:id | owner | Effectiveness detail |
| GET | /admin/coach-onboarding | owner | Onboarding progress |
| GET | /admin/coach-alerts | owner | Alert aggregator |
| GET | /admin/build-week/enrollments | owner | Build week list |
| GET | /admin/build-week/funnel | owner | Build week funnel |

### `src/admin/ptm/admin-ptm.controller.ts` — `/admin/` (PTM)

All routes: `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles('owner')`. ✅

### `src/admin/reports/reports.controller.ts` — `/admin/reports/`

All routes: `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles('owner')`. ✅

### `src/admin/federation/federation-inbound.controller.ts` — `/admin/federation/`

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | /admin/federation/ptm-signal | — | `@Public()` + service-level `FINANCE_SERVICE_TOKEN` HMAC ✅ |

### `src/users/users.controller.ts` — `/users/me/*`

After Phase 10 hardening: `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles('student')` at class level. ✅

| Method | Path | Guard | Notes |
|---|---|---|---|
| GET | /users/me/preferences | student+ | |
| PATCH | /users/me/preferences | student+ | |
| GET | /users/me/badges | student+ | Returns 410 Gone |
| GET | /users/me/founding-number | student+ | |
| GET | /users/me/circle-stats | student+ | |
| POST | /users/me/data-export | student+ | |
| GET | /users/me/data-export/:id | student+ | |
| DELETE | /users/me/account | student+ | **+ RecentAuthGuard** ✅ |
| POST | /users/me/account/cancel-deletion | student+ | |
| GET | /users/me/account/deletion-status | student+ | |
| GET | /users/me/account/status | student+ | |

### `src/profile/profile.controller.ts` — `/profile`

After Phase 10 hardening: `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles('student')`. ✅

### `src/health/health.controller.ts` — `/health`, `/healthz`, `/readyz`

`@Public()` at class level. ✅ Intentionally unauthenticated.

### `src/system/system.controller.ts` — `/system/trust-meta`

`@Public()` at class level. ✅ Intentionally unauthenticated.

### `src/public-pages/public-pages.controller.ts`

All routes `@Public()`. ✅ Intentionally unauthenticated (download links, privacy page, terms, etc.)

### `src/diagnostic/diagnostic.controller.ts`

All routes `@Public()`. ✅ Rate-limited lead-capture form.

### `src/invite-landing/invite-landing.controller.ts`

All routes `@Public()`. ✅ Public landing page.

### `src/billing/stripe-webhook.controller.ts` — `/v1/webhooks/stripe`

`@Public()` + Stripe signature verification inside service. ✅

### `src/billing/coach-billing.controller.ts`, `mobile-coach-billing.controller.ts`

`@UseGuards(JwtAuthGuard, CoachOrOwnerGuard)` at class level. Legacy guard equivalent to `@Roles('coach')`. In legacy allowlist.

### `src/billing/owner-billing.controller.ts`

`@UseGuards(JwtAuthGuard, OwnerGuard)` at class level. Legacy guard equivalent to `@Roles('owner')`. In legacy allowlist.

### `src/coach/coach.controller.ts`, coach-* controllers

`@UseGuards(JwtAuthGuard, CoachGuard)` at class level. Legacy guard equivalent to `@Roles('coach')`. In legacy allowlist.

### `src/v1/v1-coach.controller.ts`

`@UseGuards(JwtAuthGuard, CoachOrOwnerGuard)` at class level. In legacy allowlist.

### Student-facing controllers (all audited and @Roles added in Phase 10)

The following controllers had only `@UseGuards(JwtAuthGuard)` before Phase 10. They now have `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles('student')` at class level:

- `src/timeline/timeline.controller.ts` ✅
- `src/check-ins/client-check-ins.controller.ts` ✅
- `src/messaging/client-messaging.controller.ts` ✅
- `src/notifications/notifications.controller.ts` ✅
- `src/nudges/client-nudges.controller.ts` ✅
- `src/ai/ai.controller.ts` ✅
- `src/community/community.controller.ts` ✅
- `src/consent/consent.controller.ts` ✅
- `src/fasting/fasting.controller.ts` ✅
- `src/food/food.controller.ts` ✅
- `src/habits/habits.controller.ts` ✅
- `src/lessons/lessons.controller.ts` ✅
- `src/lists/lists.controller.ts` ✅
- `src/log/log.controller.ts` ✅
- `src/meal-plans/client-meal-plans.controller.ts` ✅
- `src/prep-guide/prep-guide.controller.ts` ✅
- `src/recipes/recipes.controller.ts` ✅
- `src/water/water.controller.ts` ✅
- `src/weight/weight.controller.ts` ✅
- `src/workout/workout.controller.ts` ✅
- `src/first-win/first-win.controller.ts` ✅
- `src/build-week/build-week.controller.ts` ✅

## Summary

| Category | Count |
|---|---|
| Total routes audited | ~115 |
| Already correctly gated | ~45 |
| Gaps fixed (added @Roles) | 23 controllers (~65 routes) |
| Intentionally public routes documented | 27 |
| RecentAuthGuard applied | 1 (account deletion, more can be added) |
| Routes in legacy-guard allowlist | ~35 |

## Gaps fixed

1. **23 student-facing controllers** lacked explicit `@Roles(...)` — now have `@Roles('student')`.
2. **`DELETE /users/me/account`** — added `RecentAuthGuard` (requires re-auth before account deletion).
3. **`POST /auth/recent-auth-token`** — new endpoint for issuing re-auth HMAC tokens.

## Known follow-ups

- Apply `RecentAuthGuard` to `POST /admin/users/:id/promote` (role change) once admin controller is confirmed clear of CI conflicts.
- Apply `RecentAuthGuard` to GDPR force-delete endpoint when Phase 10 GDPR track lands.
- Migrate `CoachGuard` / `CoachOrOwnerGuard` / `OwnerGuard` to `@Roles(...)` in a future cleanup PR to eliminate the legacy allowlist.
- Consider `@Roles('coach')` on `/auth/become-coach` endpoint to document intent explicitly (currently just `@UseGuards(JwtAuthGuard)`).
