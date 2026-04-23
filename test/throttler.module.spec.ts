import { AppModule } from '../src/app.module';
import { ThrottlerModule } from '@nestjs/throttler';

/**
 * Smoke test: AppModule must import ThrottlerModule. Round-1 will add
 * an APP_GUARD provider binding ThrottlerGuard globally; the APP_GUARD
 * check is scaffolded below (skip until #1 lands).
 */
describe('AppModule Throttler wiring', () => {
  it('imports @nestjs/throttler ThrottlerModule', () => {
    const metadata = Reflect.getMetadata('imports', AppModule) as any[];
    expect(metadata).toBeDefined();
    const found = metadata.some(
      (m: any) =>
        m === ThrottlerModule ||
        (m && m.module === ThrottlerModule) ||
        (m && typeof m === 'object' && m.module === ThrottlerModule),
    );
    expect(found).toBe(true);
  });

  // Post round-1: app.module.ts should include
  //   { provide: APP_GUARD, useClass: ThrottlerGuard }
  // in providers. Flip skip → run once #1 lands.
  it.skip('registers ThrottlerGuard as APP_GUARD (global throttling)', () => {
    const { APP_GUARD } = require('@nestjs/core');
    const { ThrottlerGuard } = require('@nestjs/throttler');
    const providers = Reflect.getMetadata('providers', AppModule) as any[];
    const guardProvider = providers.find(
      (p: any) => p && typeof p === 'object' && p.provide === APP_GUARD,
    );
    expect(guardProvider).toBeDefined();
    expect(guardProvider.useClass).toBe(ThrottlerGuard);
  });
});
