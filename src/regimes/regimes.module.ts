/**
 * RegimesModule — F2 named-regimes + partial-refund decision surface.
 *
 * AuthModule wires JwtAuthGuard + JwksVerifierService into this module's DI
 * scope so @UseGuards(JwtAuthGuard, RolesGuard) resolves locally (mirrors
 * WorkoutBuilderModule). RolesGuard is provided locally because it is not
 * @Global. Both controllers carry class-level @Roles('coach') and the
 * NamedRegimesFeatureGuard (also provided here).
 *
 * PackagesModule (forwardRef) provides PurchaseFanoutService so the
 * "unassign_drops" decision can cancel pending drops. forwardRef is defensive
 * against future cross-module cycles, mirroring WorkoutBuilderModule.
 *
 * Exports PartialRefundDecisionService so the CheckoutModule's
 * RefundDisputeHandlerService can invoke the partial-refund hook.
 */

import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RolesGuard } from '../auth/roles.guard';
import { PackagesModule } from '../packages/packages.module';
import { NamedRegimesFeatureGuard } from './named-regimes-feature.guard';
import { PartialRefundDecisionService } from './partial-refund-decision.service';
import { RefundDecisionsController } from './refund-decisions.controller';
import { RegimeRevisionRetentionService } from './regime-revision-retention.service';
import { RegimesController } from './regimes.controller';
import { RegimesService } from './regimes.service';

@Module({
  // forwardRef on BOTH imports: RegimesModule sits inside a module require
  // cycle (CheckoutModule → RegimesModule → PackagesModule → BillingModule →
  // CheckoutModule). Without the lazy refs the cycle can evaluate
  // regimes.module.ts before auth.module.ts / packages.module.ts finish, so
  // those imports resolve `undefined` at decorator-eval time. The thunks defer
  // resolution until Nest's scan, by which point both modules are defined.
  imports: [forwardRef(() => AuthModule), forwardRef(() => PackagesModule)],
  controllers: [RegimesController, RefundDecisionsController],
  providers: [
    RegimesService,
    RegimeRevisionRetentionService,
    PartialRefundDecisionService,
    NamedRegimesFeatureGuard,
    RolesGuard,
  ],
  exports: [PartialRefundDecisionService, RegimeRevisionRetentionService],
})
export class RegimesModule {}
