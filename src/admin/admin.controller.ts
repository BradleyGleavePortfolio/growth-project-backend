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
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuditableRequest, AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { ServiceTokenGuard } from '../auth/service-token.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AdminService, decodeKeysetCursor } from './admin.service';
import { MetricsService } from './metrics.service';
import {
  AdminMetricsQueryDto,
  AuditLogQueryDto,
  BuildWeekEnrollmentsQueryDto,
  CoachAlertsQueryDto,
  CoachEffectivenessQueryDto,
  CoachOnboardingQueryDto,
  FederationSearchQueryDto,
  GdprScrubQueryDto,
  ListCoachesQueryDto,
  ListUsersQueryDto,
  PromoteUserDto,
  StripeEventsQueryDto,
} from './admin.dto';
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
@UseGuards(JwtAuthGuard, ServiceTokenGuard, RolesGuard)
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
  @ApiOperation({
    summary:
      'Platform overview metrics over a bounded window (since_days, default 30, max 365).',
  })
  async getMetrics(@Query() query: AdminMetricsQueryDto) {
    const sinceDays = query.since_days ?? 30;
    return this.metrics.getOverview({ sinceDays });
  }

  @Get('coaches')
  @ApiOperation({
    summary: 'List coaches, cursor-paginated by created_at (limit default 50, max 100).',
  })
  async listCoaches(@Query() query: ListCoachesQueryDto) {
    return this.admin.listCoaches({
      limit: query.limit,
      cursor: query.cursor ? decodeKeysetCursor(query.cursor) : undefined,
    });
  }

  @Get('coaches/:id')
  @ApiOperation({
    summary: 'Get a single coach detail with profile, students, and last-7d activity stats.',
  })
  async getCoach(@Param('id') id: string) {
    return this.admin.getCoachDetail(id);
  }

  @Get('users')
  @ApiOperation({
    summary:
      'List users with optional role/search filters, cursor-paginated by created_at (limit default 50, max 100).',
  })
  async listUsers(@Query() query: ListUsersQueryDto) {
    return this.admin.listUsers({
      role: query.role,
      q: query.q,
      limit: query.limit,
      cursor: query.cursor ? decodeKeysetCursor(query.cursor) : undefined,
    });
  }

  @Post('users/:id/promote')
  @ApiOperation({
    summary: 'Promote/demote a user between student/coach/owner; provisions a CoachProfile on coach.',
  })
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
  @ApiOperation({
    summary:
      'Read the immutable audit log with action/target/tenant filters and a before cursor.',
  })
  async listAuditLog(@Query() query: AuditLogQueryDto) {
    return this.admin.listAuditLog({
      action: query.action,
      targetUserId: query.target_user_id,
      tenantCoachId: query.tenant_coach_id,
      before: query.before,
      limit: query.limit,
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
  @ApiOperation({
    summary:
      'List processed Stripe webhook events (idempotency mirror) with type filter and before cursor.',
  })
  async listStripeEvents(@Query() query: StripeEventsQueryDto) {
    const beforeDate = query.before ? new Date(query.before) : undefined;
    return this.admin.listStripeProcessedEvents({
      type: query.type?.trim() || undefined,
      before:
        beforeDate && !Number.isNaN(beforeDate.getTime())
          ? beforeDate
          : undefined,
      limit: query.limit,
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
  @ApiOperation({
    summary: 'Unified fitness+finance federation search across users (bounded limit).',
  })
  async federationSearch(@Query() query: FederationSearchQueryDto) {
    return this.federation.unifiedSearch(query.q ?? '', query.limit);
  }

  @Get('federation/clients/lookup')
  @ApiOperation({
    summary: 'Look up a unified client record across products by email.',
  })
  async federationClientLookup(@Query('email') email?: string) {
    return this.federation.unifiedClient(email ?? '');
  }

  @Get('federation/coaches/lookup')
  @ApiOperation({
    summary: 'Look up a unified coach record across products by email.',
  })
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
  @ApiOperation({
    summary: 'Console alias for unified federation search (bounded limit).',
  })
  async consoleSearch(@Query() query: FederationSearchQueryDto) {
    return this.federation.unifiedSearch(query.q ?? '', query.limit);
  }

  @Get('coaches/:id/overview')
  @ApiOperation({ summary: 'Console coach overview for the account-management surface.' })
  async consoleCoachOverview(@Param('id') id: string) {
    return this.console.getCoachOverview(id);
  }

  @Get('clients/:id')
  @ApiOperation({ summary: 'Console unified client record by id.' })
  async consoleClient(@Param('id') id: string) {
    return this.console.getClientUnified(id);
  }

  @Get('clients/:id/unified')
  @ApiOperation({ summary: 'Console unified client record by id (explicit /unified alias).' })
  async consoleClientUnified(@Param('id') id: string) {
    return this.console.getClientUnified(id);
  }

  // Dedicated entitlement read for the admin console's entitlement chip /
  // "Plan & Access" tab. Returns just the entitlement block so the console
  // can render the bundle and per-product status without loading the full
  // unified record. Same OWNER-only gating as the rest of /admin/*.
  @Get('clients/:id/entitlements')
  @ApiOperation({ summary: "Console client entitlements block for the Plan & Access tab." })
  async consoleClientEntitlements(@Param('id') id: string) {
    return this.console.getClientEntitlements(id);
  }

  @Get('coaches/:id/entitlements')
  @ApiOperation({ summary: 'Console coach entitlements block.' })
  async consoleCoachEntitlements(@Param('id') id: string) {
    return this.console.getCoachEntitlements(id);
  }

  @Get('finance/health')
  @ApiOperation({
    summary: 'Console finance-backend health pill (explicit status when degraded/unreachable).',
  })
  async consoleFinanceHealth() {
    return this.financeFederation.getHealth();
  }

  @Get('integrations/status')
  @ApiOperation({
    summary: 'Console integrations status across federated finance integrations.',
  })
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
  @ApiOperation({
    summary: 'Console product-wide usage split sourced from finance aggregates (explicit status).',
  })
  async consoleProductUsage() {
    return this.financeFederation.getProductUsage();
  }

  // OWNER-only consent visibility. Returns the full per-(coach, scope)
  // consent matrix for one client so the admin console can render the
  // client's privacy state across every coach they have ever interacted
  // with. Read-only — owners do not flip consent on a client's behalf.
  @Get('clients/:id/consent')
  @ApiOperation({
    summary: "Read a client's full per-(coach, scope) consent matrix (read-only).",
  })
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
  @ApiOperation({
    summary: 'Manually trigger (or dry-run) the GDPR scrub worker; actor captured on the audit row.',
  })
  async runGdprScrub(
    @Request() req: AuthedRequest,
    @Query() query: GdprScrubQueryDto,
  ) {
    const dryRun =
      typeof query.dry_run === 'string'
        ? ['true', '1', 'yes'].includes(query.dry_run.toLowerCase())
        : undefined;
    return this.gdprScrub.run({
      dryRun,
      limit: query.limit,
      actorUserId: req.user.id,
      actorEmail: req.user.email ?? null,
    });
  }

  // Phase 6A — Coach effectiveness scoreboard. Latest score per active
  // coach, sorted by score DESC by default (null scores last). The
  // "score history" detail endpoint returns up to the trailing N rows.
  @Get('coach-effectiveness')
  @ApiOperation({
    summary: 'Coach effectiveness scoreboard: latest score per coach, sorted DESC (nulls last).',
  })
  async listCoachEffectiveness() {
    return this.coachEffectiveness.listAll();
  }

  @Get('coach-effectiveness/:coachId')
  @ApiOperation({
    summary: 'Coach effectiveness detail: latest score plus trailing score history (bounded limit).',
  })
  async getCoachEffectiveness(
    @Param('coachId') coachId: string,
    @Query() query: CoachEffectivenessQueryDto,
  ) {
    const [latest, history] = await Promise.all([
      this.coachEffectiveness.getLatest(coachId),
      this.coachEffectiveness.listHistory(coachId, query.limit ?? 30),
    ]);
    return { latest, history };
  }

  // Phase 6D — OWNER list of every coach's onboarding wizard progress.
  // Filter ?completed=true|false to slice to finished / in-flight only.
  // Used by the admin console to spot stalled coaches and re-engage.
  @Get('coach-onboarding')
  @ApiOperation({
    summary: 'List coach onboarding-wizard progress; filter completed=true|false (bounded limit).',
  })
  async listCoachOnboarding(@Query() query: CoachOnboardingQueryDto) {
    return this.coachOnboarding.listAllProgress({
      completed: query.completed,
      limit: query.limit,
    });
  }

  // Phase 6B — OWNER-only red-flag alert aggregator across coaches.
  // Optional ?coach_id and ?since filters; default returns the most
  // recent COACH_ALERT_BATCH_LIMIT-bounded slice.
  @Get('coach-alerts')
  @ApiOperation({
    summary: 'Red-flag alert aggregator across coaches with coach_id/since filters (bounded limit).',
  })
  async listCoachAlerts(@Query() query: CoachAlertsQueryDto) {
    const since = query.since ? new Date(query.since) : undefined;
    const safeSince =
      since instanceof Date && !Number.isNaN(since.getTime())
        ? since
        : undefined;
    return this.coachAlerts.listAllForOwner({
      coachId: query.coach_id ?? undefined,
      since: safeSince,
      limit: query.limit,
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
  @ApiOperation({
    summary:
      'List Build Week enrollments with status/completed_after filters and a before cursor (bounded limit).',
  })
  async listBuildWeekEnrollments(@Query() query: BuildWeekEnrollmentsQueryDto) {
    const completedAfter = parseDateParam(query.completed_after);
    const before = parseDateParam(query.before);
    return this.buildWeek.listEnrollments({
      status: query.status,
      completedAfter,
      before,
      limit: query.limit,
    });
  }

  @Get('build-week/funnel')
  @ApiOperation({
    summary: 'Build Week funnel: total enrolled, completion rate, per-day reached/dropped counts.',
  })
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
