/**
 * TalentMarketplaceModule — Phase 11 / Track 8
 *
 * Houses the coach application flow, talent pool search, Stripe Connect
 * Express onboarding scaffolding, offer lifecycle, and a revenue-routing
 * placeholder that documents the application_fee + transfer_data pattern for
 * the follow-up payment-intent integration (Track 8.5+).
 *
 * Public surface:
 *   POST /apply/coach                          — unauthenticated application form
 *   GET  /applications/me                      — applicant reads own status
 *   GET  /admin/applications                   — owner admin reviews queue
 *   PATCH /admin/applications/:id/review       — owner scores + advances status
 *   POST /talent/connect/onboarding-link       — coach requests onboarding URL
 *   GET  /talent/connect/status                — coach reads Connect account status
 *   POST /talent/offers                        — head-coach extends offer
 *   PATCH /talent/offers/:id/accept            — applicant accepts offer
 *   PATCH /talent/offers/:id/reject            — applicant rejects offer
 *   GET  /talent/pool                          — Scale+ head-coach searches pool
 */

import { Module } from '@nestjs/common';
import { JwksVerifierService } from '../auth/jwks.service';
import { CoachApplicationController } from './coach-application.controller';
import { CoachApplicationService } from './coach-application.service';
import { TalentPoolService } from './talent-pool.service';
import { ConnectAccountService } from './connect-account.service';
import { CoachOfferService } from './coach-offer.service';
import { RevenueRoutingService } from './revenue-routing.service';

@Module({
  controllers: [CoachApplicationController],
  providers: [
    CoachApplicationService,
    TalentPoolService,
    ConnectAccountService,
    CoachOfferService,
    RevenueRoutingService,
    JwksVerifierService,
  ],
  exports: [
    CoachApplicationService,
    TalentPoolService,
    ConnectAccountService,
    CoachOfferService,
  ],
})
export class TalentMarketplaceModule {}
