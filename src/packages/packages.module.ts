import { Module } from '@nestjs/common';
import {
  ClientPackagesController,
  CoachPackagesController,
} from './packages.controller';
import { PackagesService } from './packages.service';
import { PurchaseFanoutService } from './purchase-fanout.service';

// CoachPackage CRUD. Exports PackagesService so CheckoutModule (Phase 3)
// can read packages and cache Stripe Price ids back onto rows after lazy
// Product/Price creation.
//
// Also exports PurchaseFanoutService (PR-4) — the fan-out seam invoked at
// purchase-entitled time by every checkout path. Lives here because both
// CheckoutModule and StorefrontModule already import (or now import)
// PackagesModule, so the service is reachable from all three hook sites
// without creating a new circular import (webhook handler is in
// checkout, guest service in storefront).
//
// Guards used by this module's controllers (JwtAuthGuard, CoachOrOwnerGuard,
// SubscriptionGuard) are provided by the @Global SecurityGuardsModule.
// PackagesModule therefore no longer needs to import BillingModule (the
// original cycle source: PackagesModule → BillingModule → CheckoutModule
// → PackagesModule) nor to locally register guards (the hotfix workaround).
@Module({
  imports: [],
  controllers: [CoachPackagesController, ClientPackagesController],
  providers: [PackagesService, PurchaseFanoutService],
  exports: [PackagesService, PurchaseFanoutService],
})
export class PackagesModule {}
