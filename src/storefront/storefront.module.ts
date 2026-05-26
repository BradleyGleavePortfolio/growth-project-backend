import { Module } from '@nestjs/common';
import { ConnectModule } from '../connect/connect.module';
import { EmailModule } from '../email/email.module';
import { CheckoutIdempotencyService } from './checkout-idempotency.service';
import { CheckoutRecoveryService } from './checkout-recovery.service';
import { ConnectPreflightService } from './connect-preflight.service';
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
    // KmsModule is @Global() — no import needed for CheckoutIdempotencyService.
    ConnectModule,
    // r48 #5 — EmailModule re-exports EmailService for the recovery
    // magic-link send path.
    EmailModule,
  ],
  controllers: [StorefrontPublicController],
  providers: [
    StorefrontService,
    GuestCheckoutService,
    GuestCheckoutReconciliationService,
    GuestCheckoutPiiScrubService,
    // r48 #2 — lost-webhook reconciler. Cron-driven; no need to export.
    LostWebhookReconcileService,
    // r48 #3 — content-addressable PI cache (Redis SETNX + KMS-encrypted
    // client_secret at rest).
    CheckoutIdempotencyService,
    // r48 #4 + #5 — resume endpoint + magic-link recovery (15-min JWT).
    CheckoutRecoveryService,
    // r48 #7 + #8 — Stripe Connect preflight cache (60s Redis TTL) +
    // Apple/Google Pay capability flags.
    ConnectPreflightService,
  ],
  exports: [GuestCheckoutService],
})
export class StorefrontModule {}
