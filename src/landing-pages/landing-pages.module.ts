/**
 * LandingPagesModule — R46 Coach Landing Page Builder + R49 custom domains.
 *
 * Phase 2 (R46): Coach CRUD + public SSR renderer + storefront routing.
 * Phase 4 (R49): Custom-domain CNAME, Fly cert mgmt, SNI host rewrite.
 *
 * Phase 3 (R47 CRM adapters) ships in a separate PR; that module wires
 * itself into LandingPagesModule via constructor injection of
 * LandingPagePublicService.
 *
 * SNI middleware:
 *   `configure(MiddlewareConsumer)` attaches LandingPageHostMiddleware
 *   at the wildcard `*` route so EVERY request — including ones that
 *   would otherwise 404 — runs through it.  The middleware no-ops on
 *   platform hosts and on hosts that are not in the verified-domain
 *   cache; only known custom domains are URL-rewritten.
 */
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { LandingPageController } from './landing-pages.controller';
import { LandingPagePublicController } from './landing-pages.public.controller';
import { LandingPageService } from './landing-pages.service';
import { LandingPagePublicService } from './landing-pages.public.service';
import { AnalyticsModule } from '../analytics/analytics.module';
// R49 — domains
import { CoachDomainsController } from './domains/domains.controller';
import { CoachDomainsService } from './domains/domains.service';
import { DomainDnsService } from './domains/dns.service';
import { FlyCertClient } from './domains/fly.client';
import { DomainCertProcessor } from './domains/cert.processor';
import { LandingPageHostMiddleware } from './domains/host-routing.middleware';

@Module({
  imports: [
    // PrismaModule is @Global — no explicit import needed.
    // AnalyticsModule provides AnalyticsService for landing.published events.
    AnalyticsModule,
  ],
  controllers: [
    LandingPageController,
    LandingPagePublicController,
    CoachDomainsController,
  ],
  providers: [
    LandingPageService,
    LandingPagePublicService,
    CoachDomainsService,
    DomainDnsService,
    FlyCertClient,
    DomainCertProcessor,
    LandingPageHostMiddleware,
  ],
  exports: [
    LandingPageService,
    LandingPagePublicService,
    CoachDomainsService,
  ],
})
export class LandingPagesModule implements NestModule {
  /**
   * Wildcard mount for the SNI host rewriter.  Runs on EVERY request;
   * its first guard short-circuits when the host is one we already own,
   * so platform traffic pays only a Map.has() + Set.has() lookup.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(LandingPageHostMiddleware).forRoutes('*');
  }
}
