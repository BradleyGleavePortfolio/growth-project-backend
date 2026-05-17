import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RolesGuard } from '../auth/roles.guard';
import { AdminController } from './admin.controller';
import { OwnerConsoleController } from './owner-console.controller';
import { ServiceTokenGuard } from '../auth/service-token.guard';
import { AdminService } from './admin.service';
import { MetricsService } from './metrics.service';
import { FederationService } from './federation/federation.service';
import { FinanceAdminClient } from './federation/finance-admin.client';
import { FederationInboundController } from './federation/federation-inbound.controller';
import { FederationInboundService } from './federation/federation-inbound.service';
import { AdminConsoleService } from './console/admin-console.service';
import { FinanceFederationService } from './console/finance-federation.service';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';
import { TransformationScorecardService } from './reports/transformation-scorecard.service';
import { EntitlementsService } from './entitlements/entitlements.service';
import { AdminPtmController } from './ptm/admin-ptm.controller';
import { AdminPtmService } from './ptm/admin-ptm.service';
import { Soc2EvidenceController } from './soc2/soc2-evidence.controller';
import { Soc2EvidenceService } from './soc2/soc2-evidence.service';
import { UsersModule } from '../users/users.module';
import { BuildWeekModule } from '../build-week/build-week.module';
import { CoachModule } from '../coach/coach.module';

// Phase 1A/1B platform admin module. AuthModule import wires
// JwtAuthGuard + JwksVerifierService into this module's DI scope so
// @UseGuards(JwtAuthGuard, RolesGuard) resolves locally. UsersModule
// is imported so the admin GDPR endpoints can call GdprScrubService
// without re-providing it (UsersModule is the canonical owner).
//
// FinanceAdminClient + FederationService back the OWNER-only cross-product
// federation endpoints under /admin/federation/*. AdminConsoleService and
// FinanceFederationService back the console-friendly aliases at
// /admin/search, /admin/coaches/:id/overview, /admin/clients/:id,
// /admin/finance/health, and /admin/integrations/status.
//
// FederationInboundController + FederationInboundService back the inbound
// finance-to-fitness PTM signal endpoint at
// POST /admin/federation/ptm-signal. Auth is a service-to-service bearer
// token (FINANCE_SERVICE_TOKEN) — JwtAuthGuard is bypassed via @Public()
// on the controller. PtmService resolves through the @Global PtmModule.
//
// ReportsController + ReportsService back the operational export surface
// at /admin/reports/* (CSV + JSON downloads of metrics, coaches, clients,
// past-due billing, product usage, federation health, audit summary).
//
// AdminPtmController + AdminPtmService back the OWNER-only PTM teaching
// surface at POST /admin/clients/:id/outcome,
// GET /admin/clients/:id/ptm, GET /admin/ptm/risk-board, and
// GET /admin/ptm/outcome-history. PtmService and PtmRecomputeService
// resolve through the @Global PtmModule.
//
// Phase 1E: CoachModule is wrapped in forwardRef() to break the
// AdminModule ↔ CoachModule circular reference introduced when CoachModule
// began importing AdminModule for AdminPtmService. forwardRef() on both
// sides is the idiomatic NestJS resolution; the runtime graph is identical
// to the previous direct import.
//
// Phase 10 (SOC 2): Soc2EvidenceController + Soc2EvidenceService back the
// OWNER-only compliance snapshot endpoint at
// GET /admin/soc2/evidence-snapshot. See docs/soc2/ for the full
// compliance documentation set.
@Module({
  imports: [AuthModule, UsersModule, BuildWeekModule, forwardRef(() => CoachModule)],
  controllers: [
    AdminController,
    OwnerConsoleController,
    ReportsController,
    AdminPtmController,
    FederationInboundController,
    Soc2EvidenceController,
  ],
  providers: [
    AdminService,
    MetricsService,
    RolesGuard,
    ServiceTokenGuard,
    FinanceAdminClient,
    FederationService,
    FederationInboundService,
    AdminConsoleService,
    FinanceFederationService,
    ReportsService,
    TransformationScorecardService,
    EntitlementsService,
    AdminPtmService,
    Soc2EvidenceService,
  ],
  exports: [
    AdminService,
    MetricsService,
    FederationService,
    FinanceAdminClient,
    AdminConsoleService,
    FinanceFederationService,
    ReportsService,
    EntitlementsService,
    AdminPtmService,
    Soc2EvidenceService,
  ],
})
export class AdminModule {}
