import { Module } from '@nestjs/common';
import { ConnectModule } from '../connect/connect.module';
import { GuestCheckoutPiiScrubService } from './guest-checkout-pii-scrub.service';
import { GuestCheckoutReconciliationService } from './guest-checkout-reconciliation.service';
import { GuestCheckoutService } from './guest-checkout.service';
import { LostWebhookReconcileService } from './lost-webhook-reconcile.service';
import { StorefrontPublicController } from './storefront-public.controller';
import { StorefrontService } from './storefront.service';

// R43 Storefront Phase 1 — public package + guest checkout surface.
// Exports GuestCheckoutService so the Stripe webhook dispatcher in
// BillingService can route payment_intent.* events to it.
//
// GuestCheckoutReconciliationService is registered as a provider but is
// not exported — its only entry point is the @Cron-driven `run()` method,
// which the @nestjs/schedule discovery layer wires up automatically when
// ScheduleModule is loaded from AppModule.
@Module({
  imports: [
    // ConnectModule re-exports StripeConnectApiService. We need it for
    // Stripe Account reads (publishable key) and PaymentIntent creation.
    ConnectModule,
  ],
  controllers: [StorefrontPublicController],
  providers: [
    StorefrontService,
    GuestCheckoutService,
    GuestCheckoutReconciliationService,
    GuestCheckoutPiiScrubService,
    // r48 #2 — lost-webhook reconciler. Cron-driven; no need to export.
    LostWebhookReconcileService,
  ],
  exports: [GuestCheckoutService],
})
export class StorefrontModule {}
