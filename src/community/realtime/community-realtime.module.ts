/**
 * community-realtime.module.ts — wires the v1-4 Community Realtime broadcaster.
 *
 * SupabaseService and AnalyticsService are provided by @Global() modules
 * (SupabaseModule, AnalyticsModule), so they are injectable here without an
 * explicit import. This module just provides + exports CommunityRealtimeService
 * so the v1-3 write-path services can inject it.
 */

import { Module } from '@nestjs/common';
import { CommunityRealtimeService } from './community-realtime.service';

@Module({
  providers: [CommunityRealtimeService],
  exports: [CommunityRealtimeService],
})
export class CommunityRealtimeModule {}
