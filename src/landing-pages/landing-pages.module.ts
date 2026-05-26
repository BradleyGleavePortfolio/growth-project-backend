/**
 * LandingPagesModule — R46/R47 Coach Landing Page Builder.
 *
 * Phase 2 (R46): Coach CRUD + public SSR renderer + storefront routing.
 * Phase 3 (R47): CRM adapters + lead sync worker + analytics rollup.
 *
 * Phase 3 wiring:
 *   - CoachCrmService              — encrypted CRM config CRUD
 *   - CrmRegistryService           — provider → adapter map
 *   - CrmController                — coach mgmt endpoints
 *   - LeadSyncQueue                — enqueue façade (future BullMQ swap)
 *   - LeadSyncProcessor            — cron worker (1/min) draining pending leads
 *   - LeadRateLimiterService       — Redis 100-leads-per-page-per-UTC-day cap
 *
 * Phase 4 (custom domain Pro+) TODO:
 *   - CustomDomainService          — DNS verification cron + Fly cert mgmt
 */
import { Module } from '@nestjs/common';
import { LandingPageController } from './landing-pages.controller';
import { LandingPagePublicController } from './landing-pages.public.controller';
import { LandingPageService } from './landing-pages.service';
import { LandingPagePublicService } from './landing-pages.public.service';
import { AnalyticsModule } from '../analytics/analytics.module';
import { CrmController } from './crm/crm.controller';
import { CoachCrmService } from './crm/crm.service';
import { CrmRegistryService } from './crm/crm-registry.service';
import { LeadSyncQueue } from './crm/lead-sync.queue';
import { LeadSyncProcessor } from './crm/lead-sync.processor';
import { LeadRateLimiterService } from './lead-rate-limiter.service';

@Module({
  imports: [
    // PrismaModule + KmsModule are @Global — no explicit import needed.
    AnalyticsModule,
  ],
  controllers: [
    LandingPageController,
    LandingPagePublicController,
    CrmController,
  ],
  providers: [
    LandingPageService,
    LandingPagePublicService,
    CoachCrmService,
    CrmRegistryService,
    LeadSyncQueue,
    LeadSyncProcessor,
    LeadRateLimiterService,
  ],
  exports: [
    LandingPageService,
    LandingPagePublicService,
    CoachCrmService,
    CrmRegistryService,
  ],
})
export class LandingPagesModule {}
