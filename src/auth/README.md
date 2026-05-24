# auth

Supabase-backed authentication, role gating, and the OWNER → COACH → STUDENT
hierarchy. Every authenticated request in the API passes through this module.

## Purpose

- Sign up, log in, and reset passwords against Supabase Auth.
- Verify Supabase access tokens locally via JWKS (no per-request round-trip
  to Supabase Auth).
- Enforce three roles (`owner`, `coach`, `student`) with OWNER as a
  hierarchy-wide pass-through.
- Bridge Google OAuth into the same role/coach-link pipeline as
  email/password signup.
- Carry the invite-code field through signup so a client can land on a
  coach's roster in a single round-trip.
- Emit a fire-and-forget `app_open` PTM signal on every authenticated
  request (with a 4-hour per-user dedup window) so the heuristic engine
  has a reliable "was the app used in the last 7 days?" data point.

## Key files

| File | What it owns |
|---|---|
| `auth.controller.ts` | `/auth/*` HTTP surface — register, login, Google, signup-with-code, become-coach, select-role, attach-invite-code, signup-policy, validate-invite-code, forgot-password, me |
| `auth.service.ts` | Supabase admin/anon client wiring; signup, login, Google linkage, role selection, invite-code redemption transaction |
| `auth.guard.ts` | `JwtAuthGuard` — registered globally as `APP_GUARD`. Verifies the bearer token, attaches the DB user to `req.user`, and fires the `app_open` PTM signal (dedup-gated). |
| `jwks.service.ts` | `JwksVerifierService` — `jose.createRemoteJWKSet` against `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`; ES256 + issuer/audience pinning |
| `roles.guard.ts` | `RolesGuard` — reads `@Roles(...)` and matches against `req.user.role`; OWNER bypasses everything |
| `coach.guard.ts` | Legacy guard widened in Phase 1B so OWNER passes through every coach route |
| `auth.dto.ts` | Class-validator DTOs for every body the controller accepts |
| `auth-request.ts` | `AuthedRequest` type — the shape the guards put on `req` |

## Request / data flow

1. `JwtAuthGuard` runs globally. It pulls the bearer token from
   `Authorization: Bearer …`, hands it to `JwksVerifierService.verify`,
   then loads the matching `User` row by `supabase_id` and pins it to
   `req.user`. Routes marked `@Public()` skip this entirely.
2. After all GDPR lifecycle gates pass (see below), the guard calls
   `maybeEmitAppOpen(userId)`. This is fire-and-forget — any failure is
   silently swallowed and the request continues unaffected.
3. Role-gated routes add `@UseGuards(JwtAuthGuard, RolesGuard)` plus
   `@Roles('owner' | 'coach' | 'student')`. OWNER always passes; COACH
   and STUDENT must match exactly.
4. Signup paths (`/auth/register`, `/auth/signup-with-code`, `/auth/google`)
   create or update the `User` row and, when an `invite_code` is supplied,
   atomically link the user to the coach via `InviteCodesService`.
5. `/auth/select-role` is the post-signup role picker. Self-service is
   restricted to `student` — coach elevation is operator-only (see
   `auth.service.ts` `selectRole` for the audit trail).
6. `/auth/become-coach` is **hard-gated off by default** on every
   deployment. It returns a structured `403 self_service_promotion_disabled`
   pointing the caller at the canonical owner-only path
   (`POST /admin/users/:id/promote`). To re-open the legacy self-service
   path for a one-off migration set `ALLOW_SELF_SERVICE_BECOME_COACH=true`;
   in that mode the password is re-verified against Supabase, the role
   change is audited as `user.role_changed` with
   `metadata.via=self_service_become_coach`, and OWNERs are still refused.
   The gate is intentionally fail-closed — a misconfigured deploy that
   drops the env var keeps the hole shut.

## app_open PTM signal

`JwtAuthGuard` is the canonical emit site for the `app_open` signal
(Phase 1A, introduced alongside the finance-federation inbound endpoint).

### Why the guard, not a dedicated endpoint?

- Works retroactively for existing mobile clients — no client release
  required. The signal starts flowing the day this change deploys.
- The natural definition of "app open" is "first authenticated request
  after a quiet period." The guard already has the `User` row loaded;
  the emit is fire-and-forget with zero added request latency.

### Dedup window

A per-process in-memory `Map<userId, lastEmitMs>` suppresses repeated
emits for the same user within a 4-hour window. The heuristic engine only
asks "did `app_open` happen in the last 7 days?" so per-pod dedup is
accurate enough: worst case N pods emit once per 4h per user, and the
signal is still present/absent at the 7-day boundary.

The map is bounded at `APP_OPEN_DEDUP_MAX_SIZE` (10 000 entries). When
it overflows, the oldest 50% of entries are pruned before inserting the
new one — bounded memory regardless of roster size.

### GDPR safety

The signal only fires after the `deleted_at` and `deletion_scheduled_at`
gates pass. Deleted accounts never produce a signal.

### Metadata

`{ source: 'jwt_validate' }` — PII-free.

## Security and tenancy rules

- Bearer tokens are verified against the Supabase JWKS, not by calling
  `supabase.auth.getUser`. Signature, expiry, issuer, and audience are
  all enforced. The verifier carries a 5s clock skew tolerance to
  survive normal drift around token refresh.
- A token authenticated by another OAuth provider cannot be replayed at
  `/auth/google`. The handler inspects `app_metadata.provider`,
  `app_metadata.providers`, and `identities[].provider` and rejects any
  token that does not assert Google as the issuer.
- `selectRole` refuses any client request to elevate a user to `coach`
  or `owner`. Coach provisioning happens through the admin module or a
  bootstrap script.
- Invite-code redemption runs in an interactive Prisma transaction with
  optimistic concurrency on `used_count`, so a race between two
  redemptions on the last seat fails closed for one of them.
- OWNERs are refused from redeeming invite codes outright — the platform
  admin should not become a student of a coach.
- `forgot-password` always returns a generic 200 message. Errors are
  logged but never surfaced to the caller, so the endpoint cannot be
  used to enumerate registered emails.

## Throttling

- `POST /auth/register`: 10 / hour / IP. Loose enough for shared NAT,
  tight enough to kill enumeration loops.
- `POST /auth/login`: 10 / minute / IP.
- `POST /auth/signup-with-code`: 10 / hour / IP.
- `POST /auth/validate-invite-code`: 20 / minute / IP. Brute-force on the
  30-bit code space is infeasible at this rate.

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `SUPABASE_URL` | yes | Source of the JWKS endpoint and admin SDK base URL. Also pinned as the token issuer. |
| `SUPABASE_ANON_KEY` | yes | Anon key — used for `signInWithPassword`, `signUp`, and `resetPasswordForEmail`. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Admin SDK key — used by the Google handler to call `auth.getUser(token)` and resolve the Supabase user. |
| `SUPABASE_REDIRECT_URL` | yes | Email-confirm deep link target (e.g. `tgp://verified`). |
| `COACH_CODE_GATE_ENABLED` | optional | When `true`, `/auth/signup-with-code` requires a coach invite code. `/auth/signup-policy` reflects this via `invite_code_required` (canonical) and `coach_code_required` (deprecated alias) so mobile can hide/show the field. |

`/auth/signup-policy` also exposes the invite-code format spec
(`invite_code.min_length`, `max_length`, `prefix`) so the mobile client
can gate input client-side. `/auth/validate-invite-code` rejects
out-of-spec input with a polished structured 400 carrying
`code: 'invite_code_invalid_format'` — no input echo, no DB lookup, the
same shape regardless of which constraint failed.

`JWT_SECRET` is reserved and currently unused — verification is JWKS-based.

## Failure modes

- JWKS endpoint outage → every authenticated request returns 401. Login
  itself runs against Supabase Auth, so a true outage breaks login first.
- Supabase user exists but has no row in `User` (rare; created out-of-band)
  → `/auth/me` and the guard both return 401 `User not found`.
- Google token replay: rejected as `Google auth failed — token is not from
  Google`.
- Invite-code race lost in the transaction: the second caller gets
  `Invalid or expired invite code` — the redemption is atomic.
- Misconfigured `SUPABASE_URL` → `JwksVerifierService.onModuleInit` throws
  at boot. The app does not start with auth half-configured.
- `app_open` emit failure: silently swallowed. A PTM table outage must
  never 5xx the upstream request.

## Tests

| File | Covers |
|---|---|
| `test/auth.service.spec.ts` | Signup, login, Google linkage, role selection, invite-code redemption (happy path + races + revoked/expired) |
| `test/auth-guard-deletion-lockout.spec.ts` | GDPR lifecycle gate: scheduled-for-deletion lockout, scrubbed-user lockout, healthy users pass through |
| `test/ptm-app-open-dedup.spec.ts` | app_open emit on first request, 4-hour dedup window, re-emit after window expiry, no emit for deleted users, overflow pruning |

The DTO mass-assignment guard (`test/dto-mass-assignment.spec.ts`) covers
`whitelist + forbidNonWhitelisted` over every DTO including the auth DTOs.

## Operational notes

- Tokens are verified locally; rotating the Supabase signing key is
  handled automatically by `jose.createRemoteJWKSet`'s cooldown +
  refresh on `kid` miss. No redeploy needed for routine rotation.
- A surge in `JWT verification failed: kid not in JWKS` warnings for
  more than the JWKS cache TTL (default 10 min) means the project's
  signing keys diverged from what the verifier sees — usually the
  `SUPABASE_URL` env is pointed at the wrong project.
- The PostHog `user_registered` event fires server-side from
  `register()` so it cannot be spoofed by a client. `AnalyticsService`
  is a no-op when `POSTHOG_KEY` is unset.

---

## Phase 10 — Role-Gating Hardening (additions)

### Role taxonomy

| Role | Who it represents | Hierarchy position |
|---|---|---|
| `owner` | Platform administrator (Bradley or ops team) | Highest — passes every role check automatically |
| `coach` | Fitness coach on the platform | Middle — can access coach + student routes |
| `student` | Client / athlete | Base — can only access their own data |

**OWNER bypass:** `RolesGuard` grants pass-through for every `owner` user regardless of the required roles on a route. A coach-only route is reachable by an owner; a student-only route is reachable by all three.

### Decoration rules (non-negotiable)

Every route handler MUST have one of:

| Decorator | When to use |
|---|---|
| `@Roles('student')` | Data is scoped to `req.user.id`. All three roles can access (student, coach, owner). |
| `@Roles('coach')` | Action requires a coach or owner (roster management, dashboards, nudges to clients). |
| `@Roles('owner')` | Admin-only action (promote users, view platform metrics, run GDPR scrub). |
| `@Public()` | Endpoint must be reachable without a JWT (health checks, auth endpoints, landing pages, Stripe webhooks). |

A missing decorator is caught at build time by `test/roles-enforced.spec.ts` — the test fails CI with the exact route name.

### Re-auth flow

Sensitive actions (account deletion, role changes) require proof that the human at the keyboard recently entered their password. This is enforced by `RecentAuthGuard` (`src/auth/recent-auth.guard.ts`).

**Client flow:**

1. User taps a sensitive action (e.g. "Delete account").
2. App prompts for current password.
3. App calls `POST /auth/recent-auth-token` with the password.
4. Backend verifies password via Supabase `signInWithPassword`.
5. Backend returns `{ token, expires_in_ms }`.
6. App passes the token as `X-Recent-Auth-Token` header on the guarded request.
7. `RecentAuthGuard` validates the HMAC + freshness + user binding.

**Token format:**

```
X-Recent-Auth-Token: <user_id>.<issued_at_ms>.<hmac_sha256_hex>
```

HMAC key: `RECENT_AUTH_SECRET` (from environment).  
HMAC input: `"<user_id>:<issued_at_ms>"`.  
Default validity: 5 minutes (`RECENT_AUTH_TTL_MS`).  
Bound to: the authenticated user's id — cross-user replay is rejected.

**Endpoints requiring re-auth (Phase 10):**

| Endpoint | Reason |
|---|---|
| `DELETE /users/me/account` | Irreversible; confirms the user means to delete their account |

**Planned (see follow-ups):**

| Endpoint | Reason |
|---|---|
| `POST /admin/users/:id/promote` | Role change — privilege escalation risk |
| `POST /admin/gdpr/scrub` | Irreversible data destruction |

### RolesEnforced meta-test

`test/roles-enforced.spec.ts` walks every controller registered in `AppModule` using NestJS metadata reflection. If any handler is missing both `@Roles(...)` and `@Public()` (and is not in the documented legacy-guard allowlist), the test fails with:

```
Route is ungated: YourController.yourMethod — add @Roles() or @Public()
```

This runs in `npm test` (the `build-and-test` CI job) so a new route without decoration blocks the PR.

### Cross-tenant scoping rule

Every service method that returns user-scoped data MUST derive `userId` from `req.user.id` (set by `JwtAuthGuard`), not from a URL parameter or query string. The Prisma `where` clause MUST include `user_id: userId`.

Verified by `test/cross-tenant-isolation.spec.ts`.

### New env vars (Phase 10)

| Var | Required | Default | Purpose |
|---|---|---|---|
| `RECENT_AUTH_SECRET` | yes (for RecentAuthGuard routes) | — | HMAC signing secret. Generate: `openssl rand -hex 32`. |
| `RECENT_AUTH_TTL_MS` | no | 300000 | Token validity window in ms (5 min). |
| `GOOGLE_CLIENT_ID` | no | — | Google OAuth client ID(s) — required for Google recent-auth token verification. Omit to disable Google re-auth. |
| `GOOGLE_CLIENT_IDS` | no | — | Google OAuth client ID(s) — required for Google recent-auth token verification. Omit to disable Google re-auth. Comma-separated; supersedes `GOOGLE_CLIENT_ID` when both are set. |

When neither `GOOGLE_CLIENT_ID` nor `GOOGLE_CLIENT_IDS` is set, `/auth/signup-policy` omits `'google'` from `providers` and the `provider=google` branch of `POST /auth/recent-auth-token` rejects every token with a generic 401. Boot is not blocked; the env-validation summary logs a single named warning so operators can correlate the symptom with the missing config.

### New files (Phase 10)

| File | Purpose |
|---|---|
| `src/auth/recent-auth.guard.ts` | `RecentAuthGuard` + `issueRecentAuthToken()` helper |
| `test/recent-auth.guard.spec.ts` | Unit tests: positive + 5 negative paths |
| `test/roles-enforced.spec.ts` | Meta-test: every route has @Roles or @Public |
| `test/cross-tenant-isolation.spec.ts` | Service-layer scoping assertions |
| `docs/security/role-gating.md` | Per-route role table (full audit) |

### Tests (Phase 10 additions)

| File | Covers |
|---|---|
| `test/recent-auth.guard.spec.ts` | Missing secret → 403; missing header → 401; malformed token → 401; expired → 401; wrong user → 403; tampered HMAC → 401; valid token → pass; `issueRecentAuthToken` helper round-trip |
| `test/roles-enforced.spec.ts` | Every route has a decorator or is in the allowlist; ungated routes fail CI with exact route name |
| `test/cross-tenant-isolation.spec.ts` | WeightService, WaterService, FastingService scope queries to the requesting user only |

### Future work (Phase 10)

- Migrate legacy `CoachGuard` / `CoachOrOwnerGuard` / `OwnerGuard` to `@Roles(...)` to eliminate the legacy-guard allowlist in `roles-enforced.spec.ts`.
- Apply `RecentAuthGuard` to `POST /admin/users/:id/promote` (role changes) and the Phase 10 GDPR force-delete endpoint.
- Add biometric-auth token path on mobile (currently password-only).
- Consider a short-lived server-side nonce store to enable re-auth token revocation if 5-minute window is too wide.
