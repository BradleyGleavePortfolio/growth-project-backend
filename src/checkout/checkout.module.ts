import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { JwksVerifierService } from '../auth/jwks.service';
import { RolesGuard } from '../auth/roles.guard';
import { ConnectModule } from '../connect/connect.module';
import { PackagesModule } from '../packages/packages.module';
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
@Module({
  imports: [AuthModule, ConnectModule, PackagesModule],
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
    JwksVerifierService,
    RolesGuard,
  ],
  exports: [
    CheckoutService,
    CheckoutWebhookHandlerService,
    PurchaseSplitHandlerService,
    DunningService,
  ],
})
export class CheckoutModule {}
