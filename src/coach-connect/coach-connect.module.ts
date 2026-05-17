import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { NoActiveSubCoachGuard } from '../common/guards/no-active-sub-coach.guard';
import { PrismaService } from '../prisma.service';
import { ConnectModule } from '../connect/connect.module';
import { CheckoutModule } from '../checkout/checkout.module';
import { CoachConnectController } from './coach-connect.controller';
import { CoachConnectService } from './coach-connect.service';

// Phase 8 — Mobile coach-connect surface. Re-uses everything Phase 1-7
// already wired (ConnectService, StripeConnectApiService, ConnectModuleState,
// PayoutReadinessService, AdminAnalyticsService); this module just adds the
// typed wrapper service + controller mounted at /coach/connect/*.
@Module({
  imports: [ConnectModule, CheckoutModule],
  controllers: [CoachConnectController],
  providers: [
    CoachConnectService,
    PrismaService,
    JwtAuthGuard,
    CoachGuard,
    JwksVerifierService,
    NoActiveSubCoachGuard,
  ],
  exports: [CoachConnectService],
})
export class CoachConnectModule {}
