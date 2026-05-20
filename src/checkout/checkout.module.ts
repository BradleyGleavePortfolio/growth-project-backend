import { Module } from '@nestjs/common';
import { ConnectModule } from '../connect/connect.module';
import { PackagesModule } from '../packages/packages.module';
import { AdminAnalyticsService } from './admin-analytics.service';
import {
  CheckoutController,
  CoachPurchasesController,
} from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { CheckoutWebhookHandlerService } from './checkout-webhook-handler.service';
import { DunningService } from './dunning.service';
import {
  AdminPaymentOpsController,
  CoachPaymentOpsController,
} from './payment-ops.controller';
import { PurchaseSplitHandlerService } from './purchase-split-handler.service';
import { RefundDisputeHandlerService } from './refund-dispute-handler.service';

// CheckoutModule — Stripe Checkout session minting and ClientPurchase
// lifecycle. Pulls in ConnectModule for StripeConnectApiService +
// ConnectModuleState (boot-time platform-enabled gate), and PackagesModule
// to read / mutate CoachPackage rows.
//
// CheckoutWebhookHandlerService is exported so BillingService can forward
// checkout.session.* / subscription.* / payment_intent.* events to it.
//
// Phase 4-5: DunningService + PurchaseSplitHandlerService own the split
// ledger / head-coach transfer / payment-failure-and-retry lifecycle.
//
// Guards used by this module's controllers (JwtAuthGuard, RolesGuard,
// ServiceTokenGuard, CoachOrOwnerGuard) are provided by the @Global
// SecurityGuardsModule. The previous local-provider workaround that the
// hotfix #243 introduced has been removed — global guard provisioning is
// the structural fix for the cycle (CheckoutModule no longer needs to
// import AuthModule, and AuthModule no longer needs to provide guards).
@Module({
  imports: [ConnectModule, PackagesModule],
  controllers: [
    CheckoutController,
    CoachPurchasesController,
    AdminPaymentOpsController,
    CoachPaymentOpsController,
  ],
  providers: [
    CheckoutService,
    CheckoutWebhookHandlerService,
    PurchaseSplitHandlerService,
    DunningService,
    RefundDisputeHandlerService,
    AdminAnalyticsService,
  ],
  exports: [
    CheckoutService,
    CheckoutWebhookHandlerService,
    PurchaseSplitHandlerService,
    DunningService,
    RefundDisputeHandlerService,
    AdminAnalyticsService,
  ],
})
export class CheckoutModule {}
