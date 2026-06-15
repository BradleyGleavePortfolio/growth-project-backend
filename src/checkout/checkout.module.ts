import { forwardRef, Module } from '@nestjs/common';
import { ConnectModule } from '../connect/connect.module';
import { ContractsModule } from '../contracts/contracts.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PackagesModule } from '../packages/packages.module';
import { RegimesModule } from '../regimes/regimes.module';
import { AdminAnalyticsService } from './admin-analytics.service';
import {
  CheckoutController,
  CoachPurchasesController,
} from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { CheckoutWebhookHandlerService } from './checkout-webhook-handler.service';
import { DunningService } from './dunning.service';
import { DunningV2Module } from './dunning-v2/dunning-v2.module';
import {
  AdminPaymentOpsController,
  CoachPaymentOpsController,
} from './payment-ops.controller';
import { PurchaseSplitHandlerService } from './purchase-split-handler.service';
import { RefundDisputeHandlerService } from './refund-dispute-handler.service';
import { PayoutsV2Module } from '../payouts-v2/payouts-v2.module';

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
  // A276 P0-2 (refix) — NotificationsModule is imported so
  // RefundDisputeHandlerService can emit COACH_ALERTs on the
  // post-conversion refund + dispute paths (the dominant production
  // case: refunds arrive after convertGuestToUser has stamped a
  // ClientPurchase row). The dependency is HARD: missing wiring fails
  // module boot rather than silently no-opping.
  imports: [
    ConnectModule,
    PackagesModule,
    // F2 — provides PartialRefundDecisionService for RefundDisputeHandler's
    // @Optional() partial-refund-decision seam. No-op while
    // FEATURE_NAMED_REGIMES is OFF (the service self-checks the flag).
    // forwardRef: RegimesModule transitively imports PackagesModule, which
    // imports BillingModule → CheckoutModule — a module cycle. The forwardRef
    // defers RegimesModule resolution past CheckoutModule's own evaluation so
    // RegimesModule's own imports (AuthModule) are defined when Nest scans it.
    forwardRef(() => RegimesModule),
    NotificationsModule,
    // B3 v2 (spec PR #6) — provides DunningV2Service for the webhook
    // handler's @Optional() recovery / late-reversal shim. No-op while
    // FEATURE_DUNNING_V2 is OFF (the service self-checks the flag).
    DunningV2Module,
    // Bank-Account Payouts v2 (spec §2.5) — provides PayoutRoutingService for
    // the webhook handler's @Optional() payout.* routing branch. No-op while
    // FEATURE_BANK_PAYOUTS_V2 is OFF (the service self-checks the flag). No
    // cycle: PayoutsV2Module does not import CheckoutModule.
    PayoutsV2Module,
    // B5 — provides CheckoutContractGate so CheckoutService can enforce the
    // two-layer contract gate before any Stripe call. No-op while
    // FEATURE_CONTRACTS_ENABLED is OFF (the gate self-checks the flag).
    ContractsModule,
  ],
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
