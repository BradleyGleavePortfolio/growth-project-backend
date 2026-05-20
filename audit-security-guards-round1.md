# Audit Round 1 — SecurityGuardsModule + module-cycle guard test

**Branch:** feat/security-guards-module-and-cycle-guard
**Reviewer:** self-review pass 1
**Date:** 2026-05-20
**Status:** APPROVE WITH FOLLOW-UPS (8 findings — see below; all addressed before round 2)

## Scope

1. New `@Global()` `SecurityGuardsModule` consolidating cross-cutting guards.
2. New `test/module-graph.spec.ts` cycle-detection Jest spec.
3. Companion edits to AppModule, AuthModule, CheckoutModule, PackagesModule,
   BillingModule, InviteCodesModule, V1Module that:
   - drop now-redundant local guard providers; and
   - update doc comments to point at the new global module.

## What I checked

- **Feature shrinkage**: are any guard behaviors weakened?
- **Cycle detector correctness**: does it actually walk the real graph?
  Does it catch the #243 cycle? Does it have false negatives or false
  positives?
- **`@Global()` correctness**: does the new module break any module-scoped
  DI? Any test that overrides a guard at module scope?
- **Backwards compatibility**: does any test rely on AuthModule exporting
  `JwtAuthGuard` / `JwksVerifierService`?
- **AppModule load order**: is SecurityGuardsModule loaded before its
  dependents?
- **Concurrency / runtime instance identity**: does the global registration
  cause duplicate instances of any guard?

## Findings

### F1 — [CONFIRMED OK] Feature shrinkage: none

Each of the 10 guards is still constructed with the exact same constructor
deps as before. `SubscriptionGuard` retains its `@Optional() analytics`,
its tier/grace logic, its observe-vs-enforce branch. `JwtAuthGuard` retains
the GDPR scheduled-deletion gate, the `@Public()` opt-out, and the
4-hour-per-user `app_open` dedup. `ClientEntitlementGuard` retains the
`@SkipClientEntitlement()` opt-out and the 402 PAYMENT_REQUIRED. No
behavior change was made — only the DI scope (local → global) moved.

### F2 — [FIXED IN ROUND 1] Cycle detector: walked wrong graph initially

First implementation walked `container.getModules()` and read
`Module.imports` directly. That Set is populated by Nest's
`bindGlobalsToImports()` which injects every `@Global()` module into
every other module's import set — producing 347 false-positive cycles
during the first run.

**Fix applied**: switched to reading
`Reflect.getMetadata(MODULE_METADATA.IMPORTS, ModuleClass)`, which
returns the original developer-written imports array. Manually unwrap
`forwardRef()` and `DynamicModule` shapes. Container compile still runs
in `beforeAll` so a hard cycle that crashes `Test.compile()` still
fails the test.

Verified by temporarily injecting `forwardRef(() => AuthModule)` into
CheckoutModule's imports — the test correctly reported:
> Cycles: [1] AuthModule → InviteCodesModule → BillingModule → CheckoutModule → AuthModule

Reverted the injection.

### F3 — [CONFIRMED OK] Hard-cycle detection still works

Even though the DFS uses static metadata, the test's `beforeAll` runs
`Test.createTestingModule({ imports: [AppModule] }).compile()` first.
A hard cycle like the original #243 (without `forwardRef`) throws
`UndefinedModuleException` from Nest's own scanner before DFS executes
— the test fails in `beforeAll` with the exact same error message
production saw. Verified by injecting `AuthModule` (no forwardRef) into
CheckoutModule: test failed in beforeAll with the #243-shape error.

### F4 — [FIXED IN ROUND 1] AdminModule ↔ CoachModule cycle is intentional

That forwardRef'd pair is documented at the import sites. Allowed via
`KNOWN_FORWARDREF_CYCLES`. The test also asserts the cycle is STILL
present (`unexpectedlyMissing` check) so if a refactor breaks the
intentional cycle the stale comments are surfaced.

### F5 — [CONFIRMED OK] `@Global()` does not break module-scoped DI

Reviewed test/billing/, test/checkout/, test/packages/, test/auth/ —
no test passes a guard via `useValue` / `useClass` at module scope.
Tests instantiate guards directly (e.g.
`new SubscriptionGuard(prisma, reflector, analytics)`) — these are not
DI-scoped instantiations and are unaffected by the global registration.

### F6 — [CONFIRMED OK] AuthModule still works without guards in providers

AuthService deps: Prisma, InviteCodes, Analytics, Audit, AppleVerifier —
none of these are guards. AuthController uses `@UseGuards(JwtAuthGuard)`
which resolves through the @Global SecurityGuardsModule.

Verified: `nest build` clean, `node` boot-test shows AppModule
initializes without throwing.

### F7 — [FIXED IN ROUND 1] AppModule load order

SecurityGuardsModule is registered AFTER `PrismaModule` /
`AnalyticsModule` / `PtmModule` (its guard providers' deps) but BEFORE
`AuthModule` and every feature module (which use the guards via
`@UseGuards()`). Verified visually in the imports array.

The `@Global()` modifier means order is technically not load-bearing for
DI scope, but keeping it before AuthModule matches reader expectation
and avoids ambiguity if `@Global()` is ever removed.

### F8 — [DEFERRED, NOT BLOCKING] Duplicate provider registrations

Several feature modules (Workout, WorkoutBuilder, MealPlans, Messaging,
Notifications, Macros, Insights, RealMealPlans, …) still locally
register `JwtAuthGuard, CoachGuard, JwksVerifierService` as providers.
With the @Global module providing them, Nest will create a per-module
instance that shadows the global one. That's behavior-preserving (the
guard runs per-request via the local instance, with identical logic)
but redundant.

**Decision**: Do NOT mass-clean those in this PR. Reasoning:
- It is outside the minimum-change footprint of this PR's stated objective.
- A separate cleanup PR (smaller blast radius, easier review) is safer.
- The new cycle test will catch any cycle that re-emerges if the cleanup
  is botched.
- The hotfix #243 commit added these as a temporary local workaround;
  removing them all at once is a refactor that should be deliberate.

### F9 — [CONFIRMED OK] Test runtime cost

`module-graph.spec.ts` runtime: ~9s. Acceptable for a guard test that
runs once per CI invocation.

## What was changed between drafts (Round 1 fixes summarized)

1. Rewrote cycle detector to read `@Module()` metadata (F2) — eliminated
   ~347 false positives caused by Nest's global-broadcast edges.
2. Added the AdminModule↔CoachModule allow-list entry with a comment
   pointing at the import sites (F4).
3. Confirmed AppModule import ordering with a comment explaining the
   load-bearing position (F7).
4. Added comments at the test's `KNOWN_FORWARDREF_CYCLES` and at
   SecurityGuardsModule's docstring explicitly calling out the
   "imports nothing" invariant (so future maintainers understand
   the rule that prevents the next #243).
5. Added explicit deny path messaging that mirrors the hotfix #243
   PR description, so the CI log is actionable.

## Open items going into Round 2

- Verify that the test fails LOUDLY in CI (not just locally) — add to
  PR description so reviewer can confirm on PR CI run.
- Round 2 needs to confirm: are there any other guards or guard-adjacent
  services in the codebase that SHOULD live in SecurityGuardsModule
  but I missed? (e.g. is there a "RecentAuthGuard" mentioned in the
  spec that doesn't exist yet — should the module have a TODO?).
- Round 2 needs to confirm: does the test handle the case where
  a future @Global module imports a non-global feature module
  cyclically? (Reflect.getMetadata reads the original `imports:`
  array regardless of `@Global()` — yes, handled.)
