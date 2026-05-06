import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { PtmService } from '../ptm/ptm.service';
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

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class CheckInsService {
  constructor(
    private prisma: PrismaService,
    private ptm: PtmService,
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
    return new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    );
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

    const row = await this.prisma.checkIn.upsert({
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
    });

    await this.emitPtmAfterUpsert(clientId, day);

    return row;
  }

  // PTM signal emission. Fire-and-forget: read the recent check-in dates,
  // compute consecutive-day streak ending on `day`, and emit checkin_streak.
  // If the gap from the most recent prior check-in to today exceeds the miss
  // threshold, emit checkin_miss with the gap length. Failures here MUST NOT
  // bubble — the upsert has already succeeded.
  private async emitPtmAfterUpsert(clientId: string, day: Date): Promise<void> {
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
        const gap = Math.floor(
          (today.getTime() - this.midnightUtc(latest).getTime()) / ONE_DAY_MS,
        );
        if (gap >= PTM_MISS_MIN_DAYS) {
          this.ptm.emit(clientId, 'checkin_miss', gap);
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

  private midnightUtc(d: Date): Date {
    return new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    );
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
  async listForClientByCoach(
    coachId: string,
    clientId: string,
    query: ListCheckInsQueryDto,
  ) {
    await this.assertClientOfCoach(coachId, clientId);
    const limit = this.clampLimit(query.limit);

    let from = query.from ? this.parseDay(query.from) : undefined;
    const to = query.to ? this.parseDay(query.to) : undefined;
    if (!from) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - COACH_DEFAULT_WINDOW_DAYS);
      from = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
      );
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
}
