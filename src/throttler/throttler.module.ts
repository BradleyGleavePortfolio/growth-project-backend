import { Module } from '@nestjs/common';
import { LoginThrottleResetService } from './login-throttle-reset.service';

/**
 * ThrottlerModule — provides helpers that sit alongside NestJS's
 * built-in ThrottlerModule (from @nestjs/throttler).
 *
 * The NestJS ThrottlerModule itself is registered globally in AppModule
 * via ThrottlerModule.forRootAsync() — that wiring is unchanged. This
 * module exists as a lightweight, importable provider for feature modules
 * that need to interact with throttler internals (currently: resetting
 * per-IP login counters on successful authentication).
 *
 * Exports:
 *   LoginThrottleResetService — call resetLoginCounters(ip) after a
 *   successful login/OAuth exchange to clear both the per-minute and
 *   per-hour IP buckets for that address.
 */
@Module({
  providers: [LoginThrottleResetService],
  exports: [LoginThrottleResetService],
})
export class ThrottlerModule {}
