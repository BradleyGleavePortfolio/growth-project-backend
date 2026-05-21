import { Global, Module } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { JwksVerifierService } from '../../auth/jwks.service';
import { RolesGuard } from '../../auth/roles.guard';
import { CoachGuard } from '../../auth/coach.guard';
import { ServiceTokenGuard } from '../../auth/service-token.guard';
import { SubscriptionGuard } from '../../billing/subscription.guard';
import { CoachOrOwnerGuard } from '../guards/coach-or-owner.guard';
import { OwnerGuard } from '../guards/owner.guard';
import { ClientEntitlementGuard } from '../guards/client-entitlement.guard';
import { NoActiveSubCoachGuard } from '../guards/no-active-sub-coach.guard';
import { HeadCoachOnlyGuard } from '../../sub-coaches/head-coach-only.guard';

/**
 * SecurityGuardsModule — single source of DI scope for every cross-cutting
 * NestJS guard in the codebase.
 *
 * ## Why this exists
 *
 * Hotfix #243 (prod-down, 2026-05-20) traced a boot-time UndefinedModuleException
 * to two interlocking module cycles:
 *
 *   Cycle 1: AuthModule → InviteCodesModule → BillingModule
 *            → CheckoutModule → AuthModule
 *   Cycle 2: CheckoutModule → PackagesModule → BillingModule → CheckoutModule
 *
 * Both arose from the same shape: feature modules importing the heavy
 * `AuthModule` *only* to put `JwtAuthGuard` / `RolesGuard` / `ServiceTokenGuard`
 * into local DI scope so `@UseGuards(JwtAuthGuard)` decorators could resolve.
 * `AuthModule` itself transitively depends on those feature modules through
 * `AuthService → InviteCodesService → BillingService → CheckoutService`, so
 * the import edge closed a cycle and Nest evaluated `imports[0]` to `undefined`.
 *
 * The hotfix unwound the *specific* cycles by having `CheckoutModule` and
 * `PackagesModule` provide guards locally instead. But the *prevention*
 * mechanism — a canonical place to obtain guards that has zero feature-module
 * imports — was never built. Every new feature module that uses
 * `@UseGuards(...)` re-creates the cycle risk.
 *
 * This module is that prevention mechanism.
 *
 * ## Invariants
 *
 * 1. `@Global()` — any module can use the guards in `@UseGuards(...)` without
 *    listing this module among its imports. Single-source-of-truth DI.
 *
 * 2. `imports: []` — this module imports **no feature modules**. It must
 *    never grow an import on `AuthModule`, `BillingModule`, or any other
 *    feature module. Doing so would re-open the cycle risk it exists to
 *    close. Every guard's constructor dependencies must resolve through
 *    Nest's *global* providers: `PrismaService` (PrismaModule@Global),
 *    `Reflector` (NestJS core), `AnalyticsService` (AnalyticsModule@Global),
 *    `PtmService` (PtmModule@Global), and the colocated `JwksVerifierService`.
 *
 * 3. Loaded **first** in AppModule (before AuthModule and every feature
 *    module) so that every consumer sees the guards already in DI scope.
 *
 * 4. The module-cycle Jest spec (`test/module-graph.spec.ts`) walks the
 *    Nest container at boot and fails the build if any directed import
 *    cycle exists. CI runs it on every PR.
 *
 * ## What lives here (and why)
 *
 * Cross-cutting guards mounted via `@UseGuards(...)` from many feature
 * controllers:
 *
 *   - `JwtAuthGuard`          — global APP_GUARD; route-level uses are common
 *   - `RolesGuard`            — paired with `@Roles(...)` decorator
 *   - `CoachGuard`            — narrow coach-or-owner check (legacy form)
 *   - `CoachOrOwnerGuard`     — modern coach OR owner check
 *   - `OwnerGuard`            — owner-only (platform admin)
 *   - `ServiceTokenGuard`     — server-to-server tokens for SSR callers
 *   - `ClientEntitlementGuard`— student paywall (402 PAYMENT_REQUIRED)
 *   - `SubscriptionGuard`     — coach SaaS tier + status enforcement
 *   - `NoActiveSubCoachGuard` — sub-coaches blocked from billing surfaces
 *   - `HeadCoachOnlyGuard`    — only the head coach can mutate team structure
 *
 * Plus the colocated `JwksVerifierService` because `JwtAuthGuard` needs it
 * and it has zero other feature-module deps (it talks to Supabase's JWKS
 * endpoint via `jose`). Keeping the verifier in the same DI scope as the
 * guard is the cleanest way to guarantee both load together.
 *
 * ## What does NOT live here
 *
 *   - `UserThrottlerGuard` — wired only via `APP_GUARD` in AppModule;
 *     extends `@nestjs/throttler` and needs that module's internals
 *     resolved by Nest's own wiring. No feature controller mounts it
 *     directly via `@UseGuards(...)`.
 *   - `CrossPillarPracticeGuard` — single-feature guard living in
 *     `src/coach/cross-pillar/`. Not cross-cutting; not worth promoting.
 *
 * ## Migration notes
 *
 * `AuthModule` continues to provide `AuthService` and `AppleVerifierService`
 * (its non-guard surface). It no longer needs to provide or export
 * `JwtAuthGuard` / `JwksVerifierService` — those are global. Existing
 * `AuthModule` consumers that imported it only for the guards can drop
 * the import entirely.
 *
 * Feature modules previously providing guards locally (Checkout, Packages,
 * InviteCodes, Billing, Connect, …) have those local registrations removed.
 * Guard *class symbols* are still imported for `@UseGuards(...)` decorators
 * — only the provider registrations move.
 */
@Global()
@Module({
  imports: [],
  providers: [
    JwksVerifierService,
    JwtAuthGuard,
    RolesGuard,
    CoachGuard,
    CoachOrOwnerGuard,
    OwnerGuard,
    ServiceTokenGuard,
    ClientEntitlementGuard,
    SubscriptionGuard,
    NoActiveSubCoachGuard,
    HeadCoachOnlyGuard,
  ],
  exports: [
    JwksVerifierService,
    JwtAuthGuard,
    RolesGuard,
    CoachGuard,
    CoachOrOwnerGuard,
    OwnerGuard,
    ServiceTokenGuard,
    ClientEntitlementGuard,
    SubscriptionGuard,
    NoActiveSubCoachGuard,
    HeadCoachOnlyGuard,
  ],
})
export class SecurityGuardsModule {}
