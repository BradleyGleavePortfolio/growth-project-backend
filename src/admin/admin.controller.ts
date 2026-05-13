import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuditableRequest, AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AdminService } from './admin.service';
import { MetricsService } from './metrics.service';
import { PromoteUserDto } from './admin.dto';
import { FederationService } from './federation/federation.service';
import { AdminConsoleService } from './console/admin-console.service';
import { FinanceFederationService } from './console/finance-federation.service';
import { GdprScrubService } from '../users/gdpr-scrub.service';
import { ConsentService } from '../consent/consent.service';
import { CoachEffectivenessService } from '../coach/coach-effectiveness.service';
import { CoachAlertsService } from '../coach/coach-alerts.service';
import { CoachOnboardingService } from '../coach/coach-onboarding.service';
import { BuildWeekService } from '../build-week/build-week.service';

// Phase 1A/1B: OWNER-only platform admin surface. Every route here is
// gated by JwtAuthGuard + RolesGuard with @Roles('owner') so a coach or
// student hitting these gets a clean 403, not a leak.
@ApiTags('admin')
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner')
export class AdminController {
  constructor(
    private admin: AdminService,
    private metrics: MetricsService,
    private federation: FederationService,
    private console: AdminConsoleService,
    private financeFederation: FinanceFederationService,
    private gdprScrub: GdprScrubService,
    private consent: ConsentService,
    private coachEffectiveness: CoachEffectivenessService,
    private coachAlerts: CoachAlertsService,
    private coachOnboarding: CoachOnboardingService,
    private buildWeek: BuildWeekService,
  ) {}

  // OWNER-only platform metrics. Counters are derived from Postgres rows
  // we have actually written — no synthetic revenue, no fabricated MAU.
  // Stripe-sourced money figures come from the Invoice mirror table.
  // Window defaults to 30 days; clamp to a sane range to keep the query
  // cheap and bounded.
  @Get('metrics')
  async getMetrics(@Query('since_days') sinceDaysRaw?: string) {
    const parsed = sinceDaysRaw ? parseInt(sinceDaysRaw, 10) : NaN;
    const sinceDays =
      Number.isFinite(parsed) && parsed > 0 && parsed <= 365 ? parsed : 30;
    return this.metrics.getOverview({ sinceDays });
  }

  @Get('coaches')
  async listCoaches() {
    return this.admin.listCoaches();
  }

  @Get('coaches/:id')
  async getCoach(@Param('id') id: string) {
    return this.admin.getCoachDetail(id);
  }

  @Get('users')
  async listUsers(
    @Query('role') role?: 'owner' | 'coach' | 'student',
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    return this.admin.listUsers({
      role,
      q,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Post('users/:id/promote')
  async promoteUser(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: PromoteUserDto,
  ) {
    return this.admin.promoteUser(
      req.user.id,
      id,
      body.role,
      {
        business_name: body.business_name,
        bio: body.bio,
        timezone: body.timezone,
      },
      auditContext(req),
    );
  }

  // OWNER-only audit-log read surface. Filters cover the common forensic
  // queries (by action, target user, tenant coach) plus a `before` cursor
  // for pagination.
  @Get('audit-log')
  async listAuditLog(
    @Query('action') action?: string,
    @Query('target_user_id') targetUserId?: string,
    @Query('tenant_coach_id') tenantCoachId?: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    return this.admin.listAuditLog({
      action,
      targetUserId,
      tenantCoachId,
      before,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  // OWNER-only Stripe webhook delivery log. Returns the rows the webhook
  // controller wrote into the idempotency table (StripeProcessedEvent) so
  // operators can verify deliveries landed end-to-end without bouncing
  // through the Stripe dashboard. Supports `type` filter and `before`
  // keyset cursor for paging.
  //
  // Audit reference: /audits/00_MASTER_REPORT.md line 202 (Admin/payment P0).
  @Get('stripe/events')
  async listStripeEvents(
    @Query('type') type?: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    const beforeDate = before ? new Date(before) : undefined;
    return this.admin.listStripeProcessedEvents({
      type: type?.trim() || undefined,
      before:
        beforeDate && !Number.isNaN(beforeDate.getTime())
          ? beforeDate
          : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  // OWNER-only cross-product (fitness + finance) federation surface.
  // FederationService composes a fitness Postgres read with an outbound
  // call to the finance backend's admin federation endpoints; both blocks
  // are returned with explicit `products` split so the admin console can
  // render product usage without recomputing.
  //
  // When the finance backend is unreachable or unconfigured, `finance.status`
  // explicitly carries the failure mode (`not_configured`, `auth_unconfigured`,
  // `timeout`, `network_error`, `http_error`, `malformed_response`) so the
  // console can render a degraded-state pill — no fake data is ever returned.
  @Get('federation/search')
  async federationSearch(
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    return this.federation.unifiedSearch(
      q ?? '',
      limit ? parseInt(limit, 10) : undefined,
    );
  }

  @Get('federation/clients/lookup')
  async federationClientLookup(@Query('email') email?: string) {
    return this.federation.unifiedClient(email ?? '');
  }

  @Get('federation/coaches/lookup')
  async federationCoachLookup(@Query('email') email?: string) {
    return this.federation.unifiedCoach(email ?? '');
  }

  // -------------------------------------------------------------------
  // Console-friendly aliases.
  //
  // The admin console renders a Healthie/EHR-style account-management
  // surface. It speaks in terms of "search", "coach overview", "client
  // unified record", "finance health", and "integrations status" rather
  // than the federation primitives. These routes exist so the console
  // does not need to know about the federation/* path layout — they are
  // thin wrappers over the same OWNER-gated services and never invent
  // data. Every finance value comes from FederationService /
  // FinanceFederationService and carries an explicit status field.
  // -------------------------------------------------------------------

  @Get('search')
  async consoleSearch(
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    return this.federation.unifiedSearch(
      q ?? '',
      limit ? parseInt(limit, 10) : undefined,
    );
  }

  @Get('coaches/:id/overview')
  async consoleCoachOverview(@Param('id') id: string) {
    return this.console.getCoachOverview(id);
  }

  @Get('clients/:id')
  async consoleClient(@Param('id') id: string) {
    return this.console.getClientUnified(id);
  }

  @Get('clients/:id/unified')
  async consoleClientUnified(@Param('id') id: string) {
    return this.console.getClientUnified(id);
  }

  // Dedicated entitlement read for the admin console's entitlement chip /
  // "Plan & Access" tab. Returns just the entitlement block so the console
  // can render the bundle and per-product status without loading the full
  // unified record. Same OWNER-only gating as the rest of /admin/*.
  @Get('clients/:id/entitlements')
  async consoleClientEntitlements(@Param('id') id: string) {
    return this.console.getClientEntitlements(id);
  }

  @Get('coaches/:id/entitlements')
  async consoleCoachEntitlements(@Param('id') id: string) {
    return this.console.getCoachEntitlements(id);
  }

  @Get('finance/health')
  async consoleFinanceHealth() {
    return this.financeFederation.getHealth();
  }

  @Get('integrations/status')
  async consoleIntegrationsStatus() {
    return this.financeFederation.getIntegrationsStatus();
  }

  // Aggregate product-wide usage split sourced from the finance backend's
  // /api/admin/federation/usage/product endpoint. The console uses this to
  // render its product-usage widget alongside the per-record federation
  // surface; values come straight from finance Postgres aggregates and
  // carry an explicit status field when finance is unreachable so the
  // console can surface "finance not configured" / "degraded" instead of
  // an empty chart.
  @Get('product/usage')
  async consoleProductUsage() {
    return this.financeFederation.getProductUsage();
  }

  // OWNER-only consent visibility. Returns the full per-(coach, scope)
  // consent matrix for one client so the admin console can render the
  // client's privacy state across every coach they have ever interacted
  // with. Read-only — owners do not flip consent on a client's behalf.
  @Get('clients/:id/consent')
  async getClientConsent(@Param('id') id: string) {
    return this.consent.listForClientAdmin(id);
  }

  // OWNER-only manual trigger / dry-run for the GDPR scrub worker. The
  // canonical scheduled invocation is `scripts/gdpr-scrub.ts` driven by a
  // Fly cron; this endpoint exists so an operator can:
  //
  //   - Inspect candidates safely with `dry_run=true` before flipping the
  //     cron job on for the first time.
  //   - Run a single batch on demand from the admin console for an
  //     out-of-band legal request that needs to land before the next cron
  //     tick.
  //
  // Either way the actor is captured on the audit row so the run is
  // attributable. Default behavior is to honor `GDPR_SCRUB_DRY_RUN` env
  // when the query param is unset.
  @Post('gdpr/scrub')
  async runGdprScrub(
    @Request() req: AuthedRequest,
    @Query('dry_run') dryRunRaw?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const dryRun =
      typeof dryRunRaw === 'string'
        ? ['true', '1', 'yes'].includes(dryRunRaw.toLowerCase())
        : undefined;
    const parsedLimit = limitRaw ? parseInt(limitRaw, 10) : NaN;
    return this.gdprScrub.run({
      dryRun,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      actorUserId: req.user.id,
      actorEmail: req.user.email ?? null,
    });
  }

  // Phase 6A — Coach effectiveness scoreboard. Latest score per active
  // coach, sorted by score DESC by default (null scores last). The
  // "score history" detail endpoint returns up to the trailing N rows.
  @Get('coach-effectiveness')
  async listCoachEffectiveness() {
    return this.coachEffectiveness.listAll();
  }

  @Get('coach-effectiveness/:coachId')
  async getCoachEffectiveness(
    @Param('coachId') coachId: string,
    @Query('limit') limitRaw?: string,
  ) {
    const parsed = limitRaw ? parseInt(limitRaw, 10) : NaN;
    const limit = Number.isFinite(parsed) ? parsed : undefined;
    const [latest, history] = await Promise.all([
      this.coachEffectiveness.getLatest(coachId),
      this.coachEffectiveness.listHistory(coachId, limit ?? 30),
    ]);
    return { latest, history };
  }

  // Phase 6D — OWNER list of every coach's onboarding wizard progress.
  // Filter ?completed=true|false to slice to finished / in-flight only.
  // Used by the admin console to spot stalled coaches and re-engage.
  @Get('coach-onboarding')
  async listCoachOnboarding(
    @Query('completed') completed?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const completedFilter =
      completed === 'true' ? 'true' : completed === 'false' ? 'false' : undefined;
    const parsed = limitRaw ? parseInt(limitRaw, 10) : NaN;
    const limit = Number.isFinite(parsed) ? parsed : undefined;
    return this.coachOnboarding.listAllProgress({
      completed: completedFilter,
      limit,
    });
  }

  // Phase 6B — OWNER-only red-flag alert aggregator across coaches.
  // Optional ?coach_id and ?since filters; default returns the most
  // recent COACH_ALERT_BATCH_LIMIT-bounded slice.
  @Get('coach-alerts')
  async listCoachAlerts(
    @Query('coach_id') coachId?: string,
    @Query('since') sinceRaw?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const since = sinceRaw ? new Date(sinceRaw) : undefined;
    const safeSince =
      since instanceof Date && !Number.isNaN(since.getTime())
        ? since
        : undefined;
    const parsedLimit = limitRaw ? parseInt(limitRaw, 10) : NaN;
    return this.coachAlerts.listAllForOwner({
      coachId: coachId ?? undefined,
      since: safeSince,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    });
  }

  // Phase 4 — OWNER-only Build Week visibility.
  //
  // /admin/build-week/enrollments   — list with status / completed_after /
  //                                   before-cursor / limit. Cursor is the
  //                                   started_at of the previous page's
  //                                   last row (descending order).
  // /admin/build-week/funnel        — total enrolled, completion rate, and
  //                                   per-day reached/dropped counts. Used
  //                                   by the admin console funnel chart.
  @Get('build-week/enrollments')
  async listBuildWeekEnrollments(
    @Query('status') status?: string,
    @Query('completed_after') completedAfterRaw?: string,
    @Query('before') beforeRaw?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const completedAfter = parseDateParam(completedAfterRaw);
    const before = parseDateParam(beforeRaw);
    const parsedLimit = limitRaw ? parseInt(limitRaw, 10) : NaN;
    return this.buildWeek.listEnrollments({
      status,
      completedAfter,
      before,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    });
  }

  @Get('build-week/funnel')
  async getBuildWeekFunnel() {
    return this.buildWeek.funnel();
  }
}

// Best-effort extraction of remote IP + User-Agent from the express request,
// used as audit-log context. Handles the common `x-forwarded-for` chain set
// by Fly.io's edge proxy. Returns nulls when fields are absent — callers
// already accept null.
function auditContext(req: AuditableRequest): { ip: string | null; userAgent: string | null } {
  const xffRaw = req?.headers?.['x-forwarded-for'];
  const xff = Array.isArray(xffRaw) ? xffRaw[0] : xffRaw || '';
  const fwdIp = xff.split(',')[0]?.trim();
  const ip = fwdIp || req?.ip || req?.socket?.remoteAddress || null;
  const uaRaw = req?.headers?.['user-agent'];
  const userAgent = Array.isArray(uaRaw) ? uaRaw[0] ?? null : uaRaw ?? null;
  return { ip: ip || null, userAgent: userAgent || null };
}

// Parse an ISO-8601 date string from a query param. Returns undefined for
// missing or unparseable input — callers treat undefined as "no filter".
function parseDateParam(value?: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
