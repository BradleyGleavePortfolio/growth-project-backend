import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { PrismaService } from '../prisma.service';
import { AntiBotModule } from './anti-bot/anti-bot.module';
import { TalentConnectAdapterModule } from './connect-adapter.module';
import { ApplyController } from './apply.controller';
import { ApplyService } from './apply.service';
import { JobListingController } from './job-listing.controller';
import { JobListingService } from './job-listing.service';
import { HirerVerifiedGuard } from './hirer-verified.guard';
import { MarketplaceIdempotencyService } from './marketplace-idempotency.service';
import { TalentConnectWebhookController } from './talent-connect-webhook.controller';
import { TalentConnectWebhookService } from './talent-connect-webhook.service';
import { PublicListingController } from './public-listing.controller';
import { PublicListingService } from './public-listing.service';
import { JobHunterController } from './job-hunter.controller';
import { JobHunterService } from './job-hunter.service';
import { SpecialtyAlertsService } from './specialty-alerts.service';

// TM-2 — Talent Marketplace job-listing CRUD + publish.
// TM-3 — public, unauthenticated browse + SEO detail.
// TM-5 — Apply funnel + pre-coach account + applicant profile (AntiBotModule
// supplies the apply/account-create gate; MarketplaceIdempotencyService is the
// TM-4 ledger backing idempotent submit).
// TM-14 — appends the event-driven Connect `account.updated` webhook surface
// (controller + thin service) reusing the TM-10 adapter; append-only.
// TM-9 — applicant-facing /me/* job-hunter tooling (own applications, portfolio
// showcase, specialty-matched alerts, profile-strength nudges); append-only.
@Module({
  imports: [AntiBotModule, TalentConnectAdapterModule],
  controllers: [
    JobListingController,
    ApplyController,
    TalentConnectWebhookController,
    PublicListingController,
    JobHunterController,
  ],
  providers: [
    JobListingService,
    ApplyService,
    MarketplaceIdempotencyService,
    PublicListingService,
    PrismaService,
    JwtAuthGuard,
    JwksVerifierService,
    HirerVerifiedGuard,
    TalentConnectWebhookService,
    JobHunterService,
    SpecialtyAlertsService,
  ],
  exports: [JobListingService, ApplyService],
})
export class TalentMarketplaceModule {}
