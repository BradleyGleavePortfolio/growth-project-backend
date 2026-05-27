# CNAME Phase 4 — Result

**PR:** [#280 — feat(landing-pages): CNAME Phase 4 — prisma regen + claim race + DNS timeout](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/280)
**Branch:** `feat/cname-phase4-prisma-race-dns`
**Base HEAD:** `22f21caf`
**Final commit:** `414445cc` (P2-2 tests) on top of `02f93f7c` (P2-1 fix) on top of `c6b3dafc` (original head).

## TL;DR

All three Phase-4 deliverables shipped in one PR. Post-audit refixes (P2-1 TOCTOU + P2-2 untested helper) added — verdict now **CLEAN — 0/0/0/12** (P3s deferred). 2915 tests passing (+6 from baseline 2909), 0 failures, tsc clean. Local `npm test -- --runInBand` and `npx tsc --noEmit` both green.

## Post-audit refixes (commits 02f93f7c, 414445cc)

### P2-1 — TOCTOU in `verify()` between ownership read and stamp UPDATE
- `src/landing-pages/custom-domain.service.ts`: snapshot the verifying domain before DNS, then issue `updateMany({ where: { id, custom_domain: verifyingDomain } })` to re-assert the bound domain on the stamp UPDATE. If `count === 0` the row was re-claimed mid-DNS-window — refuse to stamp and surface `outcome: 'domain_changed'`. Used `updateMany` (not `update`) so the no-match case returns `{ count: 0 }` instead of throwing P2025.
- `src/landing-pages/dns-verifier.ts`: extended `VerifyOutcome` union with `{ status: 'domain_changed' }` so the controller renders the race outcome via the same 200-with-reason path as every other non-`ok` state.
- Response now reports the originally-verified host (`verifyingDomain`), not the post-swap value the row holds — the audit log entry and the API contract agree on which host was actually DNS-verified.
- Test: `test/custom-domain.service.spec.ts` adds a TOCTOU spec — DNS resolver stub swaps the page's `custom_domain` mid-lookup, then asserts `outcome === 'domain_changed'`, `verified_at` unchanged, and the response surfaces the originally-verified host.

### P2-2 — `findPublishedByCustomDomain()` was untested
- `test/landing-pages.service.spec.ts` adds 5 tests covering the security-critical filter:
  1. happy path — verified + published returns the page (with `sections` + `coach` includes wired)
  2. unverified domain (`verified_at: null`) returns null — the anti-phishing gate
  3. non-published status (`draft`) returns null
  4. host normalisation — case, port, and trailing-dot all map to the same row
  5. empty/undefined host input returns null without throwing
- Extended the existing `findFirst` stub to honor `where.custom_domain`, `where.custom_domain_verified_at: { not: null }`, and the `coach.coach_profile` include shape used by the helper.

### P3s — intentionally deferred (scope discipline, R52)
The 12 P3 findings from the audit remain filed as future work. None are merge-blocking and none touch the race-safety contract.

### 1. Prisma regen
- `npx prisma generate` ran cleanly via the existing `postinstall` hook; no schema drift, no edits required.
- The `CoachLandingPage.custom_domain` field and its `@@unique([custom_domain])` constraint were already in place from the renderer-v2 migration — Phase 4 only needed to use them.
- `test/cname-prisma-client.spec.ts` is a build-time guard that will fail to transpile if regen is skipped or the schema regresses.

### 2. CNAME claim race condition
- New `CustomDomainService.claim()` relies exclusively on the Postgres unique index `CoachLandingPage_custom_domain_key` — no SELECT-then-UPDATE, no application-layer mutex.
- Single `prisma.$transaction` does ownership check + write; on `P2002` the service translates to `409 ConflictException { error: 'domain_already_claimed' }`.
- Headline test (`test/custom-domain.service.spec.ts`) fires two concurrent `claim()` calls via `Promise.allSettled` against an in-memory Prisma stub that mirrors the unique-index behaviour. Asserts **exactly one fulfilled + exactly one ConflictException**.
- Pro+ tier gating: free coaches receive `402 PAYMENT_REQUIRED { action: OPEN_PLANS }`.

### 3. DNS lookup timeout
- New `DnsVerifier` wraps `dns.promises.resolveCname` in `Promise.race` against a 3s timer (`DNS_LOOKUP_TIMEOUT_MS = 3_000`).
- Returns a structured `VerifyOutcome { status: 'ok' | 'wrong_target' | 'nxdomain' | 'timeout' | 'error' }` so the endpoint always returns 200 promptly.
- Test uses jest fake timers + a never-resolving fake resolver to assert timeout fires in O(timeoutMs) and never blocks on the inflight resolver.

## Surfaces created

| File | Purpose |
| --- | --- |
| `src/landing-pages/dns-verifier.ts` | DnsVerifier + DnsTimeoutError + DNS_LOOKUP_TIMEOUT_MS |
| `src/landing-pages/custom-domain.service.ts` | claim/verify/release w/ race-safe transaction + tier gate |
| `src/landing-pages/custom-domain.controller.ts` | POST/POST verify/DELETE under `/api/v1/coach/landing-pages/:id/custom-domain` |
| `src/landing-pages/landing-pages.module.ts` | wired new controller + providers |
| `src/landing-pages/landing-pages.service.ts` | +`findPublishedByCustomDomain()` (verified-only) for future host-header rewrite |
| `test/dns-verifier.spec.ts` | 9 tests (incl. fake-timer timeout proof) |
| `test/custom-domain.service.spec.ts` | 18 tests (incl. race-condition assertion) |
| `test/cname-prisma-client.spec.ts` | 2 tests (build-time Prisma client guard) |

## Numbers

- **New tests:** 35 (9 dns-verifier + 19 custom-domain incl. TOCTOU + 2 prisma-client + 5 findPublishedByCustomDomain)
- **Full suite (post-refix):** 2915 passed, 16 skipped, 5 todo, 0 failed across 252 suites — `npm test -- --runInBand`
- **Type-check:** `npx tsc --noEmit` clean
- **Files changed:** 8 (5 src, 3 test)
- **app.module.ts touched:** NO
- **Refix commits:** `02f93f7c` (P2-1), `414445cc` (P2-2)

## Out of scope (deferred)

- Fly Machines cert issuance + SNI router wiring
- Verification cron / background re-verify
- Host-header rewrite on the public renderer (helper exists; controller wiring intentionally deferred to keep PR focused on the 3 deliverables per R52)

## Plan reference

`/home/user/workspace/audits/cname_phase4_plan.md`
