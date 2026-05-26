import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ConnectModule } from '../connect/connect.module';
import { EmailModule } from '../email/email.module';
import { CheckoutCookieService } from './checkout-cookie.service';
import { CheckoutIdempotencyService } from './checkout-idempotency.service';
import { CheckoutIpRateLimiterService } from './checkout-rate-limiter.service';
import { CheckoutRecoveryService } from './checkout-recovery.service';
import { ConnectPreflightService } from './connect-preflight.service';
import { WebviewDetectMiddleware } from './webview-detect.middleware';
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
    // r48 #10 — 5-attempts-per-hour-per-IP backstop on the checkout
    // create path.  Backs up the existing Nest @Throttle.
    CheckoutIpRateLimiterService,
    // r48 #11 — 7-day signed guest-session cookie.
    CheckoutCookieService,
    // r48 #9 — webview UA interstitial middleware.  Registered as
    // a provider so Nest DI can construct it for forRoutes().
    WebviewDetectMiddleware,
  ],
  exports: [GuestCheckoutService],
})
export class StorefrontModule implements NestModule {
  // r48 #9 — webview UA interstitial.  Mount as middleware ONLY on
  // GET /v1/packages/public/* so AJAX POSTs from the storefront's SSR
  // page (which runs in the user's real browser after they switched)
  // pass through untouched.  Middleware itself filters on req.method
  // === 'GET' but the route-binding is the first line of defence.
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(WebviewDetectMiddleware)
      .forRoutes({ path: 'v1/packages/public/*', method: RequestMethod.GET });
  }
}
