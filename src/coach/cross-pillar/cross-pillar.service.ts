import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { FederationService } from '../../admin/federation/federation.service';
import { FinanceAdminClient } from '../../admin/federation/finance-admin.client';
import type {
  FinanceCallOutcome,
  FinanceClientSummary,
  FinanceProductUsage,
} from '../../admin/federation/finance-contracts';

/**
 * CrossPillarService
 *
 * Coach-facing orchestration for the Stage-3 cross-pillar surface
 * (`/api/coach/cross-pillar/*`). Reuses the existing OWNER-only
 * `FederationService` (search + by-email lookups) and `FinanceAdminClient`
 * (low-level finance fan-out) — Stage-3 does NOT introduce a parallel
 * federation pipe. The new shape here is "coach-scoped" rather than
 * "platform-wide".
 *
 * Identity join key: lower-cased email. Same caveat documented in
 * `admin/federation/README.md` — two products owned by the same person
 * but registered under different emails appear as two records until
 * a durable shared identity lands.
 *
 * Roster source of truth: this coach's fitness clients (Postgres on the
 * fitness side). For each fitness client we fan out to
 * `FinanceAdminClient.lookupClient(email)` and tag the row with the
 * pillars they actually engage in. Clients who are finance-only with
 * this coach but have no fitness account will not appear here — Stage 3
 * cannot easily reach those without a coach-scoped finance roster query.
 * Documented as Deferred Work in the Stage-3 doc.
 *
 * Failure handling: every finance call returns a `FinanceCallOutcome`
 * union and never throws. Outcomes other than `ok` collapse to a
 * status pill on the row (not_configured / auth_unconfigured / timeout
 * / network_error / http_error / malformed_response / not_found).
 */
@Injectable()
export class CrossPillarService {
  private readonly logger = new Logger(CrossPillarService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly federation: FederationService,
    private readonly financeClient: FinanceAdminClient,
  ) {}

  /**
   * Roster for this coach. Returns one row per fitness client they
   * coach, with a finance block when a finance account exists for the
   * same email. Capped at 50 to bound the parallel finance fan-out.
   */
  async getClients(coachId: string, callerRole: string | null) {
    const fitnessRoster = await this.prisma.user.findMany({
      where: {
        role: 'student',
        archived_at: null,
        ...(callerRole === 'owner' ? {} : { coach_id: coachId }),
      },
      select: {
        id: true,
        email: true,
        name: true,
        created_at: true,
      },
      orderBy: { created_at: 'desc' },
      take: 50,
    });

    // Parallel finance lookups bounded by the page size above. Each
    // call has its own internal retry + timeout (see FinanceAdminClient).
    // We never throw out of this map — the FinanceCallOutcome union is
    // the only thing surfaced to the controller.
    const enriched = await Promise.all(
      fitnessRoster.map(async (u) => {
        const outcome = await this.financeClient.lookupClient(u.email);
        return makeRosterRow(u, outcome);
      }),
    );

    // Aggregate the finance-call outcomes for the response header so the
    // mobile app can render "finance temporarily unavailable" once at the
    // top instead of N error pills inline.
    const financeStatus = aggregateFinanceStatus(enriched);

    return {
      generated_at: new Date().toISOString(),
      identity_mapping: 'email' as const,
      finance: financeStatus,
      results: enriched,
    };
  }

  /**
   * Universal search across both products, scoped to a coach's email.
   * Reuses `FederationService.unifiedSearch` directly — the OWNER
   * surface and the coach surface ask the same question, and the
   * service is a pure read.
   */
  async search(query: string, limit?: number) {
    return this.federation.unifiedSearch(query, limit);
  }

  /**
   * Single-client cross-pillar profile. Reuses
   * `FederationService.unifiedClient` so the OWNER admin console and
   * the coach console see the same shape. The cross-pillar UI renders
   * three tabs (Fitness / Finance / Both) directly on this payload.
   */
  async getClient(email: string) {
    return this.federation.unifiedClient(email);
  }

  /**
   * Combined practice analytics. Local fitness counts come straight from
   * Prisma (this coach's roster + simple aggregates); finance product
   * usage comes from the existing `/usage/product` federation endpoint.
   * Either side may be unavailable; the UI degrades gracefully.
   */
  async getAnalytics(coachId: string, callerRole: string | null) {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const baseFilter = callerRole === 'owner' ? {} : { coach_id: coachId };

    const [clientCount, activeClientCount] = await Promise.all([
      this.prisma.user.count({
        where: {
          role: 'student',
          archived_at: null,
          ...baseFilter,
        },
      }),
      // "Active" = has any food-log activity in the last 7 days.
      // Replicates the existing dashboard's notion of an active client.
      this.prisma.user.count({
        where: {
          role: 'student',
          archived_at: null,
          ...baseFilter,
          logged_entries: { some: { logged_at: { gte: sevenDaysAgo } } },
        },
      }),
    ]);

    const financeOutcome = await this.financeClient.getProductUsage();
    const finance = unwrapFinance<FinanceProductUsage>(financeOutcome);

    return {
      generated_at: new Date().toISOString(),
      identity_mapping: 'email' as const,
      fitness: {
        client_count: clientCount,
        active_client_count_7d: activeClientCount,
      },
      finance,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers — kept module-private so the controller is a pure thin wrapper.
// ---------------------------------------------------------------------------

export interface RosterRow {
  email: string;
  name: string | null;
  fitness: {
    user_id: string;
    joined_at: string;
  };
  finance: {
    status:
      | 'ok'
      | 'not_found'
      | 'not_configured'
      | 'auth_unconfigured'
      | 'timeout'
      | 'network_error'
      | 'http_error'
      | 'malformed_response';
    summary: FinanceClientSummary | null;
  };
  pillars: ('fitness' | 'finance')[];
}

function makeRosterRow(
  fitnessUser: { id: string; email: string; name: string; created_at: Date },
  outcome: FinanceCallOutcome<FinanceClientSummary>,
): RosterRow {
  const fitness = {
    user_id: fitnessUser.id,
    joined_at: fitnessUser.created_at.toISOString(),
  };

  if (outcome.kind === 'ok') {
    return {
      email: fitnessUser.email,
      name: fitnessUser.name,
      fitness,
      finance: { status: 'ok', summary: outcome.data },
      pillars: ['fitness', 'finance'],
    };
  }

  if (outcome.kind === 'not_found') {
    return {
      email: fitnessUser.email,
      name: fitnessUser.name,
      fitness,
      finance: { status: 'not_found', summary: null },
      pillars: ['fitness'],
    };
  }

  // degraded — collapse the union to the named reason on the row.
  return {
    email: fitnessUser.email,
    name: fitnessUser.name,
    fitness,
    finance: { status: outcome.reason, summary: null },
    pillars: ['fitness'],
  };
}

function aggregateFinanceStatus(rows: RosterRow[]): {
  status: 'ok' | 'partial' | 'unavailable';
  ok_count: number;
  not_found_count: number;
  error_count: number;
} {
  let ok = 0;
  let notFound = 0;
  let err = 0;
  for (const r of rows) {
    if (r.finance.status === 'ok') ok++;
    else if (r.finance.status === 'not_found') notFound++;
    else err++;
  }
  let status: 'ok' | 'partial' | 'unavailable';
  if (rows.length === 0) status = 'ok';
  else if (err === rows.length) status = 'unavailable';
  else if (err > 0) status = 'partial';
  else status = 'ok';
  return { status, ok_count: ok, not_found_count: notFound, error_count: err };
}

function unwrapFinance<T>(outcome: FinanceCallOutcome<T>): {
  status: 'ok' | 'unavailable';
  reason?: string;
  data: T | null;
} {
  if (outcome.kind === 'ok') return { status: 'ok', data: outcome.data };
  if (outcome.kind === 'not_found') {
    return { status: 'unavailable', reason: 'not_found', data: null };
  }
  return { status: 'unavailable', reason: outcome.reason, data: null };
}
