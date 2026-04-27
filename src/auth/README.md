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

## Key files

| File | What it owns |
|---|---|
| `auth.controller.ts` | `/auth/*` HTTP surface — register, login, Google, signup-with-code, become-coach, select-role, attach-invite-code, signup-policy, validate-invite-code, forgot-password, me |
| `auth.service.ts` | Supabase admin/anon client wiring; signup, login, Google linkage, role selection, invite-code redemption transaction |
| `auth.guard.ts` | `JwtAuthGuard` — registered globally as `APP_GUARD`. Verifies the bearer token and attaches the DB user to `req.user` |
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
2. Role-gated routes add `@UseGuards(JwtAuthGuard, RolesGuard)` plus
   `@Roles('owner' | 'coach' | 'student')`. OWNER always passes; COACH
   and STUDENT must match exactly.
3. Signup paths (`/auth/register`, `/auth/signup-with-code`, `/auth/google`)
   create or update the `User` row and, when an `invite_code` is supplied,
   atomically link the user to the coach via `InviteCodesService`.
4. `/auth/select-role` is the post-signup role picker. Self-service is
   restricted to `student` — coach elevation is operator-only (see
   `auth.service.ts` `selectRole` for the audit trail).
5. `/auth/become-coach` lets an existing user upgrade to `coach` after a
   password re-auth against Supabase.

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

## Tests

| File | Covers |
|---|---|
| `test/auth.service.spec.ts` | Signup, login, Google linkage, role selection, invite-code redemption (happy path + races + revoked/expired) |

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
