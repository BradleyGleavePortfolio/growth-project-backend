import { Module } from '@nestjs/common';
import {
  ClientPackagesController,
  CoachPackagesController,
} from './packages.controller';
import { CoachPackageContentsController } from './package-contents.controller';
import { PackagesService } from './packages.service';
import { PackageContentsService } from './package-contents.service';
import { PurchaseFanoutService } from './purchase-fanout.service';
import { DripDispatcherCron } from './drip-dispatcher.cron';
import { DripTriggerService } from './drip-trigger.service';
import { MilestoneService } from './milestone.service';
import { NotificationsModule } from '../notifications/notifications.module';

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
// PR-10 — DripDispatcherCron is registered as a provider on this module.
// AssignableAssetResolverRegistry is supplied via the @Global
// AssignableAssetResolversModule (registered at the AppModule level), so
// no extra import is needed here. NotificationsModule IS imported because
// the cron sends buyer push/in-app + coach COACH_ALERT directly through
// NotificationsService (mirrors PR-2's transfer.failed pattern in
// billing.service.ts:1115). NotificationsModule has no inbound edge to
// PackagesModule, so this does not create a cycle.
@Module({
  imports: [NotificationsModule],
  controllers: [
    CoachPackagesController,
    ClientPackagesController,
    CoachPackageContentsController,
  ],
  providers: [
    PackagesService,
    PackageContentsService,
    PurchaseFanoutService,
    DripDispatcherCron,
    DripTriggerService,
    MilestoneService,
  ],
  exports: [
    PackagesService,
    PackageContentsService,
    PurchaseFanoutService,
    DripDispatcherCron,
    DripTriggerService,
    MilestoneService,
  ],
})
export class PackagesModule {}
