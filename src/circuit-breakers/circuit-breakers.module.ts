import { Global, Module } from '@nestjs/common';
import { CircuitOpenFilter } from './circuit-open.filter';

// H6 — circuit-breakers module (D-H6-2 LOCKED).
//
// The breaker factory (createBreaker) is a pure function backed by a
// module-scoped cache, so it needs no DI registration — client wrappers
// import it directly. This module exists to (a) provide the CircuitOpenFilter
// for DI-based discovery and (b) give app.module.ts a single import that
// signals "circuit breakers are wired". @Global keeps it import-light.
//
// The filter is registered globally in main.ts (useGlobalFilters) rather
// than via APP_FILTER so it composes with the existing HttpExceptionFilter /
// ThrottlerExceptionFilter chain in the documented order.
@Global()
@Module({
  providers: [CircuitOpenFilter],
  exports: [CircuitOpenFilter],
})
export class CircuitBreakersModule {}
