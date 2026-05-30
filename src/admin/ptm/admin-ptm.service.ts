import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  ClientOutcome,
  PtmPrediction,
  PtmOutcomeType as PrismaPtmOutcomeType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { AuditService, AuditAction } from '../../audit/audit.service';
import { PtmService } from '../../ptm/ptm.service';
// The only PtmRecomputeService method we depend on is
// `recomputeOne(userId)`. The recompute orchestrator owns engine choice
// (heuristic_v1 vs weighted_v2) and append-only PtmPrediction writes;
// this file never reaches into either engine directly.
import { PtmRecomputeService } from '../../ptm/ptm-recompute.service';
import {
  bucketize,
  PTM_WINDOWS,
  type PtmOutcomeTypeT,
  type PtmRiskBucket,
  type PtmSignalTypeT,
} from '../../ptm/ptm.types';

// AdminPtmService — Phase 1C teaching surface for the admin console.
//
// Doctrine:
//   * OWNER-only. The controller's class guard (JwtAuthGuard + RolesGuard
//     @Roles('owner')) is the only access path; nothing in this service
//     re-checks the role.
//   * `notes` on ClientOutcome is persisted but NEVER returned to anyone
//     over the API. Every read path here omits `notes` from the Prisma
//     `select` so it is structurally impossible for a JSON response to
//     include the field.
//   * Audit row writes await before the response so the AuditLog row is
//     durable before the controller returns. AuditService.write itself
//     swallows write errors internally (see audit.service.ts:72), so an
//     audit-table outage cannot bubble up as a 500.
//   * Recompute is fire-and-forget after the audit write — the response
//     payload reads `latestPrediction()` after recomputeOne resolves so
//     the caller sees the freshly-written PtmPrediction row.

export interface RiskBoardRow {
  user_id: string;
  email: string;
  role: string;
  name: string;
  risk_score: number;
  success_score: number;
  bucket: PtmRiskBucket;
  computed_at: Date;
  factors_count: number;
}

// Coach-scoped variant: risk_score and success_score are redacted to null
// so the raw model output never leaves the server for non-owner roles.
// The mobile coach screen renders via bucket only — Phase 1E doctrine.
export interface CoachRiskBoardRow {
  user_id: string;
  email: string;
  role: string;
  name: string;
  risk_score: null;
  success_score: null;
  bucket: PtmRiskBucket;
  computed_at: Date;
  factors_count: number;
  last_signal_at: string | null;
  outcome_label: string | null;
}

export interface RiskBoardResponse {
  data: RiskBoardRow[];
  next_cursor: string | null;
  generated_at: string;
}

export interface CoachRiskBoardResponse {
  data: CoachRiskBoardRow[];
  next_cursor: string | null;
  generated_at: string;
}

export interface RecentSignalAggregate {
  signal_type: PtmSignalTypeT;
  count: number;
  last_at: Date;
}

export interface ClientPtmDetailResponse {
  client: { id: string; email: string; role: string; name: string };
  latest_prediction: PtmPrediction | null;
  score_history: PtmPrediction[];
  outcome: PublicClientOutcome | null;
  recent_signals: RecentSignalAggregate[];
}

// Public-facing ClientOutcome — no `notes`. The shape mirrors the Prisma
// row minus the omitted column so call sites get a compile-time guarantee
// that `notes` is not in the response object.
export type PublicClientOutcome = Omit<ClientOutcome, 'notes'>;

export interface OutcomeHistoryRow extends PublicClientOutcome {
  user: { id: string; email: string } | null;
  labelled_by: { id: string; email: string } | null;
}

export interface OutcomeHistoryResponse {
  data: OutcomeHistoryRow[];
  next_cursor: string | null;
}

export interface LabelOutcomeResult {
  outcome: PublicClientOutcome;
  prediction: PtmPrediction | null;
}

export interface LabelOutcomeContext {
  actorId: string;
  actorRole: string | null;
  actorEmail: string | null;
}

const PUBLIC_OUTCOME_SELECT = {
  id: true,
  user_id: true,
  outcome_type: true,
  labelled_by_id: true,
  labelled_at: true,
  signal_snapshot: true,
} as const;

const RISK_BOARD_DEFAULT_PAGE_SIZE = 50;
const RISK_BOARD_MAX_PAGE_SIZE = 100;
const RISK_BOARD_MIN_PAGE_SIZE = 1;

const OUTCOME_HISTORY_DEFAULT_PAGE_SIZE = 50;
const OUTCOME_HISTORY_MAX_PAGE_SIZE = 200;
const OUTCOME_HISTORY_MIN_PAGE_SIZE = 1;

@Injectable()
export class AdminPtmService {
  private readonly logger = new Logger(AdminPtmService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ptm: PtmService,
    private readonly recompute: PtmRecomputeService,
  ) {}

  /**
   * Label an outcome for a student. Snapshots the last-30-days signal
   * counts into ClientOutcome.signal_snapshot, upserts the row by
   * user_id, writes an audit entry, and triggers an immediate
   * recompute. Returns the public outcome (no notes) plus the freshly
   * computed PtmPrediction row.
   */
  async labelOutcome(
    targetUserId: string,
    body: { outcome_type: PtmOutcomeTypeT; notes?: string },
    actor: LabelOutcomeContext,
  ): Promise<LabelOutcomeResult> {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, role: true, email: true },
    });
    if (!target || target.role !== 'student') {
      throw new NotFoundException('Student not found');
    }

    const since = new Date(
      Date.now() - PTM_WINDOWS.RECENT_SIGNAL_WINDOW_DAYS * 24 * 3600 * 1000,
    );

    // Aggregate signal counts in the last 30 days, grouped by signal_type.
    // The shape `{ [signal_type]: count }` is what the weighted engine
    // (1D) will train against, so we freeze it at label time even if
    // older signals are subsequently GDPR-scrubbed.
    const grouped = await this.prisma.clientSignal.groupBy({
      by: ['signal_type'],
      where: { user_id: targetUserId, recorded_at: { gte: since } },
      _count: { _all: true },
    });
    const signalSnapshot: Record<string, number> = {};
    for (const row of grouped) {
      signalSnapshot[row.signal_type] = row._count._all;
    }

    const prior = await this.prisma.clientOutcome.findUnique({
      where: { user_id: targetUserId },
      select: { outcome_type: true },
    });

    const outcomeRow = await this.prisma.clientOutcome.upsert({
      where: { user_id: targetUserId },
      create: {
        user_id: targetUserId,
        outcome_type: body.outcome_type as PrismaPtmOutcomeType,
        labelled_by_id: actor.actorId,
        notes: body.notes ?? null,
        signal_snapshot: signalSnapshot as Prisma.InputJsonValue,
      },
      update: {
        outcome_type: body.outcome_type as PrismaPtmOutcomeType,
        labelled_by_id: actor.actorId,
        labelled_at: new Date(),
        notes: body.notes ?? null,
        signal_snapshot: signalSnapshot as Prisma.InputJsonValue,
      },
      select: PUBLIC_OUTCOME_SELECT,
    });

    await this.audit.write({
      action: AuditAction.PTM_OUTCOME_LABELLED,
      actorId: actor.actorId,
      actorRole: actor.actorRole,
      actorEmail: actor.actorEmail,
      targetUserId: targetUserId,
      targetType: 'user',
      targetId: targetUserId,
      metadata: {
        outcome_type: body.outcome_type,
        prior_outcome_type: prior?.outcome_type ?? null,
        notes_present: !!body.notes,
      },
    });

    // Trigger recompute. Catch and log on failure so a recompute outage
    // does not turn a successful label into a 5xx — the outcome is
    // already persisted and audit-logged.
    try {
      await this.recompute.recomputeOne(targetUserId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `PTM recompute after outcome label failed (user=${targetUserId}): ${msg}`,
      );
    }

    const prediction = await this.ptm.getLatestPrediction(targetUserId);
    return { outcome: outcomeRow, prediction };
  }

  /**
   * Return the per-client teaching view: profile anchor, latest score,
   * up to 30 recent score-history rows, the current outcome label (if
   * any, sans notes), and last-30-days signal aggregates.
   */
  async getClientPtm(clientId: string): Promise<ClientPtmDetailResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { id: true, email: true, role: true, name: true },
    });
    if (!user) throw new NotFoundException('Client not found');

    const [latest, history, outcome, signalAggregates] = await Promise.all([
      this.ptm.getLatestPrediction(clientId),
      this.ptm.listPredictionHistory(clientId, 30),
      this.prisma.clientOutcome.findUnique({
        where: { user_id: clientId },
        select: PUBLIC_OUTCOME_SELECT,
      }),
      this.recentSignalAggregates(clientId),
    ]);

    return {
      client: {
        id: user.id,
        email: user.email,
        role: user.role,
        name: user.name,
      },
      latest_prediction: latest,
      score_history: history,
      outcome,
      recent_signals: signalAggregates,
    };
  }

  /**
   * Risk board — every student's most-recent PtmPrediction sorted by
   * risk_score DESC. Cursor pagination is on `computed_at` so a stable
   * ordering is preserved across pages even when scores drift between
   * recomputes. The factors blob is intentionally NOT returned in the
   * list payload — it is only read on the per-client detail endpoint.
   */
  async getRiskBoard(opts: {
    bucket?: PtmRiskBucket;
    cursor?: string;
    limit?: number;
    actor?: { actorId?: string; actorRole?: string; actorEmail?: string; ip?: string | null; userAgent?: string | null };
  }): Promise<RiskBoardResponse> {
    const limit = clampPageSize(
      opts.limit,
      envPageSize() ?? RISK_BOARD_DEFAULT_PAGE_SIZE,
      RISK_BOARD_MIN_PAGE_SIZE,
      RISK_BOARD_MAX_PAGE_SIZE,
    );

    // Audit: log risk board access. Fire-and-forget. This event is owner-
    // only (the controller gate enforces this); high-frequency access
    // from the same actor is acceptable — a single indexed insert is
    // cheap and the operator surface is not expected to be polled.
    if (opts.actor?.actorId) {
      void this.audit.write({
        action: AuditAction.PTM_RISK_BOARD_VIEW,
        actorId: opts.actor.actorId,
        actorRole: opts.actor.actorRole ?? 'owner',
        actorEmail: opts.actor.actorEmail ?? null,
        ip: opts.actor.ip ?? null,
        userAgent: opts.actor.userAgent ?? null,
        metadata: { bucket: opts.bucket ?? null, cursor: opts.cursor ?? null },
      });
    }

    // Step 1: per-user latest computed_at via groupBy. Bounded by cursor
    // (rows with max(computed_at) < cursor) so the seek scans only the
    // tail of the (user_id, computed_at) composite index.
    const cursorDate = parseIsoCursor(opts.cursor);

    const groups = await this.prisma.ptmPrediction.groupBy({
      by: ['user_id'],
      _max: { computed_at: true },
      ...(cursorDate
        ? { where: { computed_at: { lt: cursorDate } } }
        : {}),
    });

    if (groups.length === 0) {
      return { data: [], next_cursor: null, generated_at: new Date().toISOString() };
    }

    // Step 2: fetch the actual prediction row for each (user_id, max(computed_at)).
    const orPairs = groups
      .filter((g) => g._max.computed_at != null)
      .map((g) => ({
        user_id: g.user_id,
        computed_at: g._max.computed_at as Date,
      }));

    const predictions = await this.prisma.ptmPrediction.findMany({
      where: {
        OR: orPairs.map((p) => ({
          user_id: p.user_id,
          computed_at: p.computed_at,
        })),
      },
      include: {
        user: { select: { id: true, email: true, role: true, name: true } },
      },
    });

    // Step 3: bucket filter, sort by risk_score desc, then by computed_at
    // desc as a tiebreaker so the cursor remains monotonic.
    const filtered = predictions
      .filter((p) =>
        opts.bucket ? bucketize(p.risk_score) === opts.bucket : true,
      )
      .sort((a, b) => {
        if (b.risk_score !== a.risk_score) return b.risk_score - a.risk_score;
        return b.computed_at.getTime() - a.computed_at.getTime();
      });

    const page = filtered.slice(0, limit);
    const next =
      filtered.length > limit
        ? page[page.length - 1]?.computed_at.toISOString() ?? null
        : null;

    const data: RiskBoardRow[] = page.map((p) => ({
      user_id: p.user_id,
      email: p.user.email,
      role: p.user.role,
      name: p.user.name,
      risk_score: p.risk_score,
      success_score: p.success_score,
      bucket: bucketize(p.risk_score),
      computed_at: p.computed_at,
      factors_count: countFactors(p.factors),
    }));

    return { data, next_cursor: next, generated_at: new Date().toISOString() };
  }

  /**
   * Coach-scoped risk board (Phase 1E).
   *
   * Mirrors getRiskBoard but adds a WHERE constraint so only clients
   * whose User.coach_id = coachId are visible. raw risk_score and
   * success_score are redacted to null — a coach is authorised to act
   * on the bucket but must not see the raw model internals. The mobile
   * screen renders via RiskDot and bucket label regardless of whether
   * the source is the owner or coach path.
   *
   * Privacy: the coachId scope is the ONLY access control on this
   * path. No coach can widen the filter to another coach's roster —
   * the controller passes req.user.id and the caller never influences
   * the coachId value.
   */
  async getRiskBoardForCoach(
    coachId: string,
    opts: {
      bucket?: PtmRiskBucket;
      cursor?: string;
      limit?: number;
      // P1a (CC+SC): when the caller has already resolved the authorized
      // client-id set (e.g. CommandCenterService routes head AND sub-coach
      // scope through SubCoachScopeService), it passes that set here so the
      // board is built against the RESOLVED clients rather than re-deriving
      // the roster from `User.coach_id = coachId`. A sub-coach does NOT own
      // students via coach_id (their students belong to the head coach), so
      // the legacy roster query returns nothing for them and the at-risk
      // list came back EMPTY. When omitted, behaviour is identical to before
      // (head-coach roster query) so existing callers are unchanged.
      clientIds?: string[];
    },
  ): Promise<CoachRiskBoardResponse> {
    const limit = clampPageSize(
      opts.limit,
      envPageSize() ?? RISK_BOARD_DEFAULT_PAGE_SIZE,
      RISK_BOARD_MIN_PAGE_SIZE,
      RISK_BOARD_MAX_PAGE_SIZE,
    );

    const cursorDate = parseIsoCursor(opts.cursor);

    // Resolve the set of client user_ids to score. If the caller supplied an
    // explicit authorized set (P1a), use it verbatim; otherwise derive the
    // head-coach roster from `User.coach_id = coachId`. This two-step avoids
    // a cross-table groupBy that Prisma does not support natively and keeps
    // the index path on (user_id, computed_at) hot.
    let rosterIds: string[];
    if (opts.clientIds !== undefined) {
      rosterIds = opts.clientIds;
    } else {
      const rosterRows = await this.prisma.user.findMany({
        where: {
          coach_id: coachId,
          role: 'student',
          deleted_at: null,
        },
        select: { id: true },
      });
      rosterIds = rosterRows.map((u) => u.id);
    }

    if (rosterIds.length === 0) {
      return { data: [], next_cursor: null, generated_at: new Date().toISOString() };
    }

    // Per-user latest computed_at, scoped to this coach's roster.
    const groups = await this.prisma.ptmPrediction.groupBy({
      by: ['user_id'],
      _max: { computed_at: true },
      where: {
        user_id: { in: rosterIds },
        ...(cursorDate ? { computed_at: { lt: cursorDate } } : {}),
      },
    });

    if (groups.length === 0) {
      return { data: [], next_cursor: null, generated_at: new Date().toISOString() };
    }

    const orPairs = groups
      .filter((g) => g._max.computed_at != null)
      .map((g) => ({
        user_id: g.user_id,
        computed_at: g._max.computed_at as Date,
      }));

    const predictions = await this.prisma.ptmPrediction.findMany({
      where: {
        OR: orPairs.map((p) => ({
          user_id: p.user_id,
          computed_at: p.computed_at,
        })),
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            role: true,
            name: true,
            ptm_outcomes_target: {
              select: { outcome_type: true },
              take: 1,
            },
            ptm_signals: {
              select: { recorded_at: true },
              orderBy: { recorded_at: 'desc' },
              take: 1,
            },
          },
        },
      },
    });

    // Bucket filter + sort by risk_score DESC, computed_at DESC tiebreak.
    const filtered = predictions
      .filter((p) =>
        opts.bucket ? bucketize(p.risk_score) === opts.bucket : true,
      )
      .sort((a, b) => {
        if (b.risk_score !== a.risk_score) return b.risk_score - a.risk_score;
        return b.computed_at.getTime() - a.computed_at.getTime();
      });

    const page = filtered.slice(0, limit);
    const next =
      filtered.length > limit
        ? page[page.length - 1]?.computed_at.toISOString() ?? null
        : null;

    // risk_score and success_score are intentionally null for this path.
    // The mobile coach screen renders the bucket label / RiskDot and
    // must never see the raw model percentage (Phase 1E doctrine).
    const data: CoachRiskBoardRow[] = page.map((p) => ({
      user_id: p.user_id,
      email: p.user.email,
      role: p.user.role,
      name: p.user.name,
      risk_score: null,
      success_score: null,
      bucket: bucketize(p.risk_score),
      computed_at: p.computed_at,
      factors_count: countFactors(p.factors),
      last_signal_at:
        p.user.ptm_signals[0]?.recorded_at.toISOString() ?? null,
      outcome_label:
        p.user.ptm_outcomes_target[0]?.outcome_type ?? null,
    }));

    return { data, next_cursor: next, generated_at: new Date().toISOString() };
  }

  /**
   * Outcome history — every labelled ClientOutcome row, newest-first.
   * Acts as the human-readable training set for the weighted engine.
   * Notes are NEVER returned. Cursor on labelled_at < before.
   */
  async getOutcomeHistory(opts: {
    outcome_type?: PtmOutcomeTypeT;
    before?: string;
    limit?: number;
  }): Promise<OutcomeHistoryResponse> {
    const limit = clampPageSize(
      opts.limit,
      OUTCOME_HISTORY_DEFAULT_PAGE_SIZE,
      OUTCOME_HISTORY_MIN_PAGE_SIZE,
      OUTCOME_HISTORY_MAX_PAGE_SIZE,
    );
    const cursorDate = parseIsoCursor(opts.before);
    const where: Prisma.ClientOutcomeWhereInput = {};
    if (opts.outcome_type) {
      where.outcome_type = opts.outcome_type as PrismaPtmOutcomeType;
    }
    if (cursorDate) where.labelled_at = { lt: cursorDate };

    const rows = await this.prisma.clientOutcome.findMany({
      where,
      orderBy: { labelled_at: 'desc' },
      take: limit + 1,
      select: {
        ...PUBLIC_OUTCOME_SELECT,
        user: { select: { id: true, email: true } },
        labelled_by: { select: { id: true, email: true } },
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const next = hasMore && last ? last.labelled_at.toISOString() : null;

    const data: OutcomeHistoryRow[] = page.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      outcome_type: r.outcome_type,
      labelled_by_id: r.labelled_by_id,
      labelled_at: r.labelled_at,
      signal_snapshot: r.signal_snapshot,
      user: r.user
        ? { id: r.user.id, email: r.user.email }
        : null,
      labelled_by: r.labelled_by
        ? { id: r.labelled_by.id, email: r.labelled_by.email }
        : null,
    }));

    return { data, next_cursor: next };
  }

  private async recentSignalAggregates(
    userId: string,
  ): Promise<RecentSignalAggregate[]> {
    const since = new Date(
      Date.now() - PTM_WINDOWS.RECENT_SIGNAL_WINDOW_DAYS * 24 * 3600 * 1000,
    );
    const grouped = await this.prisma.clientSignal.groupBy({
      by: ['signal_type'],
      where: { user_id: userId, recorded_at: { gte: since } },
      _count: { _all: true },
      _max: { recorded_at: true },
    });
    return grouped
      .filter((g) => g._max.recorded_at != null)
      .map((g) => ({
        signal_type: g.signal_type as PtmSignalTypeT,
        count: g._count._all,
        last_at: g._max.recorded_at as Date,
      }));
  }
}

function envPageSize(): number | undefined {
  const raw = process.env.PTM_RISK_BOARD_PAGE_SIZE;
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function clampPageSize(
  raw: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = raw && Number.isFinite(raw) && raw > 0 ? raw : fallback;
  return Math.min(Math.max(n, min), max);
}

function parseIsoCursor(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

function countFactors(factors: Prisma.JsonValue | null): number {
  if (!factors) return 0;
  if (Array.isArray(factors)) return factors.length;
  return 0;
}
