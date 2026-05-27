# PR #280 v2 — CNAME Phase 4 re-audit at `414445cc`

**Verdict: CLEAN — 0 / 0 / 0 / 13** (P0 / P1 / P2 / P3)

> Reading: both v1 P2s are genuinely closed by the refix commits. No new P0/P1/P2 introduced. Twelve v1 P3s remain P3; one new P3 added (`stamp-then-release` cosmetic response mismatch on `verify`). Full suite passes 2915/2915 (252 suites). `npx tsc --noEmit` clean. **Merge-ready.**

Worktree (read-only): `/home/user/workspace/tgp/backend-280-audit-v2` @ `414445cc42d61accec360ba47bfc2822973976b1`.
Base for diff: `origin/main` @ `22f21caf`.
Refix commits under audit: `02f93f7c` (P2-1) + `414445cc` (P2-2).

---

## P2 fix verification

### P2-1 — `verify()` TOCTOU between `findFirst` and the stamp UPDATE — **CLOSED**

`src/landing-pages/custom-domain.service.ts:177-221`. Fix applied as the v1 audit prescribed:

1. **Snapshot** `verifyingDomain = page.custom_domain` captured before the DNS call (line 182). This is the value passed to `dns.verifyCname(...)`, so the verification target is locked in JS-local scope independent of any subsequent DB state.
2. **Re-assertion** in the stamp WHERE clause: `updateMany({ where: { id: pageId, custom_domain: verifyingDomain }, data: { custom_domain_verified_at: new Date() }})` (line 198-201). `updateMany` was chosen over `update` precisely so the no-match case returns `{ count: 0 }` instead of throwing P2025 — correct call, with an explicit code comment justifying the choice (line 196-197).
3. **No-match handling**: when `stamped.count === 0` the code logs a `warn` (line 206-209), sets `effectiveOutcome = { status: 'domain_changed' }`, and `verifiedAt = null` — and short-circuits before any further mutation (line 210-211). No `verified_at` is stamped on the post-swap host.
4. **Response** carries `custom_domain: verifyingDomain` (the originally-verified value, not the post-swap value the row now holds) — line 225. This is the right call: the client asked to verify a specific host and the response tells them which host was actually DNS-checked.

The race window between the new `updateMany` and the subsequent `findUnique` read-back (line 215-218) cannot stamp a wrong domain because `verified_at` is stamped by the `updateMany` alone — the `findUnique` only reads it back. See **P3-13 (new)** for the cosmetic-only consequence.

**TOCTOU test** (`test/custom-domain.service.spec.ts:373-405`) reproduces the race by mutating `page.custom_domain` from inside the DNS resolver stub mid-await, then asserts:
- `outcome === { status: 'domain_changed' }`
- `verified_at === null`
- `page.custom_domain_verified_at === null` (DB unchanged)
- `out.custom_domain === 'verified.example.com'` (response carries pre-swap value)

The test is structurally sound: the only way `outcome === 'domain_changed'` is reached is via the `count === 0` branch, which only fires when the WHERE-clause re-assertion fails. Removing the `custom_domain: verifyingDomain` from the updateMany WHERE would turn this test red.

### P2-2 — Missing tests for `findPublishedByCustomDomain()` — **CLOSED**

`test/landing-pages.service.spec.ts:610-695`. Five tests added, three of which exercise security-critical gate behaviour:

| # | Test | Gate exercised |
| - | --- | --- |
| 1 | `returns the published page when the custom_domain is verified` | Happy path; renderer-shape include (sections + coach.coach_profile) asserted |
| 2 | `returns null when the custom_domain is claimed but NOT verified` | **`custom_domain_verified_at: { not: null }` — the anti-phishing gate** |
| 3 | `returns null when the page status is not "published"` | **`status: 'published'` — draft/archived leak gate** |
| 4 | `normalises the incoming host: lowercases, strips port, strips trailing dot` | Host-header parsing parity |
| 5 | `returns null for empty / undefined host inputs` | Null safety |

The stub for `findFirst` was extended at lines 86-92 to honour `where.custom_domain` and the `where.custom_domain_verified_at?.not === null` predicate. This is important — without that stub extension tests 2 and 3 would be no-ops. Verified by inspection: dropping `custom_domain_verified_at: { not: null }` from the production code would cause test 2 to return a non-null page and fail. Dropping `status: 'published'` would cause test 3 to fail.

The include shape was widened to differentiate the legacy `coach.profile` payload (existing call sites) from the new `coach.coach_profile` payload (CNAME helper) by checking `include?.coach` — the stub no longer returns a stale shape that would mask production drift.

---

## Refix-introduced code audit

### New `VerifyOutcome` variant `{ status: 'domain_changed' }`

`src/landing-pages/dns-verifier.ts:54-58`. Discriminated-union variant added with a clear doc comment that it is service-emitted only (not DNS-layer). No caller in the repo exhaustively switches on `outcome.status` — verified by grepping for `outcome.status` and `VerifyOutcome` across `src/` and `test/`. The only caller-side use is `if (outcome.status === 'ok')` inside `verify()` itself (line 190). Controller passes the outcome through as JSON via `@HttpCode(200)` (`custom-domain.controller.ts:66-70`). No missing-case bug.

### Controller surfaces `domain_changed` correctly

`src/landing-pages/custom-domain.controller.ts:66-70`. `verify()` returns the service result as-is; the response shape is `{ page_id, custom_domain, cname_target, outcome: { status: 'domain_changed' }, verified_at: null }`. The client gets a structured signal indistinguishable in transport from `wrong_target`/`nxdomain`/`timeout` — UI can render an actionable "domain changed during verification; retry" message. 200 status is appropriate (not 409) because the underlying request did succeed at the DNS layer; it's the post-DNS stamp that was refused.

### Short-circuit before mutation

Verified: when `stamped.count === 0` the code path runs only `this.logger.warn(...)` and a local-variable assignment before falling through to `return`. No further DB writes, no DNS calls. Idempotent and safe to retry.

### Snapshot pattern race-safety

The new `findUnique` read-back (line 215-218) is read-only and cannot cause incorrect state. The window between `updateMany` and `findUnique` could see another transaction (e.g., a release or a reclaim) change `verified_at` — but the worst case is the response reports `outcome: ok` with `verified_at: null` (release won the race). The actual DB state is correct in all cases. Filed as **P3-13** below.

### Test stub fidelity

The new `updateMany` stub (`test/custom-domain.service.spec.ts:99-117`) and `findUnique` stub (line 121-124) implement the production WHERE semantics correctly. Critically, the `updateMany` stub honours `where.custom_domain` — without that, the TOCTOU test would falsely report a clean pass. Verified by reading the implementation.

---

## v1 P3 re-check

All twelve v1 P3s remain P3 — none were silently promoted to P2 by the refix and none were silently closed.

| ID | File | Status |
| -- | --- | --- |
| P3-1 | `dns-verifier.ts:21` `DNS_LOOKUP_TIMEOUT_MS` not env-configurable | unchanged |
| P3-2 | `custom-domain.service.ts:46` `DOMAIN_RE` admits IPv4-shaped strings | unchanged |
| P3-3 | No reserved-name guard (`trygrowthproject.com` / internal subdomains) | unchanged |
| P3-4 | `release()` find-then-write TOCTOU shape (less severe; release is monotonic) | unchanged — the verify-path version (P2-1) was the load-bearing case and is now fixed |
| P3-5 | `ENODATA` and `ENOTFOUND` both map to `nxdomain` | unchanged |
| P3-6 | `wrong_target` with `targets: []` defensive branch is unreachable in practice | unchanged |
| P3-7 | Stale `verified_at` never invalidated by DNS breakage | unchanged |
| P3-8 | No test for `cnameTarget()` env override path | unchanged |
| P3-9 | No test for "re-claim same coach, different domain" | unchanged |
| P3-10 | Race-condition test is deterministic, not stochastic | unchanged |
| P3-11 | `ConflictException` message reveals domain is claimed | unchanged |
| P3-12 | `DnsVerifier` default-parameter in constructor masks DI breakage | unchanged |

---

## New issues introduced by the refix

### P3-13 (new) — `verify()` response can report `outcome: ok, verified_at: null` if release races the read-back

`src/landing-pages/custom-domain.service.ts:198-219`. The stamp UPDATE (`updateMany`, line 198) and the read-back (`findUnique`, line 215) are not atomic. If `release()` lands between them, the row is wiped: `findUnique` returns `verified_at: null`, but `effectiveOutcome` remains the original `{ status: 'ok', targets: [...] }`. Response shape: `{ outcome: { status: 'ok' }, verified_at: null }`.

- **Real impact:** none on the renderer — the actual DB state correctly reflects "released" and `findPublishedByCustomDomain` will not serve traffic for a row with `verified_at: null`.
- **Client impact:** cosmetic only. UI sees a contradictory response and likely re-issues verify, which will then 400 with `no_domain_bound`. Self-healing.
- **Cheap fix (optional):** stamp `verified_at` to a JS-local `Date` value before the updateMany and use it in the response on `count === 1`, skipping the read-back entirely. Avoids the race and saves a round trip.

Filed as P3 because the actual security and renderer behaviour are correct; only the response shape is briefly inconsistent under a triple-race. The unique-index contract is untouched.

---

## CLEAN BAR sweep on all touched files

Files touched at HEAD relative to `origin/main`:

| File | Status | Audit verdict |
| --- | --- | --- |
| `src/landing-pages/custom-domain.controller.ts` | A | clean |
| `src/landing-pages/custom-domain.service.ts` | A | clean (P3-13 new, cosmetic) |
| `src/landing-pages/dns-verifier.ts` | A | clean |
| `src/landing-pages/landing-pages.module.ts` | M | clean |
| `src/landing-pages/landing-pages.service.ts` | M | clean (P2-2 closed) |
| `test/cname-prisma-client.spec.ts` | A | clean |
| `test/custom-domain.service.spec.ts` | A | clean (+1 TOCTOU test) |
| `test/dns-verifier.spec.ts` | A | clean |
| `test/landing-pages.service.spec.ts` | M | clean (+5 tests) |

Categorical sweep:

- **SSRF.** No new outbound network code in the refix. `dns.promises.resolveCname` is the only egress; bounded by 3s timeout and unchanged from v1.
- **Auth / RBAC.** No new endpoints. `CustomDomainController` retains `@Roles('coach', 'owner')` (line 42) under the global `JwtAuthGuard` + `RolesGuard`. `verify()` and `release()` continue to require `coach_id` match via `findFirst({ where: { id: pageId, coach_id: coachId }})`.
- **Race conditions.** The previously-flagged TOCTOU is closed. The new `updateMany` → `findUnique` pattern introduces only the cosmetic race noted as P3-13. The unique-index contract on `CoachLandingPage.custom_domain` is unchanged.
- **Error swallowing.** The `count === 0` branch logs at `warn` level with page ID and verifying domain in the message — observable. No catch blocks were widened.
- **Missing tests.** P2-2 helper now covered. New TOCTOU branch covered. Five new tests in landing-pages.service.spec.ts + one new test in custom-domain.service.spec.ts.
- **Hardcoded URLs.** `LANDING_CNAME_TARGET` env override preserved with default `cname.trygrowthproject.com`. No new hardcoded hosts.
- **Telemetry.** `warn`-level log on the swap-detect branch carries page ID and verifying domain. Sentry will capture if log level is wired through. No new metric/counter — acceptable for a corner-case branch.
- **P&L holes.** None. `assertProTier` gate is unmoved; verify path is downstream of the claim path which gates on tier.

---

## CI verification

Ran from `/home/user/workspace/tgp/backend-280-audit-v2` (HEAD `414445cc`):

```
$ npx jest --runInBand 2>&1 | tail -3
Test Suites: 252 passed, 252 total
Tests:       16 skipped, 5 todo, 2915 passed, 2936 total
```

Refixer claim of **2915 passing** verified (16 skipped + 5 todo unchanged from v1 baseline).

```
$ npx tsc --noEmit
# (no output — clean)
```

Strict-mode TypeScript clean. The new `domain_changed` variant of `VerifyOutcome` typechecks at every use site; no exhaustive switch broken.

---

## TL;DR

- **P2-1 closed.** `verify()` now snapshots `verifyingDomain` and re-asserts it in `updateMany.where`; no-match emits `{ status: 'domain_changed' }`. Race-window stamp is structurally impossible.
- **P2-2 closed.** Five tests for `findPublishedByCustomDomain` covering the two security gates (`verified_at: { not: null }` and `status: 'published'`) plus normalisation and null safety. Tests would fail if either gate were dropped — verified by reading the stub.
- **No new P0/P1/P2 introduced.** One new P3-13 filed for a cosmetic response-shape race that has no security or renderer impact.
- **CI green: 2915/2915. tsc clean.**

**Verdict: CLEAN — 0 / 0 / 0 / 13. Recommend merge.**
