import { Module } from '@nestjs/common';
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
  providers: [RealMealPlansService, PrismaService],
  exports: [RealMealPlansService],
})
export class RealMealPlansModule {}
