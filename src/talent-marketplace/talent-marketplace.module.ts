import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { PrismaService } from '../prisma.service';
import { JobListingController } from './job-listing.controller';
import { JobListingService } from './job-listing.service';
import { HirerVerifiedGuard } from './hirer-verified.guard';

// TM-2 — Talent Marketplace job-listing CRUD + publish. Provides the same
// JwtAuthGuard + JwksVerifierService the rest of the authenticated surface
// uses, plus the HirerVerifiedGuard that gates the write routes.
@Module({
  controllers: [JobListingController],
  providers: [
    JobListingService,
    PrismaService,
    JwtAuthGuard,
    JwksVerifierService,
    HirerVerifiedGuard,
  ],
  exports: [JobListingService],
})
export class TalentMarketplaceModule {}
