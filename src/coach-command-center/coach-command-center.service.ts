import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  AdminPtmService,
  type CoachRiskBoardResponse,
} from '../admin/ptm/admin-ptm.service';
import type { PtmRiskBucket } from '../ptm/ptm.types';

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 20;
const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 100;

function clampPageSize(raw: number | undefined): number {
  const n = raw ?? DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(n, MIN_PAGE_SIZE), MAX_PAGE_SIZE);
}

function parseCursor(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Public response shapes
// ---------------------------------------------------------------------------

/** A single thread summary for the inbox view. */
export interface InboxThread {
  /** The client's user id. */
  client_id: string;
  /** The client's display name. */
  client_name: string;
  /** The client's email — available for coach tooling; never shown in leaderboard or public surfaces. */
  client_email: string;
  /** ISO-8601 of the most-recent message in this thread. */
  last_message_at: string;
  /** First 120 chars of the last message body. Null when voice-only. */
  last_message_preview: string | null;
  /** True when the last message was a voice note. */
  last_message_is_voice: boolean;
  /**
   * Count of messages where sender_id = client AND read_at IS NULL.
   * These are messages the coach has not yet read.
   */
  unread_count: number;
}

export interface InboxResponse {
  data: InboxThread[];
  next_cursor: string | null;
}

// ---------------------------------------------------------------------------

/** A single win-streak row for the leaderboard. */
export interface WinStreakRow {
  client_id: string;
  client_name: string;
  /** ISO-8601 of the Day 1 win, or null if never completed. */
  first_win_at: string | null;
  /**
   * Number of distinct check-in dates in the last 30 days. This is the
   * "engagement" score for the leaderboard — no personal body or income data.
   */
  checkins_last_30_days: number;
  /** ISO-8601 of the most-recent check-in, or null. */
  last_checkin_at: string | null;
}

export interface WinStreakResponse {
  data: WinStreakRow[];
  next_cursor: string | null;
}

// ---------------------------------------------------------------------------

/** Reason why a client appears in the action queue. */
export type ActionReasonCode =
  | 'unread_message'
  | 'missed_checkin'
  | 'at_risk'
  | 'no_first_win';

/** A single item in the coach action queue. */
export interface ActionQueueItem {
  client_id: string;
  client_name: string;
  client_email: string;
  reason_code: ActionReasonCode;
  /** Human-readable explanation for the reason code. */
  reason_detail: string;
  /** ISO-8601 of when this signal was detected. */
  signal_at: string;
}

export interface ActionQueueResponse {
  data: ActionQueueItem[];
  next_cursor: string | null;
}

// ---------------------------------------------------------------------------

/** Aggregated payload for the Coach Command Center home tab. */
export interface OverviewResponse {
  /** Total active (non-archived, non-deleted) clients on this coach's roster. */
  total_clients: number;
  /** Count of clients with at least one unread message. */
  clients_with_unread_messages: number;
  /** PTM risk bucket distribution across the coach's roster. */
  risk_counts: { red: number; amber: number; green: number; no_data: number };
  /** Number of items in the action queue (across all reason codes). */
  action_queue_size: number;
  /** Top 5 most-recent inbox threads with unread activity, newest first. */
  top_inbox_threads: InboxThread[];
  /** Top 5 clients by check-in count over the last 30 days. */
  top_win_streaks: WinStreakRow[];
  generated_at: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class CoachCommandCenterService {
  constructor(
    private readonly prisma: PrismaService,
    // Reused — no duplicate risk math here.
    private readonly adminPtm: AdminPtmService,
  ) {}

  // -------------------------------------------------------------------------
  // Overview — single aggregated payload, single Prisma round-trip for clients
  // + one grouped query for unread counts. No N+1.
  // -------------------------------------------------------------------------

  async getOverview(coachId: string): Promise<OverviewResponse> {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

    // One query: all active clients with their PTM prediction + check-ins
    // + most-recent message in each thread.
    const clients = await this.prisma.user.findMany({
      where: {
        coach_id: coachId,
        role: 'student',
        archived_at: null,
        deleted_at: null,
      },
      select: {
        id: true,
        name: true,
        email: true,
        first_win_completed_at: true,
        created_at: true,
        ptm_predictions: {
          orderBy: { computed_at: 'desc' },
          take: 1,
          select: { risk_score: true, computed_at: true },
        },
        // Check-ins in the last 30 days for win-streak leaderboard.
        check_ins: {
          where: { date: { gte: thirtyDaysAgo } },
          orderBy: { date: 'desc' },
          select: { date: true, logged_at: true },
        },
        // Most-recent message in this coach↔client thread for inbox preview.
        coach_messages_as_client: {
          where: { coach_id: coachId },
          orderBy: { created_at: 'desc' },
          take: 1,
          select: {
            body: true,
            voice_url: true,
            sender_id: true,
            created_at: true,
          },
        },
      },
    });

    const clientIds = clients.map((c) => c.id);

    // Grouped unread count per client (messages sent BY client, unread by coach).
    const unreadGroups =
      clientIds.length > 0
        ? await this.prisma.coachMessage.groupBy({
            by: ['client_id'],
            _count: { id: true },
            _max: { created_at: true },
            where: {
              coach_id: coachId,
              client_id: { in: clientIds },
              sender_id: { not: coachId },
              read_at: null,
            },
          })
        : [];

    const unreadByClient = new Map<string, { count: number; last_at: Date | null }>(
      unreadGroups.map((g) => [
        g.client_id,
        { count: g._count.id, last_at: g._max.created_at ?? null },
      ]),
    );

    // Risk bucket counts.
    let redCount = 0;
    let amberCount = 0;
    let greenCount = 0;
    let noDataCount = 0;
    for (const c of clients) {
      const latest = c.ptm_predictions[0];
      if (!latest) {
        noDataCount++;
      } else if (latest.risk_score >= 0.6) {
        redCount++;
      } else if (latest.risk_score >= 0.3) {
        amberCount++;
      } else {
        greenCount++;
      }
    }

    // Build inbox threads (only clients that have at least one message).
    const inboxThreads: InboxThread[] = clients
      .filter((c) => c.coach_messages_as_client.length > 0)
      .map((c) => {
        const last = c.coach_messages_as_client[0];
        return {
          client_id: c.id,
          client_name: c.name,
          client_email: c.email,
          last_message_at: last.created_at.toISOString(),
          last_message_preview: last.body ? last.body.slice(0, 120) : null,
          last_message_is_voice: !!last.voice_url,
          unread_count: unreadByClient.get(c.id)?.count ?? 0,
        };
      })
      .sort(
        (a, b) =>
          new Date(b.last_message_at).getTime() -
          new Date(a.last_message_at).getTime(),
      );

    const clientsWithUnread = inboxThreads.filter(
      (t) => t.unread_count > 0,
    ).length;

    // Win-streak rows sorted by 30-day check-in count desc.
    const winStreakRows: WinStreakRow[] = clients
      .map((c) => ({
        client_id: c.id,
        client_name: c.name,
        first_win_at: c.first_win_completed_at?.toISOString() ?? null,
        checkins_last_30_days: c.check_ins.length,
        last_checkin_at: c.check_ins[0]?.logged_at.toISOString() ?? null,
      }))
      .sort((a, b) => b.checkins_last_30_days - a.checkins_last_30_days);

    // Action queue size: count distinct clients needing attention.
    const actionSet = new Set<string>();
    for (const c of clients) {
      if ((unreadByClient.get(c.id)?.count ?? 0) > 0) {
        actionSet.add(c.id);
        continue;
      }
      const latest = c.ptm_predictions[0];
      if (latest && latest.risk_score >= 0.6) {
        actionSet.add(c.id);
        continue;
      }
      const lastCheckin = c.check_ins[0];
      if (!lastCheckin || lastCheckin.logged_at < threeDaysAgo) {
        actionSet.add(c.id);
        continue;
      }
      if (!c.first_win_completed_at) {
        actionSet.add(c.id);
      }
    }

    return {
      total_clients: clients.length,
      clients_with_unread_messages: clientsWithUnread,
      risk_counts: {
        red: redCount,
        amber: amberCount,
        green: greenCount,
        no_data: noDataCount,
      },
      action_queue_size: actionSet.size,
      top_inbox_threads: inboxThreads.slice(0, 5),
      top_win_streaks: winStreakRows.slice(0, 5),
      generated_at: now.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // At-risk — delegates entirely to AdminPtmService (no duplicate math).
  // -------------------------------------------------------------------------

  async getAtRisk(
    coachId: string,
    opts: { bucket?: string; cursor?: string; limit?: number },
  ): Promise<CoachRiskBoardResponse> {
    return this.adminPtm.getRiskBoardForCoach(coachId, {
      bucket: opts.bucket as PtmRiskBucket | undefined,
      cursor: opts.cursor,
      limit: opts.limit,
    });
  }

  // -------------------------------------------------------------------------
  // Win-streak leaderboard — coach's active roster, sorted by 30-day check-in
  // count. Cursor is on `created_at` of the last user row for stability.
  // -------------------------------------------------------------------------

  async getWinStreaks(
    coachId: string,
    opts: { cursor?: string; limit?: number },
  ): Promise<WinStreakResponse> {
    const limit = clampPageSize(opts.limit);
    const cursorDate = parseCursor(opts.cursor);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const clients = await this.prisma.user.findMany({
      where: {
        coach_id: coachId,
        role: 'student',
        archived_at: null,
        deleted_at: null,
        ...(cursorDate ? { created_at: { lt: cursorDate } } : {}),
      },
      select: {
        id: true,
        name: true,
        first_win_completed_at: true,
        created_at: true,
        check_ins: {
          where: { date: { gte: thirtyDaysAgo } },
          orderBy: { date: 'desc' },
          select: { date: true, logged_at: true },
        },
      },
      orderBy: { created_at: 'desc' },
      // Fetch limit+1 to detect a next page.
      take: limit + 1,
    });

    const hasMore = clients.length > limit;
    const page = hasMore ? clients.slice(0, limit) : clients;

    // Sort by 30-day check-in count desc; first_win_completed_at asc as tiebreak.
    page.sort((a, b) => {
      const diff = b.check_ins.length - a.check_ins.length;
      if (diff !== 0) return diff;
      const aWin = a.first_win_completed_at?.getTime() ?? Infinity;
      const bWin = b.first_win_completed_at?.getTime() ?? Infinity;
      return aWin - bWin;
    });

    const nextCursor = hasMore
      ? (clients[limit - 1]?.created_at.toISOString() ?? null)
      : null;

    return {
      data: page.map((c) => ({
        client_id: c.id,
        client_name: c.name,
        first_win_at: c.first_win_completed_at?.toISOString() ?? null,
        checkins_last_30_days: c.check_ins.length,
        last_checkin_at: c.check_ins[0]?.logged_at.toISOString() ?? null,
      })),
      next_cursor: nextCursor,
    };
  }

  // -------------------------------------------------------------------------
  // Inbox — paginated thread list, newest-first, with unread counts.
  //
  // Strategy:
  //   1. Group CoachMessage by client_id to find latest-message timestamps.
  //   2. Fetch client info + per-thread unread count in parallel.
  // -------------------------------------------------------------------------

  async getInbox(
    coachId: string,
    opts: { cursor?: string; limit?: number },
  ): Promise<InboxResponse> {
    const limit = clampPageSize(opts.limit);
    const cursorDate = parseCursor(opts.cursor);

    // Step 1: latest message per thread (for cursor pagination).
    const latestPerThread = await this.prisma.coachMessage.groupBy({
      by: ['client_id'],
      _max: { created_at: true },
      where: {
        coach_id: coachId,
        ...(cursorDate ? { created_at: { lt: cursorDate } } : {}),
      },
      orderBy: { _max: { created_at: 'desc' } },
      take: limit + 1,
    });

    const hasMore = latestPerThread.length > limit;
    const page = hasMore ? latestPerThread.slice(0, limit) : latestPerThread;

    if (page.length === 0) {
      return { data: [], next_cursor: null };
    }

    const pageClientIds = page.map((g) => g.client_id);
    const latestDates = page
      .filter((g) => g._max.created_at != null)
      .map((g) => g._max.created_at as Date);

    // Step 2: fetch message previews + unread counts + client names in parallel.
    const [latestMessages, unreadGroups, clientInfos] = await Promise.all([
      this.prisma.coachMessage.findMany({
        where: {
          coach_id: coachId,
          client_id: { in: pageClientIds },
          created_at: { in: latestDates },
        },
        select: {
          client_id: true,
          body: true,
          voice_url: true,
          sender_id: true,
          created_at: true,
        },
      }),
      this.prisma.coachMessage.groupBy({
        by: ['client_id'],
        _count: { id: true },
        where: {
          coach_id: coachId,
          client_id: { in: pageClientIds },
          sender_id: { not: coachId },
          read_at: null,
        },
      }),
      this.prisma.user.findMany({
        where: { id: { in: pageClientIds } },
        select: { id: true, name: true, email: true },
      }),
    ]);

    const latestByClient = new Map(latestMessages.map((m) => [m.client_id, m]));
    const unreadByClient = new Map(
      unreadGroups.map((g) => [g.client_id, g._count.id]),
    );
    const clientById = new Map(clientInfos.map((c) => [c.id, c]));

    const threads: InboxThread[] = page
      .map((g) => {
        const client = clientById.get(g.client_id);
        const last = latestByClient.get(g.client_id);
        if (!client || !last) return null;
        return {
          client_id: g.client_id,
          client_name: client.name,
          client_email: client.email,
          last_message_at: last.created_at.toISOString(),
          last_message_preview: last.body ? last.body.slice(0, 120) : null,
          last_message_is_voice: !!last.voice_url,
          unread_count: unreadByClient.get(g.client_id) ?? 0,
        } as InboxThread;
      })
      .filter((t): t is InboxThread => t !== null)
      .sort(
        (a, b) =>
          new Date(b.last_message_at).getTime() -
          new Date(a.last_message_at).getTime(),
      );

    const nextCursor = hasMore
      ? (page[limit - 1]?._max.created_at?.toISOString() ?? null)
      : null;

    return { data: threads, next_cursor: nextCursor };
  }

  // -------------------------------------------------------------------------
  // Action queue — clients needing coach attention.
  //
  // Reason codes in priority order (each client appears at most once):
  //   1. unread_message  — client sent an unread message.
  //   2. at_risk         — PTM risk_score >= 0.6 (red bucket).
  //   3. missed_checkin  — no check-in in the last 3 days.
  //   4. no_first_win    — first_win_completed_at is null (new client).
  //
  // Privacy: coachId is always taken from req.user.id. No caller-supplied
  // scope override is possible.
  // -------------------------------------------------------------------------

  async getActionQueue(
    coachId: string,
    opts: { reason_code?: string; cursor?: string; limit?: number },
  ): Promise<ActionQueueResponse> {
    const limit = clampPageSize(opts.limit);
    const cursorDate = parseCursor(opts.cursor);
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

    const clients = await this.prisma.user.findMany({
      where: {
        coach_id: coachId,
        role: 'student',
        archived_at: null,
        deleted_at: null,
        ...(cursorDate ? { created_at: { lt: cursorDate } } : {}),
      },
      select: {
        id: true,
        name: true,
        email: true,
        created_at: true,
        first_win_completed_at: true,
        ptm_predictions: {
          orderBy: { computed_at: 'desc' },
          take: 1,
          select: { risk_score: true, computed_at: true },
        },
        check_ins: {
          orderBy: { date: 'desc' },
          take: 1,
          select: { date: true, logged_at: true },
        },
      },
      orderBy: { created_at: 'desc' },
    });

    if (clients.length === 0) {
      return { data: [], next_cursor: null };
    }

    const clientIds = clients.map((c) => c.id);

    const unreadGroups = await this.prisma.coachMessage.groupBy({
      by: ['client_id'],
      _count: { id: true },
      _max: { created_at: true },
      where: {
        coach_id: coachId,
        client_id: { in: clientIds },
        sender_id: { not: coachId },
        read_at: null,
      },
    });

    const unreadByClient = new Map<
      string,
      { count: number; last_at: Date | null }
    >(
      unreadGroups.map((g) => [
        g.client_id,
        { count: g._count.id, last_at: g._max.created_at ?? null },
      ]),
    );

    const allItems: ActionQueueItem[] = [];
    const seen = new Set<string>();

    const addItem = (item: ActionQueueItem): void => {
      if (seen.has(item.client_id)) return;
      seen.add(item.client_id);
      allItems.push(item);
    };

    // Priority 1: unread messages.
    for (const c of clients) {
      const u = unreadByClient.get(c.id);
      if (u && u.count > 0) {
        addItem({
          client_id: c.id,
          client_name: c.name,
          client_email: c.email,
          reason_code: 'unread_message',
          reason_detail: `${u.count} unread message${u.count === 1 ? '' : 's'} from this client.`,
          signal_at: u.last_at?.toISOString() ?? now.toISOString(),
        });
      }
    }

    // Priority 2: at-risk (PTM red bucket).
    for (const c of clients) {
      const latest = c.ptm_predictions[0];
      if (latest && latest.risk_score >= 0.6) {
        addItem({
          client_id: c.id,
          client_name: c.name,
          client_email: c.email,
          reason_code: 'at_risk',
          reason_detail: `Client is in the high-risk bucket. Last scored ${latest.computed_at.toISOString()}.`,
          signal_at: latest.computed_at.toISOString(),
        });
      }
    }

    // Priority 3: missed check-in (no check-in in last 3 days).
    for (const c of clients) {
      const lastCheckin = c.check_ins[0];
      const hasRecent = lastCheckin && lastCheckin.logged_at >= threeDaysAgo;
      if (!hasRecent) {
        addItem({
          client_id: c.id,
          client_name: c.name,
          client_email: c.email,
          reason_code: 'missed_checkin',
          reason_detail: lastCheckin
            ? `Last check-in was ${lastCheckin.logged_at.toISOString()} — more than 3 days ago.`
            : 'No check-ins recorded for this client.',
          signal_at: lastCheckin
            ? lastCheckin.logged_at.toISOString()
            : c.created_at.toISOString(),
        });
      }
    }

    // Priority 4: no first win (new client, needs outreach).
    for (const c of clients) {
      if (!c.first_win_completed_at) {
        addItem({
          client_id: c.id,
          client_name: c.name,
          client_email: c.email,
          reason_code: 'no_first_win',
          reason_detail:
            'Client has not completed their first win. Consider sending a welcome message.',
          signal_at: c.created_at.toISOString(),
        });
      }
    }

    const filtered = opts.reason_code
      ? allItems.filter((i) => i.reason_code === opts.reason_code)
      : allItems;

    const hasMore = filtered.length > limit;
    const paginated = filtered.slice(0, limit);

    const nextCursor = hasMore
      ? (clients[limit - 1]?.created_at.toISOString() ?? null)
      : null;

    return { data: paginated, next_cursor: nextCursor };
  }
}
