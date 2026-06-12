import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { CommunityAccessService } from '../community-access.service';
import { CommunityFeatureFlagGuard } from '../community-feature-flag.guard';
import { AckController } from './ack.controller';
import { AckFeatureFlagGuard } from './ack-flag.guard';
import { AckRepository } from './ack.repository';
import { AckService } from './ack.service';

/**
 * v2-2 coach ack-signals module.
 *
 * Wires the transition controller + state-machine service + repository.
 * AuthModule supplies JwtAuthGuard/RolesGuard (same import the rest of the
 * community surface uses). AnalyticsService and PrismaService come from their
 * @Global() modules, so they need no explicit import here.
 *
 * AckService is exported so the messages/inbox read surfaces can reuse its
 * envelope/SLA projection (additive enrichment) without duplicating the
 * derivation logic — keeping a single source of truth for ack state.
 */
@Module({
  imports: [AuthModule],
  controllers: [AckController],
  providers: [
    AckService,
    AckRepository,
    AckFeatureFlagGuard,
    CommunityFeatureFlagGuard,
    CommunityAccessService,
  ],
  exports: [AckService],
})
export class AckModule {}
