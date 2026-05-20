import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { SubscriptionGuard } from '../billing/subscription.guard';
import { CoachOrOwnerGuard } from '../common/guards/coach-or-owner.guard';
import {
  ClientPackagesController,
  CoachPackagesController,
} from './packages.controller';
import { PackagesService } from './packages.service';

// CoachPackage CRUD. Exports PackagesService so CheckoutModule (Phase 3)
// can read packages and cache Stripe Price ids back onto rows after lazy
// Product/Price creation.
//
// IMPORTANT — circular-dependency fix (hotfix 2026-05-20):
// Previously imported BillingModule solely to obtain SubscriptionGuard
// for the coach packages controller. That created a cycle:
//   PackagesModule → BillingModule → CheckoutModule → PackagesModule
// which crashed boot with UndefinedModuleException after the AuthModule
// edge of a related cycle was broken. SubscriptionGuard only depends on
// PrismaService (global) + Reflector + optional AnalyticsService (global),
// so providing it locally is safe and breaks the cycle without changing
// runtime behaviour.
@Module({
  imports: [],
  controllers: [CoachPackagesController, ClientPackagesController],
  providers: [
    PackagesService,
    // Both controllers reference @UseGuards(JwtAuthGuard, ...). Global APP_GUARD
    // already covers JWT auth, but providing the guards locally matches the
    // controllers' decorators exactly so future scope changes don't silently
    // bypass auth. JwtAuthGuard needs JwksVerifierService (local), PtmService
    // (global), PrismaService (global). Reflector is core.
    JwtAuthGuard,
    JwksVerifierService,
    SubscriptionGuard,
    CoachOrOwnerGuard,
  ],
  exports: [PackagesService],
})
export class PackagesModule {}
