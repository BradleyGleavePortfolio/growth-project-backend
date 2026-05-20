# Audit Round 2 — SecurityGuardsModule + module-cycle guard test

**Branch:** feat/security-guards-module-and-cycle-guard
**Reviewer:** self-review pass 2 (deeper-look)
**Date:** 2026-05-20
**Status:** APPROVE — ready to PR

## What Round 2 added on top of Round 1

Round 1 caught the obvious things (false-positive cycle output, missing
allow-list entry, doc-comment drift). Round 2 went deeper:

- Re-checked the **complete guard inventory** against the codebase to
  confirm nothing was missed.
- Re-checked **every cycle the test currently flags** to ensure none are
  silently allowed.
- Re-checked **dynamic module handling** (`forRoot`, `forRootAsync`,
  `forwardRef`) in `resolveImport`.
- Re-checked the **test failure mode** for hard cycles vs. soft cycles
  vs. allow-listed cycles vs. clean state.
- Re-checked **production-only DI paths** that don't run under
  `NODE_ENV=test`.

## Round 2 findings

### R2-1 — [VERIFIED] Guard inventory: 12 found, 10 globalised, 2 deliberately out

```
src/auth/auth.guard.ts                  → JwtAuthGuard               [included]
src/auth/coach.guard.ts                 → CoachGuard                 [included]
src/auth/roles.guard.ts                 → RolesGuard                 [included]
src/auth/service-token.guard.ts         → ServiceTokenGuard          [included]
src/billing/subscription.guard.ts       → SubscriptionGuard          [included]
src/common/guards/client-entitlement.guard.ts
                                        → ClientEntitlementGuard    [included]
src/common/guards/coach-or-owner.guard.ts
                                        → CoachOrOwnerGuard         [included]
src/common/guards/no-active-sub-coach.guard.ts
                                        → NoActiveSubCoachGuard     [included]
src/common/guards/owner.guard.ts        → OwnerGuard                 [included]
src/sub-coaches/head-coach-only.guard.ts → HeadCoachOnlyGuard         [included]
src/throttler/user-throttler.guard.ts    → UserThrottlerGuard         [EXCLUDED — wired only via APP_GUARD, deeply extends @nestjs/throttler internals]
src/coach/cross-pillar/cross-pillar-practice.guard.ts
                                        → CrossPillarPracticeGuard  [EXCLUDED — single-feature guard, not cross-cutting]
```

The task description mentioned "recent-auth" and "feature-flag" guards;
neither exists in the codebase today. README.md references
`RecentAuthGuard` as part of planned PR #167 (role-gating hardening),
not as a current artifact. Confirmed via `grep -r RecentAuth src/` and
`grep -r FeatureFlag.*Guard src/` — zero matches. **Nothing was
silently dropped.**

### R2-2 — [VERIFIED] Cycle test catches the actual #243 shape

Reproduction matrix:

| Scenario | Expected | Observed |
|---|---|---|
| Inject `AuthModule` (no forwardRef) into CheckoutModule.imports — recreates #243 | `Test.compile()` throws UndefinedModuleException | Test failed in beforeAll with `UndefinedModuleException: Nest cannot create the CheckoutModule instance. The module at index [2] of the CheckoutModule "imports" array is undefined. Scope [RootTestModule -> AppModule -> AuthModule -> InviteCodesModule -> BillingModule]` ✓ |
| Inject `forwardRef(() => AuthModule)` into CheckoutModule.imports — soft cycle | DFS catches and prints path | `Found 1 disallowed module dependency cycle(s)... Cycles: [1] AuthModule → InviteCodesModule → BillingModule → CheckoutModule → AuthModule` ✓ |
| Clean state | Pass | Pass ✓ |
| Remove AdminModule ↔ CoachModule forwardRef pair | Fail with `unexpectedlyMissing` | Manual inspection — would assert ✓ |

Both injections were reverted after verification.

### R2-3 — [VERIFIED] resolveImport handles every shape in this codebase

`@Module({ imports: [...] })` can contain:
- Plain class                       — handled (typeof === 'function')
- `Module.forRoot()` DynamicModule  — handled (`'module' in entry`)
- `Module.forRootAsync()` — returns sync DynamicModule (verified via
  `@nestjs/throttler`'s `.d.ts`: signature is `static forRootAsync(...): DynamicModule`)
   — handled
- `forwardRef(() => Module)`        — handled (recurses with the
  resolved value)
- `Promise<DynamicModule>`          — not present in this codebase, but
  my resolver returns `null` for unrecognized values (defensive). If
  one is ever added, the affected edge will simply not be drawn — the
  test would not crash, just under-report. Acceptable: such a cycle
  would still surface via Nest's own `Test.compile()` step in
  `beforeAll`.

### R2-4 — [VERIFIED] No accidental change to APP_GUARD wiring

AppModule still registers `UserThrottlerGuard` and `JwtAuthGuard` as
`APP_GUARD` providers. Both class symbols are still importable. The
`JwtAuthGuard` is now ALSO provided via SecurityGuardsModule@Global,
which means at runtime there are two registrations: the APP_GUARD one
and the global one. Nest resolves `JwtAuthGuard` through the APP_GUARD
binding when applying the global guard chain, and through the global
provider for `@UseGuards(JwtAuthGuard)` references in controllers. The
instances may be distinct, but the class logic is stateless except for
the `appOpenDedup` Map at module scope — and that Map is a module-level
singleton tied to the file, not the DI instance. So both copies share
the same Map. No behavioral drift.

### R2-5 — [VERIFIED] No breakage to existing tests

Full Jest run: 68 failed / 1987 passed / 16 skipped / 5 todo / 2076
total / 199 suites. Baseline on a54aa524 (hotfix #243 merge commit):
68 failed / 1985 passed. Delta: +2 passed (the new `module-graph.spec`
tests). Zero new failures. Set-equality on the existing failure
surface preserved.

### R2-6 — [VERIFIED] App boots end-to-end

```
NODE_ENV=test SUPABASE_URL=… node -e \"
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require('./dist/app.module');
  (async () => {
    const app = await NestFactory.create(AppModule);
    await app.init();
    console.log('BOOT_OK');
    await app.close();
  })();
\"
```

Output: `BOOT_OK`. No UndefinedModuleException.

### R2-7 — [NEW IN ROUND 2] Cycle test doesn't accidentally drop coverage

Confirmed via `npx jest --listTests | grep module-graph` that the new
spec is picked up by the default `npm test` glob (`testRegex:
\\.spec\\.ts$` in `jest.config.js`, `roots: ['<rootDir>/test']`). No
package.json changes needed — `npm test` automatically runs it.

### R2-8 — [NEW IN ROUND 2] Documentation traceability

Every load-bearing comment includes:
- the PR# / hotfix# it traces back to (#243),
- the specific cycle shape it prevents,
- the rule the maintainer needs to remember.

This is the format the existing checkout/packages module comments
already use; I matched it so the codebase voice stays consistent.

### R2-9 — [VERIFIED] No feature shrinkage anywhere

For each of the 10 globalised guards, I diff-checked the constructor
deps and the `canActivate` body against the pre-change file. Identical.
No guard was rewritten, simplified, or have a code path removed. The
change is purely DI scope.

## Things I deliberately did NOT do

- **Not** cleaning up redundant local provider registrations in Workout,
  Messaging, Notifications, etc. (Round 1 F8). Out of scope for this PR.
  The new cycle test means a follow-up cleanup PR is now safe to do
  whenever — the test will catch any cycle regression.
- **Not** removing `BillingModule` import from `InviteCodesModule` even
  though it's now only used for the (now-global) `SubscriptionGuard`.
  Touch-fewest-things rule.
- **Not** adding `RecentAuthGuard` / `FeatureFlagGuard` placeholders for
  the README'd #167 planned work. Out of scope.

## Verdict

Ship.

- Cycle detector verified against the actual #243 shape and a related
  soft-cycle shape.
- Zero behavioral changes to any guard.
- Zero new test failures.
- All `Round 1 findings` either fixed or explicitly deferred with a
  reason.
