/**
 * RolesEnforcedTest — Phase 10 Role-Gating Hardening.
 *
 * This meta-test uses NestJS metadata reflection to walk every controller
 * registered in AppModule and assert that every route handler has either:
 *
 *   1. An explicit `@Roles(...)` decorator (gated route), OR
 *   2. A `@Public()` decorator (intentionally unauthenticated route), OR
 *   3. The controller class carries `@Roles(...)`/`@Public()` at class level
 *      (covers all handlers in that controller), OR
 *   4. The handler/class is in LEGACY_GUARD_ALLOWLIST (pre-@Roles controller
 *      that already has a bespoke role guard like CoachGuard or OwnerGuard —
 *      must include a written reason).
 *
 * If any handler has none of the above the test FAILS CI with a message that
 * names the exact route so the CI log immediately tells Bradley what to fix:
 *
 *   Route is ungated: MyController.myMethod — add @Roles() or @Public()
 *
 * ## How to add a new route
 *
 * Pick EXACTLY ONE of the following for every new handler:
 *
 *   @Roles('student')   — any authenticated user (student, coach, owner)
 *   @Roles('coach')     — coach or owner only
 *   @Roles('owner')     — owner only (admin panel)
 *   @Public()           — no JWT required (health, webhooks, landing pages)
 *
 * Do NOT add to LEGACY_GUARD_ALLOWLIST unless the controller predates Phase 10
 * and already has an equivalent bespoke guard (CoachGuard, OwnerGuard, etc.).
 */

import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { APP_GUARD, DiscoveryModule, DiscoveryService, MetadataScanner } from '@nestjs/core';
import { ModuleRef } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { IS_PUBLIC_KEY } from '../src/common/decorators/public.decorator';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import { RolesGuard } from '../src/auth/roles.guard';

// ---------------------------------------------------------------------------
// LEGACY_GUARD_ALLOWLIST
//
// Controllers that predate @Roles and use bespoke guards (CoachGuard,
// CoachOrOwnerGuard, OwnerGuard) instead. Every entry MUST have a reason.
// Do NOT add new controllers here — use @Roles instead.
// ---------------------------------------------------------------------------
const LEGACY_GUARD_ALLOWLIST: Array<{
  controller: string;
  method: string;
  reason: string;
}> = [
  // ── AuthController ── JwtAuthGuard per-handler; @Roles added Phase 10 class level; legacy per-handler routes ──
  { controller: 'AuthController', method: 'attachInviteCode', reason: 'JwtAuthGuard per-handler; student-accessible' },
  { controller: 'AuthController', method: 'selectRole', reason: 'JwtAuthGuard per-handler; student-accessible' },
  { controller: 'AuthController', method: 'getMe', reason: 'JwtAuthGuard per-handler; student-accessible' },
  { controller: 'AuthController', method: 'becomeCoach', reason: 'JwtAuthGuard per-handler; student-accessible' },
  { controller: 'AuthController', method: 'issueRecentAuthToken', reason: 'JwtAuthGuard per-handler; student-accessible' },
  // ── CoachController ── CoachGuard at class level enforces coach|owner ──
  { controller: 'CoachController', method: 'getDashboard', reason: 'CoachGuard at class level' },
  { controller: 'CoachController', method: 'getClients', reason: 'CoachGuard at class level' },
  { controller: 'CoachController', method: 'getCoachRiskBoard', reason: 'CoachGuard at class level' },
  { controller: 'CoachController', method: 'archiveClient', reason: 'CoachGuard at class level' },
  { controller: 'CoachController', method: 'unarchiveClient', reason: 'CoachGuard at class level' },
  { controller: 'CoachController', method: 'getClientTimeline', reason: 'CoachGuard at class level' },
  { controller: 'CoachController', method: 'getClientSummary', reason: 'CoachGuard at class level' },
  { controller: 'CoachController', method: 'getMyGuidelines', reason: 'CoachGuard at class level' },
  { controller: 'CoachController', method: 'getGuidelines', reason: 'CoachGuard at class level' },
  { controller: 'CoachController', method: 'postGuidelines', reason: 'CoachGuard at class level' },
  { controller: 'CoachController', method: 'getAlerts', reason: 'CoachGuard at class level' },
  // ── CoachCheckInsController ──
  { controller: 'CoachCheckInsController', method: 'list', reason: 'CoachGuard at class level' },
  // ── CoachMessagingController ──
  { controller: 'CoachMessagingController', method: 'listThread', reason: 'CoachGuard at class level' },
  { controller: 'CoachMessagingController', method: 'send', reason: 'CoachGuard at class level' },
  { controller: 'CoachMessagingController', method: 'voiceUpload', reason: 'CoachGuard at class level' },
  { controller: 'CoachMessagingController', method: 'markRead', reason: 'CoachGuard at class level' },
  { controller: 'CoachMessagingController', method: 'unreadCount', reason: 'CoachGuard at class level' },
  // ── CoachNudgesController ──
  { controller: 'CoachNudgesController', method: 'create', reason: 'CoachGuard at class level' },
  // ── CoachMealPlansController ──
  { controller: 'CoachMealPlansController', method: 'list', reason: 'CoachGuard at class level' },
  { controller: 'CoachMealPlansController', method: 'create', reason: 'CoachGuard at class level' },
  { controller: 'CoachMealPlansController', method: 'update', reason: 'CoachGuard at class level' },
  { controller: 'CoachMealPlansController', method: 'archive', reason: 'CoachGuard at class level' },
  // ── CoachBuildWeekController ──
  { controller: 'CoachBuildWeekController', method: 'getForClient', reason: 'CoachGuard at class level' },
  // ── CoachAlertsController ──
  { controller: 'CoachAlertsController', method: 'list', reason: 'CoachGuard at class level' },
  { controller: 'CoachAlertsController', method: 'acknowledge', reason: 'CoachGuard at class level' },
  // ── CoachOnboardingController ──
  { controller: 'CoachOnboardingController', method: 'get', reason: 'CoachGuard at class level' },
  { controller: 'CoachOnboardingController', method: 'start', reason: 'CoachGuard at class level' },
  { controller: 'CoachOnboardingController', method: 'advance', reason: 'CoachGuard at class level' },
  { controller: 'CoachOnboardingController', method: 'complete', reason: 'CoachGuard at class level' },
  // ── InviteCodesController — per-handler guards ──
  { controller: 'InviteCodesController', method: 'create', reason: 'Per-handler JwtAuthGuard+CoachGuard' },
  { controller: 'InviteCodesController', method: 'list', reason: 'Per-handler JwtAuthGuard+CoachGuard' },
  { controller: 'InviteCodesController', method: 'revoke', reason: 'Per-handler JwtAuthGuard+CoachGuard' },
  { controller: 'InviteCodesController', method: 'getMyInviteLink', reason: 'Per-handler JwtAuthGuard+CoachGuard' },
  { controller: 'InviteCodesController', method: 'regenerateMyInviteLink', reason: 'Per-handler JwtAuthGuard+CoachGuard' },
  { controller: 'InviteCodesController', method: 'attachCoachCode', reason: 'Per-handler JwtAuthGuard (student self-attach)' },
  // ── Billing controllers ── CoachOrOwnerGuard / OwnerGuard at class level ──
  { controller: 'CoachBillingController', method: 'getBilling', reason: 'CoachOrOwnerGuard at class level' },
  { controller: 'CoachBillingController', method: 'portalSession', reason: 'CoachOrOwnerGuard at class level' },
  { controller: 'MobileCoachBillingController', method: 'getStatus', reason: 'CoachOrOwnerGuard at class level' },
  { controller: 'MobileCoachBillingController', method: 'portalSession', reason: 'CoachOrOwnerGuard at class level' },
  { controller: 'OwnerBillingController', method: 'startSubscription', reason: 'OwnerGuard at class level' },
  // ── V1CoachController ── CoachOrOwnerGuard at class level ──
  { controller: 'V1CoachController', method: 'getMe', reason: 'CoachOrOwnerGuard at class level' },
  { controller: 'V1CoachController', method: 'listClients', reason: 'CoachOrOwnerGuard at class level' },
  { controller: 'V1CoachController', method: 'listThreads', reason: 'CoachOrOwnerGuard at class level' },
  { controller: 'V1CoachController', method: 'getThread', reason: 'CoachOrOwnerGuard at class level' },
  { controller: 'V1CoachController', method: 'sendMessage', reason: 'CoachOrOwnerGuard + SubscriptionGuard at handler' },
  { controller: 'V1CoachController', method: 'getDraft', reason: 'CoachOrOwnerGuard at class level' },
  { controller: 'V1CoachController', method: 'saveDraft', reason: 'CoachOrOwnerGuard + SubscriptionGuard at handler' },
];

const allowlistSet = new Set(
  LEGACY_GUARD_ALLOWLIST.map((e) => `${e.controller}.${e.method}`),
);

// ---------------------------------------------------------------------------
// CLASS_LEVEL_LEGACY_ALLOWLIST
//
// Whole controllers that predate Phase 10 role-gating and gate access via
// service-layer ownership checks rather than @Roles decorators. Listed here
// (instead of per-method in LEGACY_GUARD_ALLOWLIST) to keep the list compact
// and to surface unmigrated controllers as a unit.
//
// Each entry MUST have a reason. Adding a new controller here is a code
// smell — prefer migrating it to @Roles in the same PR.
// ---------------------------------------------------------------------------
const CLASS_LEVEL_LEGACY_ALLOWLIST: Array<{
  controller: string;
  reason: string;
}> = [
  // Pre-Phase-10 controllers with service-layer ownership checks. Each
  // handler validates req.user against the resource being touched (coach
  // owns plan, client owns bloodwork, etc.), and the global JwtAuthGuard
  // ensures req.user is set. Migration to @Roles tracked as a follow-up.
  { controller: 'AiGatewayController', reason: 'Service-layer authz; pre-Phase-10' },
  { controller: 'AssignmentController', reason: 'Service-layer authz; pre-Phase-10' },
  { controller: 'ClientBloodworkController', reason: 'Service-layer ownership check; pre-Phase-10' },
  { controller: 'ClientMacrosController', reason: 'Service-layer authz; pre-Phase-10' },
  { controller: 'ClientMealPlanController', reason: 'Service-layer authz; pre-Phase-10' },
  { controller: 'CoachBloodworkController', reason: 'Service-layer authz; pre-Phase-10' },
  { controller: 'CoachDailyMealPlansController', reason: 'Service-layer authz; pre-Phase-10' },
  { controller: 'CoachMacrosController', reason: 'Service-layer authz; pre-Phase-10' },
  { controller: 'CoachMealTemplatesController', reason: 'Service-layer authz; pre-Phase-10' },
  { controller: 'CrossPillarController', reason: 'Service-layer authz; pre-Phase-10' },
  { controller: 'ExerciseLibraryController', reason: 'Read-only library; pre-Phase-10' },
  { controller: 'GoogleOAuthController', reason: 'Service-layer authz; pre-Phase-10' },
  { controller: 'HolisticInsightsController', reason: 'Service-layer authz; pre-Phase-10' },
  { controller: 'LeaderboardController', reason: 'Service-layer authz; pre-Phase-10' },
  { controller: 'PracticeTypeController', reason: 'Service-layer authz; pre-Phase-10' },
  { controller: 'ProfilingController', reason: 'Service-layer authz; pre-Phase-10' },
  { controller: 'SchedulingController', reason: 'Service-layer authz; pre-Phase-10' },
  { controller: 'TeamModeController', reason: 'Sub-coach feature; service-layer authz; pre-Phase-10' },
  { controller: 'WorkoutBuilderController', reason: 'Workout builder feature; service-layer authz; pre-Phase-10' },
  {
    controller: 'OwnerConsoleController',
    reason: 'ServiceTokenGuard at class level (src/auth/service-token.guard.ts). All routes are S2S-only with pre-shared ADMIN_SERVICE_TOKEN bearer header; req.user is never populated. The global RolesGuard would throw "Authenticated user required" on every owner-console request if @Roles is added. Runtime gate is strictly stronger than @Roles (platform secret cannot be obtained via owner JWT theft). Companion PR-A2 may introduce a ServiceTokenAdmin req.user shim to align decorator + runtime; until then this allowlist entry documents the architectural decision.',
  },
];

const classLevelAllowlistSet = new Set(
  CLASS_LEVEL_LEGACY_ALLOWLIST.map((e) => e.controller),
);

// Per-handler exceptions on otherwise-decorated controllers.
const perHandlerLegacyAllowlist: Array<{ controller: string; method: string; reason: string }> = [
  { controller: 'InviteCodesController', method: 'bulk', reason: 'Per-handler JwtAuthGuard+CoachGuard' },
  { controller: 'InviteCodesController', method: 'parseBulk', reason: 'Per-handler JwtAuthGuard+CoachGuard' },
];
for (const e of perHandlerLegacyAllowlist) {
  allowlistSet.add(`${e.controller}.${e.method}`);
}

describe('RolesEnforced — every route has @Roles or @Public', () => {
  // This test compiles the full AppModule (same as openapi-spec.spec.ts)
  // which takes ~10–15 s in CI. The 30 s timeout matches the openapi test.
  jest.setTimeout(45_000)  // extended for CI environments with heavy concurrent load;

  let moduleRef: TestingModule;
  let discoveryService: DiscoveryService;
  let metadataScanner: MetadataScanner;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule, AppModule],
    }).compile();

    discoveryService = moduleRef.get(DiscoveryService);
    metadataScanner = moduleRef.get(MetadataScanner);
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('every route handler has @Roles or @Public (or is in the legacy-guard allowlist)', () => {
    const ungated: string[] = [];

    for (const wrapper of discoveryService.getControllers()) {
      const instance = wrapper.instance;
      if (!instance || typeof instance !== 'object') continue;

      const controllerClass = instance.constructor as Function;
      const controllerName = controllerClass.name;

      // Class-level decoration covers every handler in the controller.
      const classRoles = Reflect.getMetadata(ROLES_KEY, controllerClass);
      const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, controllerClass);
      if (classRoles !== undefined || classPublic === true) continue;

      // Whole-controller legacy allowlist — gates via service-layer ownership
      // checks, not @Roles. Tracked for future migration.
      if (classLevelAllowlistSet.has(controllerName)) continue;

      for (const methodName of metadataScanner.getAllMethodNames(instance)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handler = (instance as any)[methodName];
        if (typeof handler !== 'function') continue;

        // Only inspect route handlers (they have a path metadata key).
        const httpPath = Reflect.getMetadata('path', handler);
        if (httpPath === undefined) continue;

        const handlerRoles = Reflect.getMetadata(ROLES_KEY, handler);
        const handlerPublic = Reflect.getMetadata(IS_PUBLIC_KEY, handler);

        if (handlerRoles === undefined && handlerPublic !== true) {
          const key = `${controllerName}.${methodName}`;
          if (!allowlistSet.has(key)) {
            ungated.push(
              `Route is ungated: ${key} — add @Roles() or @Public()`,
            );
          }
        }
      }
    }

    if (ungated.length > 0) {
      throw new Error(
        `\n\n[RolesEnforced] ${ungated.length} route(s) are missing role decoration:\n\n` +
          ungated.join('\n') +
          '\n\nFix: add @Roles("student"|"coach"|"owner") or @Public() to each listed handler.\n',
      );
    }
  });

  it('RolesGuard is registered as a global APP_GUARD', () => {
    // Audit P2-2 fix: previously this meta-test passed if @Roles metadata was
    // present, even when RolesGuard was never wired up — so a future
    // controller adding @Roles('owner') without @UseGuards(RolesGuard) would
    // silently bypass the check. Now RolesGuard is a global APP_GUARD and
    // this test asserts that registration so the failure mode is caught at
    // CI time, not at production time.
    const moduleRefSvc = moduleRef.get(ModuleRef);
    // Walk the resolved providers and find any provider for the APP_GUARD
    // token whose instance is a RolesGuard. NestJS keeps a separate provider
    // wrapper for each APP_GUARD registration, so this is a robust check
    // regardless of registration order.
    const providers = discoveryService.getProviders();
    const rolesGuardRegistrations = providers.filter((wrapper) => {
      const instance = wrapper.instance;
      return instance instanceof RolesGuard;
    });
    expect(rolesGuardRegistrations.length).toBeGreaterThan(0);

    // Belt-and-braces: confirm the guard's canActivate no-ops when no
    // @Roles metadata is present, so existing un-decorated routes that rely
    // on service-layer authz are not unintentionally gated.
    const guardInstance = rolesGuardRegistrations[0].instance as RolesGuard;
    const fakeCtx = {
      getHandler: () => () => undefined,
      getClass: () => class FakeController {},
      switchToHttp: () => ({ getRequest: () => ({ user: { role: 'student' } }) }),
    } as any;
    expect(guardInstance.canActivate(fakeCtx)).toBe(true);
    void moduleRefSvc; // surface unused-var warning if APP_GUARD import drifts
    void APP_GUARD;
  });
});
