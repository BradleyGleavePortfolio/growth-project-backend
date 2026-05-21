import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { AuditModule } from '../audit/audit.module';
import { MessagesSafetyController } from './messages-safety.controller';
import { MessagesSafetyService } from './messages-safety.service';

/**
 * MessagesSafetyModule — Apple 1.2 safety surface.
 *
 * PrismaService / AnalyticsService are provided globally. The local
 * `providers` block lists JwtAuthGuard + JwksVerifierService following the
 * same pattern as MessagingModule (avoids importing the heavy AuthModule
 * graph and side-steps any circular-import risk).
 *
 * Exported MessagesSafetyService is consumed by MessagingService for the
 * server-side block filter on list / unread / push paths.
 */
@Module({
  imports: [AuditModule],
  controllers: [MessagesSafetyController],
  providers: [MessagesSafetyService, JwtAuthGuard, JwksVerifierService],
  exports: [MessagesSafetyService],
})
export class MessagesSafetyModule {}
