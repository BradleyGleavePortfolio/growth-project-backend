import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { FinanceInsightsClient } from './finance-insights.client';
import { HolisticInsightsController } from './holistic-insights.controller';
import { HolisticInsightsService } from './holistic-insights.service';

@Module({
  controllers: [HolisticInsightsController],
  providers: [HolisticInsightsService, FinanceInsightsClient, PrismaService],
  exports: [HolisticInsightsService],
})
export class InsightsModule {}
