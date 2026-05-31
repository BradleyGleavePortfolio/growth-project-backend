// test/real-meal-plans-guards.spec.ts
//
// Guard-placement contract for the real-meal-plans coach controllers.
//
// H5 hoisted the per-handler @UseGuards(JwtAuthGuard, CoachGuard,
// SubscriptionGuard) stack — previously repeated on every handler — up to
// the class level on CoachMealTemplatesController and
// CoachDailyMealPlansController. The whole point of that refactor is that
// the effective guard set on every route stays IDENTICAL, and that a 13th
// handler added later inherits the stack instead of silently shipping
// unguarded.
//
// This spec pins both facts:
//   1. The class-level guard stack is exactly {JwtAuthGuard, CoachGuard,
//      SubscriptionGuard} on each coach controller (so a future refactor
//      that drops or broadens it fails loudly).
//   2. Every existing handler is still effectively protected by all three
//      guards (class-level metadata covers every method on the prototype).
//   3. ClientMealPlanController keeps its own {JwtAuthGuard,
//      ClientEntitlementGuard} stack — untouched by this refactor.

import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';

import { JwtAuthGuard } from '../src/auth/auth.guard';
import { CoachGuard } from '../src/auth/coach.guard';
import { SubscriptionGuard } from '../src/billing/subscription.guard';
import { ClientEntitlementGuard } from '../src/common/guards/client-entitlement.guard';
import {
  ClientMealPlanController,
  CoachDailyMealPlansController,
  CoachMealTemplatesController,
} from '../src/real-meal-plans/real-meal-plans.controller';

type AnyCtor = abstract new (...args: never[]) => unknown;

function guardNames(
  target: AnyCtor | ((...args: unknown[]) => unknown),
): string[] {
  const guards =
    (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined) ??
    (Reflect.getMetadata('__guards__', target) as unknown[] | undefined) ??
    [];
  return guards.map((g) =>
    typeof g === 'function' ? (g as { name?: string }).name ?? '' : String(g),
  );
}

// The handlers that existed (and were individually guarded) before the hoist.
const TEMPLATE_HANDLERS = ['create', 'list', 'get', 'update', 'archive'];
const DAILY_PLAN_HANDLERS = [
  'create',
  'list',
  'get',
  'update',
  'archive',
  'assign',
  'listAssignments',
];

describe('real-meal-plans — coach guard stack hoisted to class level', () => {
  describe('CoachMealTemplatesController', () => {
    it('mounts JwtAuthGuard, CoachGuard, SubscriptionGuard at the class level', () => {
      const names = guardNames(CoachMealTemplatesController);
      expect(names).toEqual([
        JwtAuthGuard.name,
        CoachGuard.name,
        SubscriptionGuard.name,
      ]);
    });

    it('does NOT duplicate the stack on any handler (class-level only)', () => {
      const proto = CoachMealTemplatesController.prototype as unknown as Record<
        string,
        unknown
      >;
      for (const h of TEMPLATE_HANDLERS) {
        const method = proto[h];
        expect(typeof method).toBe('function');
        expect(guardNames(method as (...args: unknown[]) => unknown)).toEqual(
          [],
        );
      }
    });
  });

  describe('CoachDailyMealPlansController', () => {
    it('mounts JwtAuthGuard, CoachGuard, SubscriptionGuard at the class level', () => {
      const names = guardNames(CoachDailyMealPlansController);
      expect(names).toEqual([
        JwtAuthGuard.name,
        CoachGuard.name,
        SubscriptionGuard.name,
      ]);
    });

    it('does NOT duplicate the stack on any handler (class-level only)', () => {
      const proto = CoachDailyMealPlansController.prototype as unknown as Record<
        string,
        unknown
      >;
      for (const h of DAILY_PLAN_HANDLERS) {
        const method = proto[h];
        expect(typeof method).toBe('function');
        expect(guardNames(method as (...args: unknown[]) => unknown)).toEqual(
          [],
        );
      }
    });
  });

  describe('ClientMealPlanController (untouched by H5)', () => {
    it('keeps its own JwtAuthGuard, ClientEntitlementGuard class-level stack', () => {
      const names = guardNames(ClientMealPlanController);
      expect(names).toEqual([
        JwtAuthGuard.name,
        ClientEntitlementGuard.name,
      ]);
    });
  });
});
