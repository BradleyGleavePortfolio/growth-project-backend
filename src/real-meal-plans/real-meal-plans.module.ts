import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { PrismaService } from '../prisma.service';
import {
  ClientMealPlanController,
  CoachDailyMealPlansController,
  CoachMealTemplatesController,
} from './real-meal-plans.controller';
import { RealMealPlansService } from './real-meal-plans.service';

@Module({
  controllers: [
    CoachMealTemplatesController,
    CoachDailyMealPlansController,
    ClientMealPlanController,
  ],
  providers: [
    RealMealPlansService,
    PrismaService,
    JwtAuthGuard,
    CoachGuard,
    JwksVerifierService,
  ],
  exports: [RealMealPlansService],
})
export class RealMealPlansModule {}
