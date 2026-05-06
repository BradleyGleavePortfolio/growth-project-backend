import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { MetricsService } from '../metrics.service';
import { FinanceFederationService } from '../console/finance-federation.service';
import { AuditService } from '../../audit/audit.service';
import { PtmWeightedService } from '../../ptm/ptm-weighted.service';
import { PTM_WINDOWS } from '../../ptm/ptm.types';

// ReportsService composes operational reports for the OWNER admin surface.
//
// Hard rules:
//   - Every value comes from an authoritative source already in the
//     codebase: Postgres (Prisma), the Stripe-mirrored Invoice/Subscription
//     tables, the AuditLog table, or the finance federation contract. No
//     report fabricates a metric.
//   - Reports return a `generated_at` ISO timestamp so a CSV/JSON dump on
//     disk is self-describing.
//   - Where a number is window-scoped (last N days), the window is
//     surfaced explicitly so the report header carries its provenance.
//   - When an underlying source is degraded (finance backend unreachable),
//     the report carries the degraded-state envelope from the federation
//     services rather than zeros.

export interface ReportEnvelope<T> {
  report: string;
  generated_at: string;
  window?: { since_days: number; since: string } | null;
  data: T;
}

export interface CoachRow {
  id: string;
  email: string;
  name: string;
  created_at: string;
  business_name: string | null;
  invite_code: string | null;
  subscription_status: string | null;
  plan_tier: string | null;
  client_count: number;
  active_client_count: number;
}

export interface ClientRow {
  id: string;
  email: string;
  name: string;
  created_at: string;
  archived_at: string | null;
  coach_id: string | null;
  coach_email: string | null;
  deletion_scheduled_at: string | null;
}

export interface BillingPastDueRow {
  coach_id: string;
  coach_email: string;
  status: string;
  current_period_end: string | null;
  last_payment_failed_at: string | null;
  failed_payments_this_month: number;
  cancel_at_period_end: boolean;
  billing_email: string | null;
}

export interface AuditSummaryRow {
  id: string;
  created_at: string;
  action: string;
  actor_id: string | null;
  actor_role: string | null;
  actor_email: string | null;
  target_user_id: string | null;
  target_type: string | null;
  target_id: string | null;
  tenant_coach_id: string | null;
  ip: string | null;
}

// Per-row shape of the ptm-signal-weights report. One row per signal
// type the trainer learned a weight for. CSV consumers (operators) pull
// this into a spreadsheet to inspect which signals correlate with
// which cohort. The shape mirrors PtmTrainedWeight verbatim, plus the
// `basis` column so a CSV merged across runs is self-describing.
export interface PtmSignalWeightRow {
  signal_type: string;
  weight: number;
  training_count: number;
  training_max: number;
  success_avg: number;
  failure_avg: number;
  basis: 'weighted_v2';
}

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

@Injectable()
export class ReportsService {
  constructor(
    private prisma: PrismaService,
    private metrics: MetricsService,
    private financeFederation: FinanceFederationService,
    private audit: AuditService,
    private ptmWeighted: PtmWeightedService,
  ) {}

  private envelope<T>(
    report: string,
    data: T,
    window?: { since_days: number; since: string } | null,
  ): ReportEnvelope<T> {
    return {
      report,
      generated_at: new Date().toISOString(),
      window: window ?? null,
      data,
    };
  }

  // Wraps the existing /admin/metrics counters so a single report file
  // captures the whole operational dashboard at a point in time. CSV form
  // flattens the nested counters into key/value rows; the JSON form is
  // identical to the live endpoint so downstream pipelines can re-use the
  // same parser.
  async metricsOverview(opts: { sinceDays?: number } = {}) {
    const overview = await this.metrics.getOverview(opts);
    return this.envelope('metrics-overview', overview, overview.window);
  }

  // OWNER-only roster of every coach with their headline operational
  // fields. We deliberately keep the column set narrow so the CSV is
  // safe to share with finance/legal — no per-client PII appears in this
  // report (use the coach-detail endpoint for that).
  async coaches(): Promise<ReportEnvelope<CoachRow[]>> {
    const coaches = await this.prisma.user.findMany({
      where: { role: 'coach' },
      orderBy: { created_at: 'asc' },
      include: {
        coach_profile: {
          select: {
            business_name: true,
            invite_code: true,
            subscription_status: true,
            plan_tier: true,
          },
        },
        students: { select: { archived_at: true } },
      },
    });
    const rows: CoachRow[] = coaches.map((c) => ({
      id: c.id,
      email: c.email,
      name: c.name,
      created_at: c.created_at.toISOString(),
      business_name: c.coach_profile?.business_name ?? null,
      invite_code: c.coach_profile?.invite_code ?? null,
      subscription_status: c.coach_profile?.subscription_status ?? null,
      plan_tier: c.coach_profile?.plan_tier ?? null,
      client_count: c.students.length,
      active_client_count: c.students.filter((s) => !s.archived_at).length,
    }));
    return this.envelope('coaches', rows);
  }

  // OWNER-only roster of every client (role=student). For privacy this
  // intentionally excludes any per-record activity counters — a coach's
  // 7-day stats live behind the coach-detail endpoint and are not
  // appropriate for a flat CSV export. The coach_email column joins
  // through User.coach to surface tenancy without a second query.
  async clients(opts: { limit?: number } = {}): Promise<ReportEnvelope<ClientRow[]>> {
    const limit = clampLimit(opts.limit);
    const students = await this.prisma.user.findMany({
      where: { role: 'student' },
      orderBy: { created_at: 'asc' },
      take: limit,
      include: { coach: { select: { email: true } } },
    });
    const rows: ClientRow[] = students.map((s) => ({
      id: s.id,
      email: s.email,
      name: s.name,
      created_at: s.created_at.toISOString(),
      archived_at: s.archived_at ? s.archived_at.toISOString() : null,
      coach_id: s.coach_id ?? null,
      coach_email: s.coach?.email ?? null,
      deletion_scheduled_at: s.deletion_scheduled_at
        ? s.deletion_scheduled_at.toISOString()
        : null,
    }));
    return this.envelope('clients', rows);
  }

  // Past-due subscriptions. Pure read off the Stripe-mirrored
  // CoachSubscription rows — no synthesised dollar figures, no synthetic
  // dunning state. The operator uses this as a daily worklist.
  async billingPastDue(): Promise<ReportEnvelope<BillingPastDueRow[]>> {
    const subs = await this.prisma.coachSubscription.findMany({
      where: { status: 'past_due' },
      orderBy: { last_payment_failed_at: 'desc' },
      include: { coach: { select: { email: true } } },
    });
    const rows: BillingPastDueRow[] = subs.map((s) => ({
      coach_id: s.coach_id,
      coach_email: s.coach?.email ?? '',
      status: s.status,
      current_period_end: s.current_period_end
        ? s.current_period_end.toISOString()
        : null,
      last_payment_failed_at: s.last_payment_failed_at
        ? s.last_payment_failed_at.toISOString()
        : null,
      failed_payments_this_month: s.failed_payments_this_month,
      cancel_at_period_end: s.cancel_at_period_end,
      billing_email: s.billing_email ?? null,
    }));
    return this.envelope('billing-past-due', rows);
  }

  // Proxies the finance federation's product-usage envelope. The status
  // field comes from the federation contract — when finance is
  // unreachable the report carries `not_configured` / `auth_unconfigured`
  // / `degraded` so the operator can tell "0 finance users today" from
  // "we couldn't reach finance".
  async productUsage() {
    const usage = await this.financeFederation.getProductUsage();
    return this.envelope('product-usage', usage);
  }

  // Federation/integrations health snapshot. Wraps the same probe used by
  // the admin status pill so an operator can include the live finance
  // health state in an incident-postmortem export.
  async federationHealth() {
    const integrations = await this.financeFederation.getIntegrationsStatus();
    return this.envelope('federation-health', integrations);
  }

  // Flattened audit-log dump for compliance review. Filters mirror the
  // existing /admin/audit-log surface so an operator can pull the same
  // slice they reviewed in the console. `metadata` (a Json column) is
  // intentionally omitted from the row shape because per-action shapes
  // differ — fetch the full record from /admin/audit-log if needed.
  async auditSummary(params: {
    action?: string;
    targetUserId?: string;
    tenantCoachId?: string;
    sinceDays?: number;
    limit?: number;
  }): Promise<ReportEnvelope<AuditSummaryRow[]>> {
    const sinceDays = clampSinceDays(params.sinceDays);
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    const limit = clampLimit(params.limit);

    const where: Prisma.AuditLogWhereInput = { created_at: { gte: since } };
    if (params.action) where.action = { startsWith: params.action };
    if (params.targetUserId) where.target_user_id = params.targetUserId;
    if (params.tenantCoachId) where.tenant_coach_id = params.tenantCoachId;

    const logs = await this.prisma.auditLog.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: limit,
    });
    const rows: AuditSummaryRow[] = logs.map((l) => ({
      id: l.id,
      created_at: l.created_at.toISOString(),
      action: l.action,
      actor_id: l.actor_id ?? null,
      actor_role: l.actor_role ?? null,
      actor_email: l.actor_email_snapshot ?? null,
      target_user_id: l.target_user_id ?? null,
      target_type: l.target_type ?? null,
      target_id: l.target_id ?? null,
      tenant_coach_id: l.tenant_coach_id ?? null,
      ip: l.ip ?? null,
    }));
    return this.envelope('audit-summary', rows, {
      since_days: sinceDays,
      since: since.toISOString(),
    });
  }

  // PTM signal weights — surface the current trained weights of the
  // weighted_v2 engine for the OWNER. Below the activation threshold
  // (or with an empty cohort) the response carries
  // `basis: 'heuristic_v1'`, an empty `weights` array, and a `reason`
  // field so the operator can tell "0 trained weights" apart from
  // "engine not yet active".
  //
  // The CSV form serialises one row per learned weight with the
  // `basis` column included so a merged-across-runs CSV remains
  // self-describing.
  async ptmSignalWeights(): Promise<
    ReportEnvelope<PtmSignalWeightRow[]> & {
      basis: 'weighted_v2' | 'heuristic_v1';
      training_count: number;
      reason?: 'below_activation_threshold' | 'empty_cohort';
      activation_threshold?: number;
      success_count?: number;
      failure_count?: number;
      skipped_no_snapshot?: number;
      skipped_unclassified?: number;
    }
  > {
    const active = await this.ptmWeighted.isActive();
    const summary = await this.ptmWeighted.getCurrentWeights();
    const threshold = ptmActivationThreshold();

    const baseEnvelope = this.envelope<PtmSignalWeightRow[]>(
      'ptm-signal-weights',
      [],
    );

    if (!active) {
      const reason: 'below_activation_threshold' | 'empty_cohort' =
        summary.training_count < threshold
          ? 'below_activation_threshold'
          : 'empty_cohort';
      return {
        ...baseEnvelope,
        basis: 'heuristic_v1',
        training_count: summary.training_count,
        success_count: summary.success_count,
        failure_count: summary.failure_count,
        skipped_no_snapshot: summary.skipped_no_snapshot,
        skipped_unclassified: summary.skipped_unclassified,
        reason,
        activation_threshold: threshold,
      };
    }

    const rows: PtmSignalWeightRow[] = summary.weights.map((w) => ({
      signal_type: w.signal_type,
      weight: w.weight,
      training_count: w.training_count,
      training_max: w.training_max,
      success_avg: w.success_avg,
      failure_avg: w.failure_avg,
      basis: 'weighted_v2',
    }));

    return {
      ...baseEnvelope,
      data: rows,
      basis: 'weighted_v2',
      training_count: summary.training_count,
      success_count: summary.success_count,
      failure_count: summary.failure_count,
      skipped_no_snapshot: summary.skipped_no_snapshot,
      skipped_unclassified: summary.skipped_unclassified,
      activation_threshold: threshold,
    };
  }
}

// Mirrors the parsing logic in PtmWeightedService so the reports
// envelope can carry the activation threshold without round-tripping
// the env read through the service. Kept here (not in a shared util)
// because both call sites are tiny and the logic is two lines.
function ptmActivationThreshold(): number {
  const raw = process.env.PTM_WEIGHTED_ACTIVATION_OUTCOMES;
  if (raw === undefined || raw === '') {
    return PTM_WINDOWS.WEIGHTED_ACTIVATION_OUTCOMES;
  }
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return PTM_WINDOWS.WEIGHTED_ACTIVATION_OUTCOMES;
  }
  return parsed;
}

function clampLimit(raw: number | undefined): number {
  if (!Number.isFinite(raw as number)) return DEFAULT_LIMIT;
  const n = Math.floor(raw as number);
  if (n < 1) return DEFAULT_LIMIT;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

function clampSinceDays(raw: number | undefined): number {
  if (!Number.isFinite(raw as number)) return 30;
  const n = Math.floor(raw as number);
  if (n < 1) return 30;
  if (n > 365) return 365;
  return n;
}
