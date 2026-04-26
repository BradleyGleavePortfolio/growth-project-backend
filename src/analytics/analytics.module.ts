/**
 * AnalyticsModule — global NestJS module for PostHog instrumentation.
 *
 * Registered as isGlobal: true so any feature module can inject
 * AnalyticsService without importing AnalyticsModule explicitly.
 */

import { Global, Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

@Global()
@Module({
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
