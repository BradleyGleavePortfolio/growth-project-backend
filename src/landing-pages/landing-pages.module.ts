/**
 * LandingPagesModule — R46 Coach Landing Page Builder, Phase 2.
 *
 * Phase 2 (this PR): Coach CRUD + public SSR renderer + storefront routing.
 *
 * TODO PR #3 (CRM adapters) adds:
 *   - CoachCrmService             — per-provider adapters (HubSpot, GoHighLevel,
 *                                   Mailchimp, ActiveCampaign, webhook)
 *   - LandingCrmSyncProcessor     — BullMQ worker with 3-retry exponential backoff
 *
 * TODO PR #4 (CNAME + Fly cert issuance, Pro+ gated):
 *   - CustomDomainService         — DNS verification cron + Fly Machines API cert mgmt
 */
import { Module } from '@nestjs/common';
import { LandingPageController } from './landing-pages.controller';
import { LandingPagePublicController } from './landing-pages.public.controller';
import { LandingPageService } from './landing-pages.service';
import { LandingPagePublicService } from './landing-pages.public.service';
import { AnalyticsModule } from '../analytics/analytics.module';

@Module({
  imports: [
    // PrismaModule is @Global — no explicit import needed.
    // AnalyticsModule provides AnalyticsService for landing.published events.
    AnalyticsModule,
  ],
  controllers: [
    LandingPageController,
    LandingPagePublicController,
  ],
  providers: [
    LandingPageService,
    LandingPagePublicService,
  ],
  exports: [
    LandingPageService,
    LandingPagePublicService,
  ],
})
export class LandingPagesModule {}
