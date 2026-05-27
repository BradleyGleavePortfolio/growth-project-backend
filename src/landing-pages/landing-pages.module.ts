/**
 * LandingPagesModule — R46 Coach Landing Page Builder.
 *
 * Phase 2: Coach CRUD + public SSR renderer + storefront routing.
 * Phase 3: CRM adapters (separate PR).
 * Phase 4 (CNAME): Custom-domain claim + DNS verify (this PR).
 *   - CustomDomainService — race-safe claim + 3s-timeout CNAME verify.
 *   - Fly cert issuance + the verification cron land in a follow-up PR.
 */
import { Module } from '@nestjs/common';
import { LandingPageController } from './landing-pages.controller';
import { LandingPagePublicController } from './landing-pages.public.controller';
import { LandingPageService } from './landing-pages.service';
import { LandingPagePublicService } from './landing-pages.public.service';
import { CustomDomainController } from './custom-domain.controller';
import { CustomDomainService } from './custom-domain.service';
import { DnsVerifier } from './dns-verifier';
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
    CustomDomainController,
  ],
  providers: [
    LandingPageService,
    LandingPagePublicService,
    CustomDomainService,
    // DnsVerifier is injectable so tests can swap in a fake resolver.
    DnsVerifier,
  ],
  exports: [
    LandingPageService,
    LandingPagePublicService,
    CustomDomainService,
  ],
})
export class LandingPagesModule {}
