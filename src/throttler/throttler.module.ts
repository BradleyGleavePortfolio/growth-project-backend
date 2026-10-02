import { Module } from '@nestjs/common';
import { LoginThrottleResetService } from './login-throttle-reset.service';

/**
 * ThrottlerModule — provides helpers that sit alongside NestJS's
 * built-in ThrottlerModule (from @nestjs/throttler).
 *
 * The NestJS ThrottlerModule itself is registered globally in AppModule
 * via ThrottlerModule.forRootAsync() — that wiring is unchanged. This
 * module exists as a lightweight, importable provider for feature modules
 * that need to interact with throttler internals.
 *
 * Exports:
 *   LoginThrottleResetService — OAuth coach-signup ceiling and the
 *   per-account password-failure lock (assertAccountNotLocked /
 *   recordAccountFailure / clearAccountFailures). Per-IP counters are never
 *   reset (C14 fix round).
 */
@Module({
  providers: [LoginThrottleResetService],
  exports: [LoginThrottleResetService],
})
export class ThrottlerModule {}
