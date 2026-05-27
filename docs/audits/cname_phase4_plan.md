# CNAME Phase 4 — Plan

## Current state (mapped)

- `CoachLandingPage` model already has `custom_domain String?` + `custom_domain_verified_at DateTime?` with a `@@unique([custom_domain])` constraint. The matching migration (`20260901000000_r46_landing_page_builder_phase1/migration.sql`) creates `CoachLandingPage_custom_domain_key` as a Postgres unique index. That's the DB-level invariant we need — no migration changes required for the race fix.
- `prisma generate` runs cleanly against the existing schema; `prisma format` is a no-op. No drift to resolve.
- `LandingPagesModule` registers controllers/services but has no `CustomDomainService`, no claim endpoint, no verify endpoint, no DNS plumbing.
- The public controller has a TODO marker for host-header → page rewrite but no implementation.
- `CoachSubscription.tier` (enum `CoachTier`: `free | pro | enterprise`) is the gating field for Pro+ access.
- Tests follow an in-memory Prisma stub pattern (see `test/landing-pages.service.spec.ts`).

## Scope of the 3 deliverables

1. **Prisma regen.** Confirmed clean. No drift. Will run `npx prisma generate` in CI via the existing `postinstall` hook; no schema edits needed for Phase 4.
2. **Race-safe claim.** Add `CustomDomainService.claim(coachId, pageId, domain)` that:
   - Validates Pro+ tier (throw 402 `pro_tier_required` for free).
   - Validates domain shape (lowercase, FQDN regex, length ≤ 253, no scheme, no path).
   - Runs the write inside `prisma.$transaction` — a single `update` with the unique-constraint catching collisions. On `P2002` (Prisma unique violation), translate to `409 domain_already_claimed`. This is DB-level atomicity, not an app-layer lock.
   - Resets `custom_domain_verified_at` to `null` on (re)claim so the next verify call re-checks DNS.
3. **DNS timeout.** New `DnsVerifier` helper that wraps Node's `dns/promises.resolveCname` in `Promise.race` against a 3s timer. On timer win: throw `DnsTimeoutError`. Service `verify(coachId, pageId)` consumes it, returns `{ verified, reason }`. Reasons: `timeout | nxdomain | wrong_target | ok`. The endpoint returns 200 with a structured body — never hangs the request.

## Surfaces touched

- `src/landing-pages/custom-domain.service.ts` (new)
- `src/landing-pages/custom-domain.controller.ts` (new — mounted under `v1/coach/landing-pages/:id/custom-domain`)
- `src/landing-pages/dns-verifier.ts` (new)
- `src/landing-pages/landing-pages.module.ts` (register new service + controller)
- `src/landing-pages/landing-pages.public.controller.ts` (small: read `Host` header, look up page by `custom_domain`, rewrite)
- `src/landing-pages/landing-pages.public.service.ts` (add `findPublishedByCustomDomain`)
- `test/custom-domain.service.spec.ts` (new — covers race condition via simulated unique-violation, tier gating, normalization)
- `test/dns-verifier.spec.ts` (new — covers 3s hard timeout via fake slow resolver + jest fake timers)
- `test/custom-domain.controller.spec.ts` (new — covers route wiring + 409/402 paths)

Out of scope (deferred): Fly cert issuance, verification cron, retry backoff. Phase 4 lands the surface; cert plumbing is later PRs per the original TODO in `landing-pages.module.ts`.

## Risk + invariant

The race condition correctness depends entirely on the existing `CoachLandingPage_custom_domain_key` unique index. The Phase 4 service must therefore **never** read-then-write the column (that's the application-layer-lock anti-pattern). It must always issue a single `update` and let Postgres reject the loser. The test asserts this by firing two `claim()` calls under `Promise.all` against an in-memory stub that simulates the unique constraint and checking exactly one resolves while the other rejects with `ConflictException`.
