import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { RolesGuard } from '../auth/roles.guard';
import { ServiceTokenGuard } from '../auth/service-token.guard';
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
// IMPORTANT — circular-dependency fix (hotfix 2026-05-20):
// We previously imported `AuthModule` to obtain the JWT/Roles/Service-token
// guards. That created a real boot-time cycle:
//   AuthModule → InviteCodesModule → BillingModule → CheckoutModule → AuthModule
// Nest tries to evaluate CheckoutModule.imports[0] (= AuthModule) while
// AuthModule itself is still mid-construction up the chain, so the value
// is `undefined`, throwing UndefinedModuleException at boot. The Fly
// machine then crash-loops and the app is unreachable in production.
//
// Same fix InviteCodesModule already documents: provide the auth guards
// locally instead of importing the whole AuthModule. CheckoutModule does
// not need AuthService — only the guards + JwksVerifierService. PrismaService
// and PtmService are provided by global modules, so guards still wire up.
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
    JwtAuthGuard,
    JwksVerifierService,
    RolesGuard,
    ServiceTokenGuard,
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
