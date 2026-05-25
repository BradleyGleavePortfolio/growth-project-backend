import { Module } from '@nestjs/common';
import { ConnectModule } from '../connect/connect.module';
import { GuestCheckoutService } from './guest-checkout.service';
import { StorefrontPublicController } from './storefront-public.controller';
import { StorefrontService } from './storefront.service';

// R43 Storefront Phase 1 — public package + guest checkout surface.
// Exports GuestCheckoutService so the Stripe webhook dispatcher in
// BillingService can route payment_intent.* events to it.
@Module({
  imports: [
    // ConnectModule re-exports StripeConnectApiService. We need it for
    // Stripe Account reads (publishable key) and PaymentIntent creation.
    ConnectModule,
  ],
  controllers: [StorefrontPublicController],
  providers: [StorefrontService, GuestCheckoutService],
  exports: [GuestCheckoutService],
})
export class StorefrontModule {}
