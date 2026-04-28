import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RolesGuard } from '../auth/roles.guard';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { MetricsService } from './metrics.service';
import { FederationService } from './federation/federation.service';
import { FinanceAdminClient } from './federation/finance-admin.client';
import { AdminConsoleService } from './console/admin-console.service';
import { FinanceFederationService } from './console/finance-federation.service';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';
import { UsersModule } from '../users/users.module';

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
// ReportsController + ReportsService back the operational export surface
// at /admin/reports/* (CSV + JSON downloads of metrics, coaches, clients,
// past-due billing, product usage, federation health, audit summary).
@Module({
  imports: [AuthModule, UsersModule],
  controllers: [AdminController, ReportsController],
  providers: [
    AdminService,
    MetricsService,
    RolesGuard,
    FinanceAdminClient,
    FederationService,
    AdminConsoleService,
    FinanceFederationService,
    ReportsService,
  ],
  exports: [
    AdminService,
    MetricsService,
    FederationService,
    FinanceAdminClient,
    AdminConsoleService,
    FinanceFederationService,
    ReportsService,
  ],
})
export class AdminModule {}
