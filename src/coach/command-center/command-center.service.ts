// src/coach/command-center/command-center.service.ts
//
// CommandCenterService — backs the 5 P0 endpoints under
// /coach/command-center/* (overview, at-risk, win-streaks, inbox,
// action-queue, dismiss). All reads are scoped to the calling coach's
// roster (req.user.id); a coach never sees data outside their own
// students. Owners pass through CoachGuard and reuse the same code path
// (their req.user.id treated as a coach_id).
//
// Performance:
//   * No N+1 queries — roster IDs are resolved once and reused.
//   * Aggregations run in parallel via Promise.all.
//   * Pagination + limits clamped server-side so a single coach cannot
//     drag the DB to its knees by passing limit=999999.
//
// Privacy:
//   * Raw PTM risk_score and success_score are NEVER returned (Phase 1E
//     doctrine — owner-only). The at-risk endpoint sets risk_score=null
//     for all callers (the AdminPtmService.getRiskBoardForCoach path
//     already does this; we preserve it).

import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { AdminPtmService } from '../../admin/ptm/admin-ptm.service';
import { CoachAlertsService } from '../coach-alerts.service';
import type { CoachRiskBoardRow } from '../../admin/ptm/admin-ptm.service';
import type { PtmRiskBucket } from '../../ptm/ptm.types';

// ── Response types (mirrors mobile commandCenterApi.ts) ─────────────────

export interface CommandCenterOverview {
  roster_size: number;
  active_today: number;
  check_in_rate_7day: number;
  open_alerts: number;
  at_risk_count: number;
  win_streak_count: number;
  unread_messages: number;
  pending_actions: number;
}

export interface AtRiskEntry {
  user_id: string;
  display_name: string;
  bucket: 'red' | 'amber' | 'green';
  risk_score: null;
  last_active_at: string | null;
  top_factor: string;
  days_since_checkin: number;
}

export interface AtRiskResponse {
  items: AtRiskEntry[];
  total_at_risk: number;
}

export interface WinStreakEntry {
  user_id: string;
  display_name: string;
  streak_days: number;
  streak_type: 'check_in' | 'workout' | 'weight_log';
  streak_started_at: string;
}

export interface WinStreaksResponse {
  items: WinStreakEntry[];
  total_active_streaks: number;
}

export interface InboxThread {
  thread_id: string;
  client_id: string;
  client_name: string;
  last_message_preview: string;
  last_message_at: string;
  unread_count: number;
  is_coach_turn: boolean;
}

export interface InboxResponse {
  threads: InboxThread[];
  total_unread: number;
}

export type ActionQueueAlertType =
  | 'missed_checkins'
  | 'weight_not_logged'
  | 'no_message_exchange'
  | 'high_churn_risk'
  | 'build_week_gate'
  | 'bloodwork_review';

export interface ActionQueueItem {
  alert_id: string;
  client_id: string;
  client_name: string;
  alert_type: ActionQueueAlertType;
  message: string;
  created_at: string;
  dismissed_at: string | null;
}

export interface ActionQueueResponse {
  items: ActionQueueItem[];
  total_pending: number;
}

const ONE_DAY_MS = 86_400_000;

function clamp(n: number | undefined, fallback: number, max: number): number {
  if (n == null || !Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function mapAlertType(backendType: string): ActionQueueAlertType {
  switch (backendType) {
    case 'risk_red_transition':
      return 'high_churn_risk';
    case 'consecutive_misses':
      return 'missed_checkins';
    case 'streak_dropped':
      return 'missed_checkins';
    case 'finance_eod_gap':
      return 'weight_not_logged';
    default:
      return 'high_churn_risk';
  }
}

function buildThreadId(id1: string, id2: string): string {
  return [id1, id2].sort().join(':');
}

@Injectable()
export class CommandCenterService {
  private readonly logger = new Logger(CommandCenterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminPtm: AdminPtmService,
    private readonly alertsService: CoachAlertsService,
  ) {}

  // ── /overview ────────────────────────────────────────────────────────
  async getOverview(coachId: string): Promise<CommandCenterOverview> {
    const now = Date.now();
    const sevenDaysAgo = new Date(now - 7 * ONE_DAY_MS);
    const oneDayAgo = new Date(now - ONE_DAY_MS);

    const rosterRows = await this.prisma.user.findMany({
      where: { coach_id: coachId, role: 'student', deleted_at: null },
      select: { id: true },
    });
    const clientIds = rosterRows.map((r) => r.id);
    const rosterSize = clientIds.length;

    if (rosterSize === 0) {
      return {
        roster_size: 0,
        active_today: 0,
        check_in_rate_7day: 0,
        open_alerts: 0,
        at_risk_count: 0,
        win_streak_count: 0,
        unread_messages: 0,
        pending_actions: 0,
      };
    }

    const [
      activeTodayGroups,
      checkInsLast7dGroups,
      openAlerts,
      latestPredictionGroups,
      winStreakGroups,
      unreadMessages,
    ] = await Promise.all([
      this.prisma.clientSignal.groupBy({
        by: ['user_id'],
        where: { user_id: { in: clientIds }, recorded_at: { gte: oneDayAgo } },
        _count: { _all: true },
      }),
      this.prisma.checkIn.groupBy({
        by: ['user_id'],
        where: {
          user_id: { in: clientIds },
          logged_at: { gte: sevenDaysAgo },
        },
        _count: { _all: true },
      }),
      this.prisma.coachAlert.count({
        where: { coach_id: coachId, acknowledged_at: null },
      }),
      this.prisma.ptmPrediction.groupBy({
        by: ['user_id'],
        where: { user_id: { in: clientIds } },
        _max: { computed_at: true },
      }),
      this.prisma.clientSignal.groupBy({
        by: ['user_id'],
        where: {
          user_id: { in: clientIds },
          signal_type: 'checkin_streak',
          value: { gte: 3 },
          recorded_at: { gte: sevenDaysAgo },
        },
        _max: { value: true },
      }),
      this.prisma.message.count({
        where: { recipient_id: coachId, read: false },
      }),
    ]);

    // At-risk count: fetch latest prediction per user, count those with risk > 0.3
    let atRiskCount = 0;
    const orPairs = latestPredictionGroups
      .filter((g) => g._max.computed_at != null)
      .map((g) => ({
        user_id: g.user_id,
        computed_at: g._max.computed_at as Date,
      }));
    if (orPairs.length > 0) {
      const latestPredictions = await this.prisma.ptmPrediction.findMany({
        where: { OR: orPairs },
        select: { risk_score: true },
      });
      atRiskCount = latestPredictions.filter((p) => p.risk_score > 0.3).length;
    }

    const checkInRate =
      rosterSize > 0
        ? Math.min(checkInsLast7dGroups.length / rosterSize, 1)
        : 0;

    return {
      roster_size: rosterSize,
      active_today: activeTodayGroups.length,
      check_in_rate_7day: Math.round(checkInRate * 100) / 100,
      open_alerts: openAlerts,
      at_risk_count: atRiskCount,
      win_streak_count: winStreakGroups.length,
      unread_messages: unreadMessages,
      pending_actions: openAlerts,
    };
  }

  // ── /at-risk ─────────────────────────────────────────────────────────
  async getAtRisk(
    coachId: string,
    opts: { bucket?: 'red' | 'amber'; limit?: number },
  ): Promise<AtRiskResponse> {
    const limit = clamp(opts.limit, 50, 100);
    const board = await this.adminPtm.getRiskBoardForCoach(coachId, {
      bucket: opts.bucket as PtmRiskBucket | undefined,
      limit,
    });

    const filtered = opts.bucket
      ? board.data
      : board.data.filter(
          (row) => row.bucket === 'red' || row.bucket === 'amber',
        );

    const now = Date.now();
    const items: AtRiskEntry[] = filtered.map((row) => {
      const lastSignalMs = row.last_signal_at
        ? new Date(row.last_signal_at).getTime()
        : null;
      // New clients (no signal yet) get 0, not 999, so the UI doesn't
      // present them as catastrophically inactive.
      const daysSinceSignal =
        lastSignalMs != null
          ? Math.max(0, Math.floor((now - lastSignalMs) / ONE_DAY_MS))
          : 0;

      return {
        user_id: row.user_id,
        display_name: row.name,
        bucket: row.bucket as 'red' | 'amber' | 'green',
        risk_score: null,
        last_active_at: row.last_signal_at,
        top_factor: this.topFactorLabel(row),
        days_since_checkin: daysSinceSignal,
      };
    });

    return { items, total_at_risk: items.length };
  }

  private topFactorLabel(row: CoachRiskBoardRow): string {
    if (!row.last_signal_at) return 'No recent activity';
    const days = Math.floor(
      (Date.now() - new Date(row.last_signal_at).getTime()) / ONE_DAY_MS,
    );
    if (days >= 7) return `No app activity in ${days} days`;
    if (row.bucket === 'red') return 'High churn risk — multiple signals fired';
    return 'Declining engagement signals';
  }

  // ── /win-streaks ─────────────────────────────────────────────────────
  async getWinStreaks(
    coachId: string,
    opts: { minStreak?: number; limit?: number },
  ): Promise<WinStreaksResponse> {
    const minStreak =
      opts.minStreak != null && Number.isFinite(opts.minStreak) && opts.minStreak > 0
        ? Math.floor(opts.minStreak)
        : 3;
    const limit = clamp(opts.limit, 50, 100);

    const rosterRows = await this.prisma.user.findMany({
      where: { coach_id: coachId, role: 'student', deleted_at: null },
      select: { id: true, name: true },
    });
    if (rosterRows.length === 0) {
      return { items: [], total_active_streaks: 0 };
    }
    const clientIds = rosterRows.map((r) => r.id);
    const nameMap = new Map(rosterRows.map((r) => [r.id, r.name]));
    const sevenDaysAgo = new Date(Date.now() - 7 * ONE_DAY_MS);

    const checkInStreaks = await this.prisma.clientSignal.findMany({
      where: {
        user_id: { in: clientIds },
        signal_type: 'checkin_streak',
        value: { gte: minStreak },
        recorded_at: { gte: sevenDaysAgo },
      },
      orderBy: [{ value: 'desc' }, { recorded_at: 'desc' }],
      select: { user_id: true, value: true, recorded_at: true },
    });

    // Deduplicate per user — keep highest-value row
    const perUserBest = new Map<string, { value: number; recorded_at: Date }>();
    for (const s of checkInStreaks) {
      const existing = perUserBest.get(s.user_id);
      if (!existing || s.value > existing.value) {
        perUserBest.set(s.user_id, { value: s.value, recorded_at: s.recorded_at });
      }
    }

    const workoutWindow = new Date(
      Date.now() - (minStreak + 3) * ONE_DAY_MS,
    );
    const workoutStreaks = await this.prisma.clientSignal.groupBy({
      by: ['user_id'],
      where: {
        user_id: { in: clientIds },
        signal_type: 'workout_logged',
        recorded_at: { gte: workoutWindow },
      },
      _count: { _all: true },
      _min: { recorded_at: true },
    });

    const items: WinStreakEntry[] = [];
    const seen = new Set<string>();

    for (const [userId, info] of perUserBest) {
      if (items.length >= limit) break;
      seen.add(userId);
      const streakDays = Math.round(info.value);
      items.push({
        user_id: userId,
        display_name: nameMap.get(userId) ?? userId,
        streak_days: streakDays,
        streak_type: 'check_in',
        streak_started_at: new Date(
          info.recorded_at.getTime() - streakDays * ONE_DAY_MS,
        ).toISOString(),
      });
    }

    for (const g of workoutStreaks) {
      if (items.length >= limit) break;
      if (seen.has(g.user_id)) continue;
      if ((g._count?._all ?? 0) < minStreak) continue;
      const minRecorded = g._min?.recorded_at;
      if (!minRecorded) continue;
      items.push({
        user_id: g.user_id,
        display_name: nameMap.get(g.user_id) ?? g.user_id,
        streak_days: g._count._all,
        streak_type: 'workout',
        streak_started_at: minRecorded.toISOString(),
      });
    }

    items.sort((a, b) => b.streak_days - a.streak_days);

    return { items, total_active_streaks: items.length };
  }

  // ── /inbox ───────────────────────────────────────────────────────────
  async getInbox(
    coachId: string,
    opts: { limit?: number; unreadOnly?: boolean },
  ): Promise<InboxResponse> {
    const limit = clamp(opts.limit, 20, 50);

    const rosterRows = await this.prisma.user.findMany({
      where: { coach_id: coachId, role: 'student', deleted_at: null },
      select: { id: true, name: true },
    });
    if (rosterRows.length === 0) {
      return { threads: [], total_unread: 0 };
    }
    const clientIds = rosterRows.map((r) => r.id);
    const nameMap = new Map(rosterRows.map((r) => [r.id, r.name]));

    // Bound the lookback to a reasonable window and per-side cap so that
    // even on a very large coach we don't pull a million rows.
    const latestMessages = await this.prisma.message.findMany({
      where: {
        OR: [
          { sender_id: coachId, recipient_id: { in: clientIds } },
          { recipient_id: coachId, sender_id: { in: clientIds } },
        ],
      },
      orderBy: { created_at: 'desc' },
      take: 1000,
      select: {
        id: true,
        sender_id: true,
        recipient_id: true,
        body: true,
        read: true,
        created_at: true,
      },
    });

    const threadMap = new Map<string, (typeof latestMessages)[number]>();
    for (const msg of latestMessages) {
      const clientId =
        msg.sender_id === coachId ? msg.recipient_id : msg.sender_id;
      if (!threadMap.has(clientId)) {
        threadMap.set(clientId, msg);
      }
    }

    const unreadCounts = await this.prisma.message.groupBy({
      by: ['sender_id'],
      where: {
        recipient_id: coachId,
        sender_id: { in: clientIds },
        read: false,
      },
      _count: { _all: true },
    });
    const unreadMap = new Map(
      unreadCounts.map((u) => [u.sender_id, u._count._all]),
    );
    const totalUnread = unreadCounts.reduce(
      (sum, u) => sum + u._count._all,
      0,
    );

    const threads: InboxThread[] = [];
    for (const [clientId, latestMsg] of threadMap) {
      const unreadCount = unreadMap.get(clientId) ?? 0;
      if (opts.unreadOnly && unreadCount === 0) continue;
      const preview = latestMsg.body.slice(0, 120);
      const isCoachTurn = latestMsg.sender_id !== coachId;
      threads.push({
        thread_id: buildThreadId(coachId, clientId),
        client_id: clientId,
        client_name: nameMap.get(clientId) ?? clientId,
        last_message_preview: preview,
        last_message_at: latestMsg.created_at.toISOString(),
        unread_count: unreadCount,
        is_coach_turn: isCoachTurn,
      });
    }

    threads.sort(
      (a, b) =>
        new Date(b.last_message_at).getTime() -
        new Date(a.last_message_at).getTime(),
    );

    return { threads: threads.slice(0, limit), total_unread: totalUnread };
  }

  // ── /action-queue ────────────────────────────────────────────────────
  async getActionQueue(
    coachId: string,
    opts: { limit?: number; before?: string },
  ): Promise<ActionQueueResponse> {
    const limit = clamp(opts.limit, 50, 100);
    const cursor = opts.before ? new Date(opts.before) : undefined;
    const cursorValid = cursor && Number.isFinite(cursor.getTime());

    const where: Prisma.CoachAlertWhereInput = {
      coach_id: coachId,
      acknowledged_at: null,
      ...(cursorValid ? { created_at: { lt: cursor } } : {}),
    };

    const [alerts, totalPending] = await Promise.all([
      this.prisma.coachAlert.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: limit,
        include: { client: { select: { name: true } } },
      }),
      this.prisma.coachAlert.count({
        where: { coach_id: coachId, acknowledged_at: null },
      }),
    ]);

    const items: ActionQueueItem[] = alerts.map((alert) => ({
      alert_id: alert.id,
      client_id: alert.client_id,
      client_name: alert.client?.name ?? 'Unknown',
      alert_type: mapAlertType(alert.alert_type),
      message: alert.message,
      created_at: alert.created_at.toISOString(),
      dismissed_at: alert.acknowledged_at?.toISOString() ?? null,
    }));

    return { items, total_pending: totalPending };
  }

  // ── /action-queue/:alertId/dismiss ───────────────────────────────────
  async dismissAlert(
    alertId: string,
    coachId: string,
  ): Promise<{ ok: true }> {
    // CoachAlertsService.acknowledge() is already idempotent and IDOR-safe:
    //   * findFirst({ where: { id, coach_id } }) → NotFoundException for foreign alerts
    //   * returns existing row if already acknowledged (no double-write)
    await this.alertsService.acknowledge(alertId, coachId);
    return { ok: true };
  }
}
