import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { RealMealPlansModule } from '../real-meal-plans/real-meal-plans.module';
import {
  ClientMealPlanAliasController,
  ClientMealPlansController,
} from './client-meal-plans.controller';
import { CoachMealPlansController } from './coach-meal-plans.controller';
import { MealPlansService } from './meal-plans.service';

// ============================================================================
// SCHEDULED FOR REMOVAL — post-mobile-migration (BUG-R2).
//
// `RealMealPlansModule` (DailyMealPlan + MealTemplate + assignments) is the
// CANONICAL meal-plan system. This legacy module survives ONLY as a
// compatibility shim for old mobile app versions that still call
// `GET /meal-plans` / `POST /coach/clients/:id/meal-plans` against the legacy
// `MealPlan` table. Once mobile-client telemetry confirms zero traffic on the
// legacy `MealPlan`-backed routes (tracked alongside the mobile migration
// rollout), DELETE this entire module, its controllers/service/DTOs, and the
// `MealPlan` table in a dedicated schema PR — NOT here (this fix performs zero
// schema mutation; the table merge is a separate change).
//
// Until then `GET /meal-plans` is a deprecation wrapper that also reads the
// canonical system (see MealPlansService.listForClientWithCanonicalFallback),
// and `GET /me/meal-plan` is an alias that proxies straight to the canonical
// system. We import RealMealPlansModule (which exports RealMealPlansService)
// so the alias controller can delegate without duplicating canonical logic.
//
// PrismaService / SupabaseService are provided globally. Providing the guards
// locally (rather than `imports: [AuthModule]`) follows NudgesModule /
// MessagingModule and avoids AuthModule's circular-import risk.
// ============================================================================
@Module({
  imports: [BillingModule, RealMealPlansModule],
  controllers: [
    CoachMealPlansController,
    ClientMealPlansController,
    ClientMealPlanAliasController,
  ],
  providers: [MealPlansService, JwtAuthGuard, CoachGuard, JwksVerifierService],
  exports: [MealPlansService],
})
export class MealPlansModule {}
