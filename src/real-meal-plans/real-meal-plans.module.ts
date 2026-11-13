import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaService } from '../prisma.service';
import {
  ClientMealPlanController,
  CoachDailyMealPlansController,
  CoachMealTemplatesController,
} from './real-meal-plans.controller';
import { RealMealPlansService } from './real-meal-plans.service';

// MEAL-PLAN-NOTICE-BE: NotificationsModule provides NotificationsService, so a coach's meal plan change tells the
// client (as workout-builder.module.ts does for an assigned workout).
@Module({
  imports: [NotificationsModule],
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
