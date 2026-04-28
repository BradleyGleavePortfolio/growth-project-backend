import { Module } from '@nestjs/common';
import { JwksVerifierService } from '../auth/jwks.service';
import { BillingService } from './billing.service';
import { CoachBillingController } from './coach-billing.controller';
import { MobileCoachBillingController } from './mobile-coach-billing.controller';
import { OwnerBillingController } from './owner-billing.controller';
import { StripeApiService } from './stripe-api.service';
import { StripeWebhookController } from './stripe-webhook.controller';
import { SubscriptionGuard } from './subscription.guard';

// PrismaService and the global JwtAuthGuard are provided elsewhere
// (PrismaModule, AuthModule). The module exports SubscriptionGuard so v1
// controllers can mount it on individual write routes.
@Module({
  controllers: [
    StripeWebhookController,
    CoachBillingController,
    MobileCoachBillingController,
    OwnerBillingController,
  ],
  providers: [
    BillingService,
    SubscriptionGuard,
    JwksVerifierService,
    StripeApiService,
  ],
  exports: [BillingService, SubscriptionGuard],
})
export class BillingModule {}
