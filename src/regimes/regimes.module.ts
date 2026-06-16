/**
 * RegimesModule — F2 named-regimes + partial-refund decision surface.
 *
 * JwtAuthGuard + RolesGuard are NOT imported or provided here. They live in
 * the @Global SecurityGuardsModule (src/common/security/security-guards.module.ts),
 * so @UseGuards(JwtAuthGuard, RolesGuard) on this module's controllers resolves
 * from global DI scope. Importing AuthModule just to obtain those guards is the
 * exact anti-pattern that caused the hotfix #243 boot-crash cycle
 * (AuthModule → InviteCodesModule → BillingModule → CheckoutModule →
 * RegimesModule → AuthModule) — see SecurityGuardsModule's header. Both
 * controllers carry class-level @Roles('coach') plus NamedRegimesFeatureGuard
 * (provided locally below, since it is feature-scoped, not cross-cutting).
 *
 * PackagesModule provides PurchaseFanoutService so the "unassign_drops"
 * decision can cancel pending drops. PackagesModule imports only
 * NotificationsModule (it no longer imports BillingModule), so this edge does
 * not close a cycle back to CheckoutModule — no forwardRef needed.
 *
 * Exports PartialRefundDecisionService so the CheckoutModule's
 * RefundDisputeHandlerService can invoke the partial-refund hook.
 */

import { Module } from '@nestjs/common';
import { PackagesModule } from '../packages/packages.module';
import { NamedRegimesFeatureGuard } from './named-regimes-feature.guard';
import { PartialRefundDecisionService } from './partial-refund-decision.service';
import { RefundDecisionsController } from './refund-decisions.controller';
import { RegimeRevisionRetentionService } from './regime-revision-retention.service';
import { RegimesController } from './regimes.controller';
import { RegimesService } from './regimes.service';

@Module({
  imports: [PackagesModule],
  controllers: [RegimesController, RefundDecisionsController],
  providers: [
    RegimesService,
    RegimeRevisionRetentionService,
    PartialRefundDecisionService,
    NamedRegimesFeatureGuard,
  ],
  exports: [PartialRefundDecisionService, RegimeRevisionRetentionService],
})
export class RegimesModule {}
