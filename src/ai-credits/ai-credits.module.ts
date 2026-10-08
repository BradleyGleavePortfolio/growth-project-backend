import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaService } from '../prisma.service';
import { AuthModule } from '../auth/auth.module';
import { StripeApiService } from '../billing/stripe-api.service';
import { CoachAIBudgetService } from './coach-ai-budget.service';
import { CoachAiCreditPackService } from './coach-ai-credit-pack.service';
import { CoachAiController } from './coach-ai.controller';
import { AdminCoachAiController } from './admin-coach-ai.controller';
import { CoachAIBudgetScheduler } from './coach-ai-budget.scheduler';
import { DormancyGuardService } from './dormancy-guard.service';
import { CallerPurchasePolicyInterceptor } from './client-purchase-policy';

// Stream 1 — Coach AI Credits module. @Global because the AI gateway and
// the dormancy-aware cron callers (CoachBriefScheduler, weekly-insight
// scheduler) need to inject these services without re-importing the
// module everywhere.
//
// StripeApiService is provided here too because the Pack service depends
// on it; we don't import BillingModule to avoid the circular dependency
// (BillingService -> CoachAiCreditPackService for the webhook dispatch
// path, and the pack service needs Stripe). The PrismaService and
// StripeApiService are both providers without dependencies on Billing,
// so duplicating their provider entry is safe — Nest's DI gives each
// module its own instance, but PrismaService is the @Global one shared
// across the app.
@Global()
@Module({
  imports: [AuthModule],
  controllers: [CoachAiController, AdminCoachAiController],
  providers: [
    PrismaService,
    StripeApiService,
    CoachAIBudgetService,
    CoachAiCreditPackService,
    CoachAIBudgetScheduler,
    DormancyGuardService,
    // CREDIT-PAY-131: global (APP_INTERCEPTOR is app-wide wherever it is
    // declared). Puts X-Client-Purchase-Policy / X-Client-Platform in scope so
    // the coach "credits used up" copy names a pack only where the app sells one.
    { provide: APP_INTERCEPTOR, useClass: CallerPurchasePolicyInterceptor },
  ],
  exports: [
    CoachAIBudgetService,
    CoachAiCreditPackService,
    DormancyGuardService,
  ],
})
export class AiCreditsModule {}
