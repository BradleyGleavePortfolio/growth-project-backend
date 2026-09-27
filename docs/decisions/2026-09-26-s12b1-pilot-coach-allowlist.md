# S12-B1: pilot-coach allowlist for the importer surface

- **Status:** Accepted T4 decision record (authorization gate). Rebuilt from the reviewed design after the
  original candidate bytes were lost; includes the round-2 closure (case-folded R-DARK-1 matcher).
- **Date:** 2026-09-26. **Decision owner:** Bradley Gleave. Setting the variable's production value is
  **owner-reserved** (S12 readiness §2c item 4); this record changes no production flag.
- **Sources:** `s12/S12_PILOT_READINESS.md` §2b S12-B1, §3.1, §3.2 kill switch 3, finding B1 (flags are
  global); `community-feature-flag.guard.ts` precedent; R-DARK-1 (`feature-flag-not-found.middleware.ts`).

## 1. Problem

The three importer flags (`FEATURE_SCOUT_INGEST`, `FEATURE_SCOUT_RECONSTRUCT`, `FEATURE_EXTENSION_PAIRING`)
are global. Turning any of them on in production lights the importer for **every** coach. The pilot needs
"exactly the named coach(es)", and a coach who is not named must not be able to tell the surface exists.

## 2. Decision

1. **Variable.** `FEATURE_SCOUT_PILOT_COACH_IDS` — comma-separated `User.id` UUIDs (the id every S8/S10
   write is keyed by via `req.user.id`). Registered in `.env.example` (empty default) and
   `prod-switches.yml` (`tier: feature`, `prod_default: STUB_ALLOWED`, `auto_flip_on_in_prod: false`; the
   value is a list, not a boolean, so `OFF` would have made the auto-flipper's target the literal `'false'`).
2. **Parser** (`src/common/feature-flag/pilot-coach-allowlist.ts`): trim, drop empties, every entry must be a
   canonical hyphenated UUID (case-insensitive, stored lower-cased, de-duplicated). **Any junk entry empties
   the whole list.** There is no "allow all" spelling. Read on every request, memoised on the raw string; one
   warning per distinct malformed value, naming positions only (never entry text).
3. **Guard** (`src/common/feature-flag/pilot-coach-allowlist.guard.ts`, global `APP_GUARD`): gated surface =
   the R-DARK-1 registry `FEATURE_GATED_ROUTES` matched against the lower-cased `req.path` and, as a second
   signal, the handler's `@Controller` path. Order: not gated ⇒ pass; any matched flag not `'true'` ⇒ uniform
   404 (before the `@Public()` exemption); `@Public()` ⇒ pass (only `POST extension/pair/redeem`); caller id on
   the list ⇒ pass; otherwise `NotFoundException("Cannot <METHOD> <url>")` — the router's own 404 message, so
   the filter renders a body identical to the flag-off and unmounted 404s.
4. **Wiring** (`src/app.module.ts`): `JwtAuthGuard` → **`PilotCoachAllowlistGuard`** → `UserThrottlerGuard` →
   `RolesGuard` → `DunningLockoutGuard`. After auth (verified id); before the throttler (no `X-RateLimit-*` on
   the off-list 404); before `RolesGuard` (404, never 403, for any role). **No owner-role bypass:** Bradley's
   owner account must be listed to use the surface.
5. **Round-2 closure (review B1).** The pre-auth middleware compared `req.path` case-sensitively while express
   routes case-insensitively, so `/API/scout/ingest` with the flag off leaked 401 (anonymous) or 204 (CORS
   preflight). The matcher now lower-cases both the path and the registry pattern, keeping the segment
   boundary and the layered reconstruct row. The guard's own flag re-check stays as defence in depth.

## 3. Consequences

- Flags on + list absent/empty/malformed ⇒ nobody reaches the importer (fail closed, §3.1 default).
- Kill switch 3 (§3.2): remove the id from the list; honoured on the next request, no restart.
- `redeem` stays reachable with pairing on regardless of the list; a code exists only if the gated `init`
  minted it for an on-list coach. `POST extension/pair/status` is gated by prefix although the readiness list
  names only init|session|current (fail-closed choice).
- Off-list probes are not per-user throttled (the guard runs before the throttler) — the same posture as the
  flag-off and unmounted 404s; on-list callers are throttled as before.
- Any future importer route outside `/api/scout` or `/api/extension/pair` (S8-D D5 unlink, person-link) needs
  a `FEATURE_GATED_ROUTES` row to inherit both gates; the static inventory test fails when a new scout or
  extension-pair route appears without a stub.
- S12-B6 must add `FEATURE_SCOUT_PILOT_COACH_IDS` to `fly-feature-flags-set.yml` (not done here).

## 4. Proof

`test/common/pilot-coach-allowlist.spec.ts` (unit: parser, resolver, matcher, guard with a real `Reflector`),
`test/common/pilot-coach-allowlist.bootstrap.spec.ts` (real HTTP through the production guard chain, R-DARK-1
middleware, RequestId, CORS and filter over every gated route; response identity off-list ≡ flag-off ≡
unmounted; case-variant matrix; static route-inventory and guard-order pins), plus one case-fold case in
`test/common/feature-flag-not-found.spec.ts`. No PostgreSQL lane is needed (no spec touches Prisma).
