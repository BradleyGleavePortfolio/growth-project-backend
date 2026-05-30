import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { CoachAlert, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import {
  NotificationsService,
  PushPayload,
} from '../notifications/notifications.service';
import { NotificationCategory } from '../notifications/notification-category.enum';

// Phase 6B — Proactive Red Flag Alerts.
//
// Surface:
//   * createAlert      — called by PTM recompute (and future signal
//                        observers) to write a fresh alert row, with
//                        24h dedup so a flapping signal does not produce
//                        a notification storm.
//   * listForCoach     — paginated read for the coach inbox.
//   * acknowledge      — idempotent ack for a single alert. The coach
//                        owning the alert is the only caller permitted;
//                        a foreign coach gets NotFoundException.
//
// Push-notification delivery: real push via NotificationsService.pushToCoach.
// NotificationsService is @Optional() so the existing test suite that
// constructs CoachAlertsService(prisma) directly continues to compile and
// pass — when notifications is null, tryPush logs and returns without error.
//
// Emitters wired in this PR:
//   * risk_red_transition  — PTM recompute (src/ptm/ptm-recompute.service.ts)
//   * consecutive_misses   — CheckInsService.maybeFireConsecutiveMissesAlert
//   * streak_dropped       — CheckInsService.maybeFireStreakDroppedAlert
//   * finance_eod_gap      — federation inbound endpoint (Agent 1A dependency;
//                            see GitHub issue #144)
//
// Doctrine:
//   * Coach can only read/ack their own alerts.
//   * createAlert is fire-and-forget at the call site (the PTM
//     recompute hook wraps it in try/catch).
//   * payload is a small JSON blob with engine context; never PII.

export type CoachAlertType =
  | 'risk_red_transition'
  | 'consecutive_misses'
  | 'streak_dropped'
  | 'finance_eod_gap'
  | 'bloodwork_review';

export type CoachAlertSeverity = 'info' | 'warning' | 'critical';

const DEDUP_WINDOW_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_BATCH_LIMIT = 50;
const MAX_BATCH_LIMIT = 200;

export interface CreateAlertInput {
  coachId: string;
  clientId: string;
  alertType: CoachAlertType;
  severity?: CoachAlertSeverity;
  message: string;
  payload?: Record<string, unknown>;
}

export interface ListAlertsOptions {
  coachId: string;
  acknowledged?: boolean;
  limit?: number;
  before?: Date;
}

@Injectable()
export class CoachAlertsService {
  private readonly logger = new Logger(CoachAlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  /**
   * Idempotent within DEDUP_WINDOW_HOURS for the same
   * (coach_id, client_id, alert_type) tuple. Returns the existing row
   * when a recent unacknowledged alert is found, otherwise inserts a
   * fresh row. The caller is expected to swallow exceptions — alert
   * creation must never bubble into a user-facing 5xx.
   *
   * Dedup pattern: identical to the risk_red_transition path. The 24h window
   * is applied uniformly to all alert types to prevent notification storms.
   */
  async createAlert(input: CreateAlertInput): Promise<CoachAlert> {
    const since = new Date(Date.now() - DEDUP_WINDOW_HOURS * HOUR_MS);
    const existing = await this.prisma.coachAlert.findFirst({
      where: {
        coach_id: input.coachId,
        client_id: input.clientId,
        alert_type: input.alertType,
        acknowledged_at: null,
        created_at: { gte: since },
      },
      orderBy: { created_at: 'desc' },
    });
    if (existing) {
      return existing;
    }

    const created = await this.prisma.coachAlert.create({
      data: {
        coach_id: input.coachId,
        client_id: input.clientId,
        alert_type: input.alertType,
        severity: input.severity ?? 'warning',
        message: input.message,
        payload: (input.payload ?? null) as unknown as Prisma.InputJsonValue,
      },
    });
    await this.tryPush(created);
    return created;
  }

  async listForCoach(opts: ListAlertsOptions): Promise<CoachAlert[]> {
    const limit = clamp(opts.limit ?? DEFAULT_BATCH_LIMIT, 1, MAX_BATCH_LIMIT);
    const where: Prisma.CoachAlertWhereInput = {
      coach_id: opts.coachId,
    };
    if (typeof opts.acknowledged === 'boolean') {
      where.acknowledged_at = opts.acknowledged ? { not: null } : null;
    }
    if (opts.before instanceof Date) {
      where.created_at = { lt: opts.before };
    }
    return this.prisma.coachAlert.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: limit,
    });
  }

  /**
   * Idempotent ack. A repeated call against an already-acked alert
   * returns the same row without writing again. Foreign coach calls
   * resolve into NotFoundException so we never leak alert existence.
   *
   * Race-safe: the transition is a single conditional updateMany with
   * `acknowledged_at: null` in the WHERE clause, so two concurrent
   * dismisses cannot both write distinct timestamps. If `count === 0`,
   * either the row doesn't belong to this coach or it was already
   * acknowledged; we re-read to disambiguate.
   */
  async acknowledge(alertId: string, coachId: string): Promise<CoachAlert> {
    return this.acknowledgeWhere(alertId, { coach_id: coachId });
  }

  /**
   * P1b (CC+SC): scoped ack for sub-coaches. CoachAlert rows are owned by
   * the HEAD coach (coach_id = head coach id), so a sub-coach dismissing an
   * alert for one of their assigned clients cannot be authorized by their
   * OWN id (the legacy `acknowledge(alertId, subCoachId)` path matched no
   * rows and 404'd). The caller (CommandCenterService) resolves the
   * SubCoachScope and passes the owner coach_id plus the set of client_ids
   * the sub-coach is assigned to; we authorize on
   * (coach_id = ownerCoachId AND client_id IN allowedClientIds). A head
   * coach passes its own id as ownerCoachId and its full roster as the
   * allowed set, so this is equivalent to the legacy ownership check for
   * head coaches — behaviour unchanged. An alert outside the allowed client
   * set still resolves to NotFoundException (no existence leak, no IDOR).
   */
  async acknowledgeForScope(
    alertId: string,
    ownerCoachId: string,
    allowedClientIds: string[],
  ): Promise<CoachAlert> {
    return this.acknowledgeWhere(alertId, {
      coach_id: ownerCoachId,
      client_id: { in: allowedClientIds },
    });
  }

  // Shared idempotent + race-safe ack core. `ownership` is the WHERE
  // fragment that decides which alerts the caller may touch; callers above
  // build it from either a raw coach_id (head/owner) or an
  // (owner coach_id + client_id IN allowed) scope (sub-coach). Foreign
  // alerts fall through to NotFoundException so we never leak existence.
  private async acknowledgeWhere(
    alertId: string,
    ownership: Prisma.CoachAlertWhereInput,
  ): Promise<CoachAlert> {
    const result = await this.prisma.coachAlert.updateMany({
      where: { ...ownership, id: alertId, acknowledged_at: null },
      data: { acknowledged_at: new Date() },
    });
    if (result.count === 0) {
      const existing = await this.prisma.coachAlert.findFirst({
        where: { ...ownership, id: alertId },
      });
      if (!existing) throw new NotFoundException('Alert not found');
      return existing;
    }
    const updated = await this.prisma.coachAlert.findFirst({
      where: { ...ownership, id: alertId },
    });
    if (!updated) throw new NotFoundException('Alert not found');
    return updated;
  }

  /**
   * OWNER-only aggregator. Optional coach filter and `since` lower bound.
   */
  async listAllForOwner(opts: {
    coachId?: string;
    since?: Date;
    limit?: number;
  } = {}): Promise<CoachAlert[]> {
    const limit = clamp(opts.limit ?? DEFAULT_BATCH_LIMIT, 1, MAX_BATCH_LIMIT);
    const where: Prisma.CoachAlertWhereInput = {};
    if (opts.coachId) where.coach_id = opts.coachId;
    if (opts.since instanceof Date) where.created_at = { gte: opts.since };
    return this.prisma.coachAlert.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: limit,
    });
  }

  // ── push delivery ──────────────────────────────────────────────────────
  // Real push via NotificationsService.pushToCoach. NotificationsService is
  // @Optional() so the service is usable in test contexts that only provide
  // PrismaService. When notifications is absent (test-only), we log and skip.
  // When pushToCoach returns false (no token), the alert is still in the
  // in-app inbox — no exception thrown.
  private async tryPush(alert: CoachAlert): Promise<void> {
    try {
      if (!this.notifications) {
        // Test context — notifications not wired; alert still written to DB.
        return;
      }
      const payload: PushPayload = {
        alertId: alert.id,
        alertType: alert.alert_type,
        severity: alert.severity,
        message: alert.message,
        // Phase 11: coach alerts are COACH_DIRECT category so they surface on
        // the high-importance Android channel and iOS actionable category.
        category: NotificationCategory.COACH_DIRECT,
      };
      const delivered = await this.notifications.pushToCoach(
        alert.coach_id,
        payload,
      );
      if (!delivered) {
        this.logger.log(
          `push skipped (no token) coach=${alert.coach_id} type=${alert.alert_type} sev=${alert.severity}: ${alert.message}`,
        );
      }
    } catch {
      // Push failure must never crash the alert-write path. Alert is still
      // stored in the in-app inbox regardless of delivery outcome.
      this.logger.warn(
        `tryPush threw for alert=${alert.id} coach=${alert.coach_id} — alert still saved in inbox`,
      );
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
