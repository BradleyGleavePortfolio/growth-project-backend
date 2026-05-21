import { Module } from '@nestjs/common';
import {
  ClientPackagesController,
  CoachPackagesController,
} from './packages.controller';
import { PackagesService } from './packages.service';

// CoachPackage CRUD. Exports PackagesService so CheckoutModule (Phase 3)
// can read packages and cache Stripe Price ids back onto rows after lazy
// Product/Price creation.
//
// Guards used by this module's controllers (JwtAuthGuard, CoachOrOwnerGuard,
// SubscriptionGuard) are provided by the @Global SecurityGuardsModule.
// PackagesModule therefore no longer needs to import BillingModule (the
// original cycle source: PackagesModule → BillingModule → CheckoutModule
// → PackagesModule) nor to locally register guards (the hotfix workaround).
@Module({
  imports: [],
  controllers: [CoachPackagesController, ClientPackagesController],
  providers: [PackagesService],
  exports: [PackagesService],
})
export class PackagesModule {}
