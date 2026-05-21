// test/entitlement-guards-mounted.spec.ts
//
// Contract test (Rule 29 — contract drift fails build).
//
// Asserts that every controller/handler in the canonical "paid surface" list
// has ClientEntitlementGuard mounted at either the class or handler level.
//
// This protects against a class of regression where a new paid endpoint
// ships without the guard and nothing fails until a real student in
// production hits it without an active package. The failure mode is silent:
// the JwtAuthGuard alone authenticates them, the request succeeds, and we
// give away paid features. PR #245 (SecurityGuardsModule) made the guard
// globally available; this test makes sure controllers actually mount it.
//
// What is in the list:
//   - The 10 paid controllers that already mount the guard (audit Part B).
//   - The 3 P0 gaps the audit identified, fixed in this PR:
//       /insights/holistic, /scheduling/*, /messages/voice-upload.
//   - The Phase 6C voice-upload handler is asserted at the handler level
//     (the rest of /messages is intentionally free — basic DM with a coach
//     is part of the retention path and gating it would block lapsed clients
//     from reading coach outreach).
//
// What is NOT in the list (deliberately):
//   - bloodwork, weight, water, habits, lessons, timeline, leaderboard,
//     recipes, lists, prep-guide, nudges, build-week, first-win. These are
//     student-reachable today with only JwtAuthGuard. Whether each is paid
//     is a product decision tracked separately (see PR description). When
//     product decides, add the controller here AND mount the guard in the
//     same PR — that is the whole point of this contract.

import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ClientEntitlementGuard } from '../src/common/guards/client-entitlement.guard';

import { AiController } from '../src/ai/ai.controller';
import { AiGatewayController } from '../src/ai/gateway/ai-gateway.controller';
import { ClientCheckInsController } from '../src/check-ins/client-check-ins.controller';
import { CommunityController } from '../src/community/community.controller';
import { FastingController } from '../src/fasting/fasting.controller';
import { HolisticInsightsController } from '../src/insights/holistic-insights.controller';
import { LogController } from '../src/log/log.controller';
import { ClientMealPlansController } from '../src/meal-plans/client-meal-plans.controller';
import { ClientMessagingController } from '../src/messaging/client-messaging.controller';
import { SchedulingController } from '../src/scheduling/scheduling.controller';
import { WorkoutController } from '../src/workout/workout.controller';

type AnyCtor = abstract new (...args: never[]) => unknown;

interface PaidRoute {
  readonly controller: AnyCtor;
  // If undefined, the guard is asserted at the class level.
  // If a method name, the guard may be at the class OR handler level.
  readonly handler?: string;
  readonly label: string;
}

const PAID_ROUTES: ReadonlyArray<PaidRoute> = [
  // P0 fixes shipped in this PR.
  { controller: HolisticInsightsController, label: 'GET /insights/holistic' },
  { controller: SchedulingController, label: '/scheduling/* (class-level)' },
  {
    controller: ClientMessagingController,
    handler: 'voiceUpload',
    label: 'POST /messages/voice-upload',
  },

  // Existing paid surfaces — pinned so a future refactor can't silently
  // remove the guard from any of them.
  { controller: AiController, label: '/ai/* (chat, context)' },
  { controller: AiGatewayController, label: '/ai/gateway/invoke' },
  { controller: WorkoutController, label: '/workouts, /routines/*' },
  { controller: ClientMealPlansController, label: '/meal-plans/*' },
  { controller: FastingController, label: '/fasting/*' },
  { controller: LogController, label: '/log/*' },
  { controller: ClientCheckInsController, label: '/check-ins/*' },
  { controller: CommunityController, label: '/community/*' },
];

function hasGuard(
  target: AnyCtor | ((...args: unknown[]) => unknown),
  guard: AnyCtor,
): boolean {
  const guards =
    (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined) ??
    (Reflect.getMetadata('__guards__', target) as unknown[] | undefined) ??
    [];
  return guards.some(
    (g) =>
      g === guard ||
      (typeof g === 'function' && (g as { name?: string }).name === guard.name),
  );
}

function classOrHandlerHasGuard(
  controller: AnyCtor,
  handler: string | undefined,
  guard: AnyCtor,
): boolean {
  if (hasGuard(controller, guard)) return true;
  if (!handler) return false;
  const proto = controller.prototype as Record<string, unknown>;
  const method = proto[handler];
  if (typeof method !== 'function') {
    throw new Error(
      `Handler "${handler}" not found on ${controller.name}. ` +
        `Did the controller method get renamed? Update PAID_ROUTES.`,
    );
  }
  return hasGuard(method as (...args: unknown[]) => unknown, guard);
}

describe('ClientEntitlementGuard — contract: mounted on every paid route', () => {
  for (const route of PAID_ROUTES) {
    it(`mounts ClientEntitlementGuard on ${route.label}`, () => {
      const ok = classOrHandlerHasGuard(
        route.controller,
        route.handler,
        ClientEntitlementGuard,
      );
      if (!ok) {
        const scope = route.handler
          ? `${route.controller.name}.${route.handler}()`
          : `${route.controller.name} (class-level)`;
        throw new Error(
          [
            `ClientEntitlementGuard is NOT mounted on ${route.label}.`,
            ``,
            `Looked for the guard on: ${scope}.`,
            ``,
            `This is a P0 paywall regression. A student with no active`,
            `ClientPurchase can call this endpoint and receive a paid`,
            `feature for free. Either:`,
            `  (a) add @UseGuards(JwtAuthGuard, ClientEntitlementGuard)`,
            `      at the controller class level, or`,
            `  (b) add @UseGuards(JwtAuthGuard, ClientEntitlementGuard)`,
            `      on the specific handler.`,
            ``,
            `If this surface is intentionally free, remove it from`,
            `PAID_ROUTES in test/entitlement-guards-mounted.spec.ts AND`,
            `document the product decision in docs/tier-classification.md.`,
          ].join('\n'),
        );
      }
      expect(ok).toBe(true);
    });
  }
});
