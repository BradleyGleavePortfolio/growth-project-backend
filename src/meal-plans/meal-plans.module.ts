import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { ClientMealPlansController } from './client-meal-plans.controller';
import { CoachMealPlansController } from './coach-meal-plans.controller';
import { MealPlansService } from './meal-plans.service';

// PrismaService / SupabaseService are provided globally. Providing the guards
// locally (rather than `imports: [AuthModule]`) follows NudgesModule /
// MessagingModule and avoids AuthModule's circular-import risk.
@Module({
  controllers: [CoachMealPlansController, ClientMealPlansController],
  providers: [MealPlansService, JwtAuthGuard, CoachGuard, JwksVerifierService],
  exports: [MealPlansService],
})
export class MealPlansModule {}
