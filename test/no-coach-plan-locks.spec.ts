// Owner TM-P1 (2026-10-12 19:41 PDT): "There should be zero locks - there is
// no free or paid plan - we only do a 2% take rate on GMV, thats all!"
//
// Walks every controller registered in AppModule (same discovery as
// roles-enforced.spec.ts) and fails if any class or route handler mounts the
// coach-plan SubscriptionGuard or carries an @RequiresTier plan requirement.
import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { DiscoveryModule, DiscoveryService, MetadataScanner } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AppModule } from '../src/app.module';
import { SubscriptionGuard } from '../src/billing/subscription.guard';
import { REQUIRES_TIER_KEY } from '../src/billing/requires-tier.decorator';

describe('no coach plan locks on any route (TM-P1)', () => {
  jest.setTimeout(45_000);
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [DiscoveryModule, AppModule] }).compile();
  });
  afterAll(async () => {
    await moduleRef?.close();
  });

  it('no controller or handler mounts SubscriptionGuard or @RequiresTier', () => {
    const scanner = moduleRef.get(MetadataScanner);
    const locks: string[] = [];
    let routes = 0;
    const check = (target: object, name: string) => {
      const guards = (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined) ?? [];
      if (guards.includes(SubscriptionGuard)) locks.push(`${name}: SubscriptionGuard`);
      if (Reflect.getMetadata(REQUIRES_TIER_KEY, target) !== undefined) locks.push(`${name}: @RequiresTier`);
    };
    for (const wrapper of moduleRef.get(DiscoveryService).getControllers()) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!instance || typeof instance !== 'object') continue;
      const ctor = instance.constructor;
      check(ctor, ctor.name);
      for (const method of scanner.getAllMethodNames(instance)) {
        const handler = instance[method];
        if (typeof handler !== 'function' || Reflect.getMetadata('path', handler) === undefined) continue;
        routes += 1;
        check(handler, `${ctor.name}.${method}`);
      }
    }
    expect(routes).toBeGreaterThan(100);
    expect(locks).toEqual([]);
  });
});
