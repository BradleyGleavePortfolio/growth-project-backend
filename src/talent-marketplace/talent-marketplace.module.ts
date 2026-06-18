import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { PrismaService } from '../prisma.service';
import { TalentConnectAdapterModule } from './connect-adapter.module';
import { JobListingController } from './job-listing.controller';
import { JobListingService } from './job-listing.service';
import { HirerVerifiedGuard } from './hirer-verified.guard';
import { TalentConnectWebhookController } from './talent-connect-webhook.controller';
import { TalentConnectWebhookService } from './talent-connect-webhook.service';

// TM-2 — Talent Marketplace job-listing CRUD + publish.
// TM-14 — appends the event-driven Connect `account.updated` webhook surface
// (controller + thin service) reusing the TM-10 adapter; append-only.
@Module({
  imports: [TalentConnectAdapterModule],
  controllers: [JobListingController, TalentConnectWebhookController],
  providers: [
    JobListingService,
    PrismaService,
    JwtAuthGuard,
    JwksVerifierService,
    HirerVerifiedGuard,
    TalentConnectWebhookService,
  ],
  exports: [JobListingService],
})
export class TalentMarketplaceModule {}
