import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { PrismaService } from '../prisma.service';
import { FinanceInsightsClient } from './finance-insights.client';
import { HolisticInsightsController } from './holistic-insights.controller';
import { HolisticInsightsService } from './holistic-insights.service';

@Module({
  controllers: [HolisticInsightsController],
  providers: [
    HolisticInsightsService,
    FinanceInsightsClient,
    PrismaService,
    JwtAuthGuard,
    JwksVerifierService,
  ],
  exports: [HolisticInsightsService],
})
export class InsightsModule {}
