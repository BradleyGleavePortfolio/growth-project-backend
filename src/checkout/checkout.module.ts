import { Module } from '@nestjs/common';
import { JwksVerifierService } from '../auth/jwks.service';
import { ConnectModule } from '../connect/connect.module';
import { PackagesModule } from '../packages/packages.module';
import {
  CheckoutController,
  CoachPurchasesController,
} from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { CheckoutWebhookHandlerService } from './checkout-webhook-handler.service';

// CheckoutModule — Stripe Checkout session minting and ClientPurchase
// lifecycle. Pulls in ConnectModule for StripeConnectApiService +
// ConnectModuleState (boot-time platform-enabled gate), and PackagesModule
// to read / mutate CoachPackage rows.
//
// CheckoutWebhookHandlerService is exported so BillingService can forward
// checkout.session.* / subscription.* / payment_intent.* events to it.
@Module({
  imports: [ConnectModule, PackagesModule],
  controllers: [CheckoutController, CoachPurchasesController],
  providers: [CheckoutService, CheckoutWebhookHandlerService, JwksVerifierService],
  exports: [CheckoutService, CheckoutWebhookHandlerService],
})
export class CheckoutModule {}
