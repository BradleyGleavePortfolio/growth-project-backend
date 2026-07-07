import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { PrismaService } from '../prisma.service';
import { ScoutIngestController } from './scout-ingest.controller';
import { ScoutIngestFeatureGuard } from './scout-ingest-feature.guard';
import { ScoutIngestService } from './scout-ingest.service';

// PrismaService, AnalyticsService, and PtmService are global. Providing
// JwtAuthGuard / RolesGuard / JwksVerifierService locally mirrors MacrosModule
// and avoids the circular-import risk of pulling AuthModule.
@Module({
  controllers: [ScoutIngestController],
  providers: [
    ScoutIngestService,
    ScoutIngestFeatureGuard,
    PrismaService,
    JwtAuthGuard,
    RolesGuard,
    JwksVerifierService,
  ],
  exports: [ScoutIngestService],
})
export class ScoutModule {}
