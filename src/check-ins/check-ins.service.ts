import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { PtmService } from '../ptm/ptm.service';
import { CoachAlertsService } from '../coach/coach-alerts.service';
import { ClientAIContextService } from '../ai/client-ai-context.service';
import { isCoachReviewedAtEnabled } from '../roman/coach-reviewed.feature';
import type { CreateCheckInDto, ListCheckInsQueryDto } from './check-ins.dto';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 365;
// Spec §B.2: coach-side check-in listing defaults to the last 30 days when no
// `from` is supplied. Value mirrors the 30-day window used by getClientSummary.
const COACH_DEFAULT_WINDOW_DAYS = 30;

// PTM streak window — how many recent check-in rows we read after the upsert
// to compute the consecutive-day streak. 60 covers ~2 months of perfect
// adherence and is plenty for the heuristic engine.
const PTM_STREAK_LOOKBACK = 60;
// PTM miss threshold — emit checkin_miss only when the latest check-in is at
// least this many calendar days behind today. Below the threshold the gap is
// noise.
const PTM_MISS_MIN_DAYS = 3;

// Phase 6B emitter thresholds
// consecutive_misses: fire when the client has missed 3+ consecutive check-ins
// (i.e. the gap between the most recent check-in and today is ≥ 3 days).
// Per the brief: "3+ consecutive missed check-ins."
const CONSECUTIVE_MISSES_THRESHOLD = 3;
// streak_dropped: fire when the previous streak was 7+ and the current computed
// streak has fallen to 0 (client broke a week-long streak). We approximate the
// prior streak by looking at the history starting from index 1 (skipping the
// just-upserted entry).
const STREAK_DROP_PRIOR_MIN = 7;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class CheckInsService {
  constructor(
    private prisma: PrismaService,
    private ptm: PtmService,
    @Optional() private readonly coachAlerts?: CoachAlertsService,
    // M2 — bust the AI context cache after check-in writes.
    @Optional() private readonly aiContext?: ClientAIContextService,
    // H6 (D-H6-3): structured same-transaction audit substrate. @Optional
    // so legacy direct-construction specs keep compiling; AuditLogModule is
    // @Global so production DI always populates it.
    @Optional() private readonly auditLog?: AuditLogService,
  ) {}

  // ---- helpers ----

  private clampLimit(limit?: number): number {
    if (!limit || limit <= 0) return DEFAULT_LIMIT;
    return Math.min(limit, MAX_LIMIT);
  }

  // Parse an ISO-8601 date and collapse to midnight UTC so the unique
  // (user_id, date) constraint treats "2026-04-24" and "2026-04-24T13:00:00Z"
  // as the same calendar day. Returns undefined for unparseable input —
  // DTO-level @IsISO8601() is the first defense; this is just a safety net.
  private parseDay(value: string): Date | undefined {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return undefined;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  private async assertClientOfCoach(coachId: string, clientId: string) {
    const client = await this.prisma.user.findFirst({
      where: { id: clientId, coach_id: coachId, role: 'student' },
      select: { id: true },
    });
    if (!client) throw new NotFoundException('Client not found');
    return client;
  }

  // ---- client writes ----

  // Upsert one check-in per (client, date). `coach_id` is denormalized from
  // the client's *current* coach at creation time so the coach's timeline
  // still shows the check-in even if the client later switches coaches
  // (spec §B.1). On update we deliberately do NOT rewrite coach_id — it
  // stays pinned to the coach-of-record when the check-in was first created.
  async upsertForClient(clientId: string, dto: CreateCheckInDto) {
    const day = this.parseDay(dto.date);
    if (!day) {
      // Should not happen given @IsISO8601() in the DTO, but keeps the
      // service defensible when called programmatically from tests.
      throw new NotFoundException('Invalid date');
    }

    const me = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { coach_id: true },
    });
    const coachId = me?.coach_id ?? null;

    const updateData: {
      mood?: number | null;
      energy?: number | null;
      sleep_hours?: number | null;
      weight_kg?: number | null;
      notes?: string | null;
    } = {};
    if (dto.mood !== undefined) updateData.mood = dto.mood;
    if (dto.energy !== undefined) updateData.energy = dto.energy;
    if (dto.sleep_hours !== undefined) updateData.sleep_hours = dto.sleep_hours;
    if (dto.weight_kg !== undefined) updateData.weight_kg = dto.weight_kg;
    if (dto.notes !== undefined) updateData.notes = dto.notes;

    // H6 (D-H6-3): a check-in carries client wellness PII (mood, weight,
    // notes), so the upsert records an audit row in the same transaction.
    // The afterState captures which fields changed, never the raw notes.
    const upsertArgs = {
      where: {
        CheckIn_user_id_date_key: { user_id: clientId, date: day },
      },
      create: {
        user_id: clientId,
        coach_id: coachId,
        date: day,
        mood: dto.mood ?? null,
        energy: dto.energy ?? null,
        sleep_hours: dto.sleep_hours ?? null,
        weight_kg: dto.weight_kg ?? null,
        notes: dto.notes ?? null,
        // `soreness` is pre-existing and NOT NULL; default 0 keeps the
        // legacy column populated without forcing callers to supply it.
        soreness: 0,
      },
      update: updateData,
    } as const;
    const auditCtx = {
      tenantId: coachId ?? clientId,
      actorId: clientId,
      actorType: 'user' as const,
      action: 'update' as const,
      resourceType: 'CheckIn',
      resourceId: clientId,
      afterState: { fields_changed: Object.keys(updateData) },
    };
    const row = this.auditLog
      ? await this.auditLog.withAuditLog(auditCtx, (tx) => tx.checkIn.upsert(upsertArgs))
      : await this.prisma.checkIn.upsert(upsertArgs);

    await this.emitPtmAfterUpsert(clientId, coachId, day);
    // M2 — bust AI context cache so next chat sees the new check-in.
    this.aiContext?.invalidateForUser(clientId);

    return row;
  }

  // PTM signal emission. Fire-and-forget: read the recent check-in dates,
  // compute consecutive-day streak ending on `day`, and emit checkin_streak.
  // If the gap from the most recent prior check-in to today exceeds the miss
  // threshold, emit checkin_miss with the gap length.
  //
  // Phase 6B alert emitters (only when coachAlerts is injected and coachId
  // is non-null):
  //   * consecutive_misses — fired when gap ≥ CONSECUTIVE_MISSES_THRESHOLD
  //   * streak_dropped     — fired when priorStreak ≥ 7 and newStreak = 0
  //
  // Failures here MUST NOT bubble — the upsert has already succeeded.
  private async emitPtmAfterUpsert(
    clientId: string,
    coachId: string | null,
    day: Date,
  ): Promise<void> {
    try {
      const recent = await this.prisma.checkIn.findMany({
        where: { user_id: clientId },
        orderBy: { date: 'desc' },
        take: PTM_STREAK_LOOKBACK,
        select: { date: true },
      });
      const streak = this.computeStreak(recent.map((r) => r.date));
      this.ptm.emit(clientId, 'checkin_streak', streak);

      const today = this.midnightUtc(new Date());
      const latest = recent[0]?.date;
      if (latest) {
        const gap = Math.floor((today.getTime() - this.midnightUtc(latest).getTime()) / ONE_DAY_MS);
        if (gap >= PTM_MISS_MIN_DAYS) {
          this.ptm.emit(clientId, 'checkin_miss', gap);

          // Phase 6B — consecutive_misses alert emitter.
          if (this.coachAlerts && coachId && gap >= CONSECUTIVE_MISSES_THRESHOLD) {
            void this.maybeFireConsecutiveMissesAlert(clientId, coachId, gap);
          }
        }
      }

      // Phase 6B — streak_dropped alert emitter.
      if (this.coachAlerts && coachId) {
        const priorStreak = this.computeStreak(recent.slice(1).map((r) => r.date));
        if (priorStreak >= STREAK_DROP_PRIOR_MIN && streak === 0) {
          void this.maybeFireStreakDroppedAlert(clientId, coachId, priorStreak);
        }
      }
    } catch {
      // Swallow — PtmService.emit is already fire-and-forget. This catch
      // protects against the prior findMany failing.
    }
    // Acknowledge `day` is consumed by callers' tests via the upsert path; it
    // is not used directly here because the streak is anchored to today.
    void day;
  }

  /**
   * Phase 6B — emit consecutive_misses alert.
   * Dedup (24h per coach+client+type) lives in CoachAlertsService.createAlert.
   * This method is fire-and-forget — any thrown exception is swallowed.
   */
  private async maybeFireConsecutiveMissesAlert(
    clientId: string,
    coachId: string,
    missCount: number,
  ): Promise<void> {
    try {
      await this.coachAlerts!.createAlert({
        coachId,
        clientId,
        alertType: 'consecutive_misses',
        severity: 'warning',
        message: `Client has missed ${missCount} consecutive check-ins`,
        payload: { consecutive_miss_days: missCount },
      });
    } catch {
      // Alert failures must never surface to the caller.
    }
  }

  /**
   * Phase 6B — emit streak_dropped alert.
   * Fires when a client's streak fell from ≥ 7 to 0.
   * Dedup (24h per coach+client+type) lives in CoachAlertsService.createAlert.
   * This method is fire-and-forget — any thrown exception is swallowed.
   */
  private async maybeFireStreakDroppedAlert(
    clientId: string,
    coachId: string,
    priorStreak: number,
  ): Promise<void> {
    try {
      await this.coachAlerts!.createAlert({
        coachId,
        clientId,
        alertType: 'streak_dropped',
        severity: 'info',
        message: `Client's check-in streak dropped from ${priorStreak} days to 0`,
        payload: { prior_streak: priorStreak, new_streak: 0 },
      });
    } catch {
      // Alert failures must never surface to the caller.
    }
  }

  private midnightUtc(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  // Count consecutive calendar days starting from the most recent date and
  // walking backwards. `dates` must already be sorted desc.
  private computeStreak(dates: Date[]): number {
    if (dates.length === 0) return 0;
    let streak = 1;
    let prev = this.midnightUtc(dates[0]);
    for (let i = 1; i < dates.length; i++) {
      const cur = this.midnightUtc(dates[i]);
      const gap = Math.round((prev.getTime() - cur.getTime()) / ONE_DAY_MS);
      if (gap === 1) {
        streak++;
        prev = cur;
      } else {
        break;
      }
    }
    return streak;
  }

  // Client reads their own check-ins. `from`/`to` are inclusive-exclusive
  // ISO-8601 bounds on the date column; defaults return every check-in the
  // client has (bounded by `limit`).
  async listForClient(clientId: string, query: ListCheckInsQueryDto) {
    const limit = this.clampLimit(query.limit);
    const from = query.from ? this.parseDay(query.from) : undefined;
    const to = query.to ? this.parseDay(query.to) : undefined;

    return this.prisma.checkIn.findMany({
      where: {
        user_id: clientId,
        ...(from || to
          ? {
              date: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      orderBy: { date: 'desc' },
      take: limit,
    });
  }

  // Single check-in by id. 404 if not theirs — foreign-ownership returns the
  // same 404 as missing so callers can't probe.
  async getOneForClient(clientId: string, id: string) {
    const row = await this.prisma.checkIn.findFirst({
      where: { id, user_id: clientId },
    });
    if (!row) throw new NotFoundException('Check-in not found');
    return row;
  }

  // ---- coach reads ----

  // Coach reads a specific client's check-ins. Default window is the last
  // 30 days when `from` is omitted (spec §B.2). We use the client's *current*
  // coach relationship to authorize — see spec §B.1: historical check-ins
  // are attached to the coach-of-record via coach_id, but the auth check
  // here is about current ownership of the client record.
  async listForClientByCoach(coachId: string, clientId: string, query: ListCheckInsQueryDto) {
    await this.assertClientOfCoach(coachId, clientId);
    const limit = this.clampLimit(query.limit);

    let from = query.from ? this.parseDay(query.from) : undefined;
    const to = query.to ? this.parseDay(query.to) : undefined;
    if (!from) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - COACH_DEFAULT_WINDOW_DAYS);
      from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    }

    return this.prisma.checkIn.findMany({
      where: {
        user_id: clientId,
        date: {
          gte: from,
          ...(to ? { lte: to } : {}),
        },
      },
      orderBy: { date: 'desc' },
      take: limit,
    });
  }

  // ---- coach review (ED.6) ----

  // ED.6 — mark a single check-in as reviewed by the coach. Re-stamps
  // `coach_reviewed_at` to now() (most-recent semantics, brief §Write paths)
  // and flips the long-standing `reviewed_by_coach` acknowledgement flag in the
  // same write so the existing coach-dashboard "needs review" counters and the
  // new client-facing CompetencePill stay consistent.
  //
  // GATED on FEATURE_ROMAN_COACH_REVIEWED_AT: while the flag is OFF the
  // `coach_reviewed_at` column is left untouched (stays NULL) so the pill never
  // renders — the feature is invisible until the operator flips the flag. The
  // `reviewed_by_coach` acknowledgement flag is INDEPENDENT of ED.6 (it predates
  // this lane and drives the dashboard), so it is always written regardless of
  // the flag — turning ED.6 off must not regress the existing review workflow.
  //
  // Scopes the update by the OWNER (coach_id) so a coach can only review a
  // check-in that is attached to them; a foreign / missing id returns the same
  // 404 as a non-existent row (no probing). Idempotent under concurrent
  // reviews: each call simply re-stamps now() — there is no read-modify-write
  // race because the new value does not depend on the old one.
  async markReviewedByCoach(coachId: string, checkInId: string) {
    await this.assertCheckInOfCoach(coachId, checkInId);
    const flagOn = isCoachReviewedAtEnabled();
    // H6 (D-H6-3): coach reviewing a client check-in is an access/mutation
    // event over client PII, so wrap it in withAuditLog().
    const updateArgs = {
      where: { id: checkInId },
      data: {
        reviewed_by_coach: true,
        ...(flagOn ? { coach_reviewed_at: new Date() } : {}),
      },
    } as const;
    const updated = this.auditLog
      ? await this.auditLog.withAuditLog(
          {
            tenantId: coachId,
            actorId: coachId,
            actorType: 'coach',
            action: 'update',
            resourceType: 'CheckIn',
            resourceId: checkInId,
            afterState: { reviewed_by_coach: true },
          },
          (tx) => tx.checkIn.update(updateArgs),
        )
      : await this.prisma.checkIn.update(updateArgs);
    return updated;
  }

  // Authorize a coach for a specific check-in by its denormalized coach_id.
  // 404 on missing / foreign so the existence of another coach's check-in does
  // not leak.
  private async assertCheckInOfCoach(coachId: string, checkInId: string) {
    const row = await this.prisma.checkIn.findFirst({
      where: { id: checkInId, coach_id: coachId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Check-in not found');
    return row;
  }
}
