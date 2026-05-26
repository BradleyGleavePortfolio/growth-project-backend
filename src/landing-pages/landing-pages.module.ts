/**
 * LandingPagesModule — R46 Coach Landing Page Builder
 *
 * Phase 1 (this PR): schema + RLS + migration only.
 * This module skeleton exists so the rest of the team can branch off
 * feat/landing-pages-phase1-schema and add services/controllers without
 * touching app.module.ts until PR #2 is ready.
 *
 * TODO — PR #2 (coach CRUD + public SSR renderer) adds:
 *   - LandingPageService          — coach CRUD, slug validation, page-count cap,
 *                                   CTA URL validation (rejects external payment hosts),
 *                                   accent-color sanitization, status transitions
 *   - LandingPagePublicService    — SSR HTML render via NestJS templating,
 *                                   OG/Twitter card meta, schema.org JSON-LD,
 *                                   sendBeacon view ingestion (throttled)
 *   - LandingPageController       — /api/v1/coach/landing-pages/* (coach-authed)
 *   - LandingPagePublicController — /p/:coachSlug/:pageSlug (public, @Public())
 *   - CrmIntegrationController    — /api/v1/coach/crm-integrations/*
 *
 * TODO — PR #3 (CRM adapters) adds:
 *   - CoachCrmService             — per-provider adapters (HubSpot, GoHighLevel,
 *                                   Mailchimp, ActiveCampaign, webhook)
 *   - LandingCrmSyncProcessor     — BullMQ worker with 3-retry exponential backoff
 *
 * TODO — PR #4 (CNAME + Fly cert issuance, Pro+ gated):
 *   - CustomDomainService         — DNS verification cron + Fly Machines API cert mgmt
 *
 * Registration in app.module.ts happens in PR #2 once there is a service to
 * inject.  For now the module is scaffolded but NOT imported anywhere to avoid
 * a DI error from an empty @Module providers array.
 *
 * To wire in PR #2, add to app.module.ts imports:
 *   import { LandingPagesModule } from './landing-pages/landing-pages.module';
 *   // ...
 *   LandingPagesModule,
 */
import { Module } from '@nestjs/common';

@Module({
  // TODO PR #2: imports.push(PrismaModule) — already global, no explicit import needed
  // TODO PR #2: imports.push(BullModule.registerQueue({ name: 'landing-crm-sync' }))
  // TODO PR #2: controllers = [LandingPageController, LandingPagePublicController, CrmIntegrationController]
  // TODO PR #2: providers   = [LandingPageService, LandingPagePublicService]
  // TODO PR #3: providers.push(CoachCrmService, LandingCrmSyncProcessor)
  // TODO PR #4: providers.push(CustomDomainService)
  imports: [],
  controllers: [],
  providers: [],
  exports: [],
})
export class LandingPagesModule {}
