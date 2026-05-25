import { Module } from '@nestjs/common';
import { CheckoutModule } from '../checkout/checkout.module';
import { ConnectModule } from '../connect/connect.module';
import { EmailModule } from '../email/email.module';
import { PrismaService } from '../prisma.service';
import { StorefrontModule } from '../storefront/storefront.module';
import { BillingService } from './billing.service';
import { CoachBillingController } from './coach-billing.controller';
import { MobileCoachBillingController } from './mobile-coach-billing.controller';
import { OwnerBillingController } from './owner-billing.controller';
import { StripeApiService } from './stripe-api.service';
import { StripeWebhookController } from './stripe-webhook.controller';

// Guards used by controllers in this module (SubscriptionGuard,
// NoActiveSubCoachGuard, JwtAuthGuard, …) are provided by the @Global
// SecurityGuardsModule. JwksVerifierService is colocated there too.
// PrismaService is provided by the global PrismaModule.
@Module({
  imports: [
    // ConnectModule re-exports ConnectService so the Stripe webhook handler
    // can forward account.* events to it. See connect.module.ts for the
    // boot-time platform-enabled gate.
    ConnectModule,
    // CheckoutModule re-exports CheckoutWebhookHandlerService so the
    // Stripe webhook handler can forward checkout/session/subscription/
    // payment events that belong to a coach-package purchase to it.
    CheckoutModule,
    // EmailModule re-exports EmailService so BillingService can dispatch
    // the dunning email on invoice.payment_failed. See QA P1-B1.
    EmailModule,
    // R43 — StorefrontModule re-exports GuestCheckoutService so the
    // Stripe webhook dispatcher can route payment_intent.* events for
    // guest checkouts to it.
    StorefrontModule,
  ],
  controllers: [
    StripeWebhookController,
    CoachBillingController,
    MobileCoachBillingController,
    OwnerBillingController,
  ],
  providers: [
    BillingService,
    StripeApiService,
    PrismaService,
  ],
  exports: [BillingService],
})
export class BillingModule {}
