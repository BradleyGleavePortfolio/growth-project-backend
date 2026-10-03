import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { SubCoachScopeService } from '../sub-coach/sub-coach-scope.service';
import { MessagingService, previewText } from './messaging.service';

/** Inbox row preview length (characters). */
export const INBOX_PREVIEW_MAX = 120;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export type InboxFilter = 'all' | 'unread';

export interface InboxLastMessage {
  id: string;
  sender_id: string | null;
  is_mine: boolean;
  kind: 'text' | 'voice' | 'deleted';
  preview: string;
  created_at: string;
  edited: boolean;
}

export interface InboxThreadView {
  /** Thread key used by push payloads and the thread routes (the client id). */
  thread_id: string;
  kind: 'coach_client';
  coach_id: string;
  client_id: string;
  counterpart: { user_id: string; display_name: string };
  last_message: InboxLastMessage | null;
  unread_count: number;
  muted: boolean;
  muted_until: string | null;
  pinned: boolean;
  /** The caller blocked the other participant: preview hidden, unread 0. */
  blocked_by_me: boolean;
  last_activity_at: string | null;
}

export interface InboxResponse {
  items: InboxThreadView[];
  next_cursor: string | null;
  total_unread: number;
}

interface LastRow {
  id: string;
  client_id: string;
  sender_id: string | null;
  body: string | null;
  voice_url: string | null;
  deleted_at: Date | null;
  edited_at: Date | null;
  created_at: Date;
}

interface Ranked {
  group: 0 | 1; // 0 = pinned by the caller, 1 = everything else
  at: number; // pinned_at for group 0, last activity for group 1 (ms)
  id: string; // client id tiebreak
  view: InboxThreadView;
}

/**
 * A3-MSG-CORE — the ONE inbox over the canonical 1:1 thread (CoachMessage).
 *
 * Coach: one row per client thread with at least one message, across the
 * coach's full roster (head coach) or the open SubCoachAssignment set
 * (sub-coach; the thread namespace is the head coach). Client: their single
 * thread with their coach (none when coachless: a valid, empty inbox).
 *
 * Each row: counterpart, last message preview, unread count (the SAME
 * computation as the badge routes, so the two can never disagree), the
 * caller's private mute and pin state, and `blocked_by_me`.
 *
 * Order: the caller's pinned threads first (most recently pinned first), then
 * by last activity, newest first; client id breaks ties. Keyset cursor over
 * that order. Tenancy: the client set comes from the same scope service the
 * thread routes use, and every query is bound to the thread coach id.
 */
@Injectable()
export class MessagingInboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: MessagingService,
    @Optional() private readonly subCoachScope?: SubCoachScopeService,
  ) {}

  private clampLimit(raw: number | undefined): number {
    if (!raw || raw <= 0) return DEFAULT_LIMIT;
    return Math.min(raw, MAX_LIMIT);
  }

  static encodeCursor(r: Pick<Ranked, 'group' | 'at' | 'id'>): string {
    return Buffer.from(`${r.group}|${r.at}|${r.id}`, 'utf8').toString('base64url');
  }

  static decodeCursor(raw: string | undefined): Pick<Ranked, 'group' | 'at' | 'id'> | null {
    if (!raw) return null;
    const parts = Buffer.from(raw, 'base64url').toString('utf8').split('|');
    if (parts.length !== 3) return null;
    const group = parts[0] === '0' ? 0 : parts[0] === '1' ? 1 : null;
    const at = Number(parts[1]);
    if (group === null || !Number.isFinite(at) || !parts[2]) return null;
    return { group, at, id: parts[2] };
  }

  /** Strict "comes after" in inbox order (group asc, at desc, id asc). */
  private static after(a: Ranked, c: Pick<Ranked, 'group' | 'at' | 'id'>): boolean {
    if (a.group !== c.group) return a.group > c.group;
    if (a.at !== c.at) return a.at < c.at;
    return a.id > c.id;
  }

  private lastMessageView(row: Omit<LastRow, 'client_id'>, callerId: string): InboxLastMessage {
    const deleted = row.deleted_at !== null;
    return {
      id: row.id,
      sender_id: row.sender_id,
      is_mine: row.sender_id === callerId,
      kind: deleted ? 'deleted' : row.body ? 'text' : row.voice_url ? 'voice' : 'text',
      preview: deleted ? '' : previewText(row.body, INBOX_PREVIEW_MAX),
      created_at: row.created_at.toISOString(),
      edited: !deleted && row.edited_at !== null,
    };
  }

  private async coachScope(
    coachId: string,
  ): Promise<{ threadCoachId: string; clientIds: string[] }> {
    if (this.subCoachScope) {
      const head = await this.subCoachScope.getHeadCoachIdForSubCoach(coachId);
      const clientIds = await this.subCoachScope.getAuthorizedClientIds(coachId);
      return { threadCoachId: head ?? coachId, clientIds };
    }
    const rows = await this.prisma.user.findMany({
      where: { coach_id: coachId, role: 'student' },
      select: { id: true },
    });
    return { threadCoachId: coachId, clientIds: rows.map((r) => r.id) };
  }

  async inboxForCoach(
    coachId: string,
    query: { cursor?: string; limit?: number; filter?: InboxFilter },
  ): Promise<InboxResponse> {
    const { threadCoachId, clientIds } = await this.coachScope(coachId);
    if (clientIds.length === 0) return { items: [], next_cursor: null, total_unread: 0 };

    // One indexed seek per thread: DISTINCT ON over (coach_id, client_id,
    // created_at) returns each thread's newest row.
    const last = await this.prisma.$queryRaw<LastRow[]>(Prisma.sql`
      SELECT DISTINCT ON (m."client_id")
             m."id", m."client_id", m."sender_id", m."body", m."voice_url",
             m."deleted_at", m."edited_at", m."created_at"
        FROM "CoachMessage" m
       WHERE m."coach_id" = ${threadCoachId}
         AND m."client_id" = ANY(${clientIds}::text[])
       ORDER BY m."client_id", m."created_at" DESC, m."id" DESC`);
    if (last.length === 0) return { items: [], next_cursor: null, total_unread: 0 };

    const ids = last.map((r) => r.client_id);
    const [unread, users, states, blockedList] = await Promise.all([
      this.messaging.unreadCountForCoach(coachId),
      this.prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      }),
      this.prisma.coachThreadState.findMany({
        where: { user_id: coachId, coach_id: threadCoachId, client_id: { in: ids } },
        select: { client_id: true, muted_until: true, pinned_at: true },
      }),
      this.messaging.blockedIdsFor(coachId),
    ]);
    const names = new Map(users.map((u) => [u.id, u.name]));
    const stateBy = new Map(states.map((s) => [s.client_id, s]));
    const blocked = new Set(blockedList);
    const now = Date.now();

    const ranked: Ranked[] = last.map((row) => {
      const state = stateBy.get(row.client_id);
      const blockedByMe = blocked.has(row.client_id);
      const muted = !!state?.muted_until && state.muted_until.getTime() > now;
      const pinnedAt = state?.pinned_at ?? null;
      const view: InboxThreadView = {
        thread_id: row.client_id,
        kind: 'coach_client',
        coach_id: threadCoachId,
        client_id: row.client_id,
        counterpart: {
          user_id: row.client_id,
          display_name: names.get(row.client_id)?.trim() || 'Client',
        },
        last_message: blockedByMe ? null : this.lastMessageView(row, coachId),
        unread_count: blockedByMe ? 0 : (unread.by_client[row.client_id] ?? 0),
        muted,
        muted_until: muted && state?.muted_until ? state.muted_until.toISOString() : null,
        pinned: pinnedAt !== null,
        blocked_by_me: blockedByMe,
        last_activity_at: blockedByMe ? null : row.created_at.toISOString(),
      };
      return pinnedAt
        ? { group: 0, at: pinnedAt.getTime(), id: row.client_id, view }
        : { group: 1, at: row.created_at.getTime(), id: row.client_id, view };
    });
    return this.page(ranked, query, unread.total);
  }

  private page(
    ranked: Ranked[],
    query: { cursor?: string; limit?: number; filter?: InboxFilter },
    totalUnread: number,
  ): InboxResponse {
    ranked.sort((a, b) =>
      a.group !== b.group ? a.group - b.group : a.at !== b.at ? b.at - a.at : a.id < b.id ? -1 : 1,
    );
    const filtered =
      query.filter === 'unread' ? ranked.filter((r) => r.view.unread_count > 0) : ranked;
    const cursor = MessagingInboxService.decodeCursor(query.cursor);
    const start = cursor
      ? filtered.filter((r) => MessagingInboxService.after(r, cursor))
      : filtered;
    const limit = this.clampLimit(query.limit);
    const pageRows = start.slice(0, limit);
    const hasMore = start.length > limit;
    const tail = pageRows[pageRows.length - 1];
    return {
      items: pageRows.map((r) => r.view),
      next_cursor: hasMore && tail ? MessagingInboxService.encodeCursor(tail) : null,
      total_unread: totalUnread,
    };
  }

  /** The client's inbox: their one coach thread, or empty when coachless. */
  async inboxForClient(clientId: string): Promise<InboxResponse> {
    const me = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { coach_id: true },
    });
    const coachId = me?.coach_id ?? null;
    if (!coachId) return { items: [], next_cursor: null, total_unread: 0 };

    const [row, unread, coach, state, blockedList] = await Promise.all([
      this.prisma.coachMessage.findFirst({
        where: { coach_id: coachId, client_id: clientId },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          client_id: true,
          sender_id: true,
          body: true,
          voice_url: true,
          deleted_at: true,
          edited_at: true,
          created_at: true,
        },
      }),
      this.messaging.unreadCountForClient(clientId),
      this.prisma.user.findUnique({ where: { id: coachId }, select: { name: true } }),
      this.prisma.coachThreadState.findUnique({
        where: {
          CoachThreadState_user_thread_key: {
            user_id: clientId,
            coach_id: coachId,
            client_id: clientId,
          },
        },
        select: { muted_until: true, pinned_at: true },
      }),
      this.messaging.blockedIdsFor(clientId),
    ]);
    const blockedByMe = blockedList.includes(coachId);
    const muted = !!state?.muted_until && state.muted_until.getTime() > Date.now();
    // A coach thread exists for every coached client, even before the first
    // message, so the inbox always offers a way to start the conversation.
    const view: InboxThreadView = {
      thread_id: clientId,
      kind: 'coach_client',
      coach_id: coachId,
      client_id: clientId,
      counterpart: { user_id: coachId, display_name: coach?.name?.trim() || 'Your coach' },
      last_message: row && !blockedByMe ? this.lastMessageView(row, clientId) : null,
      unread_count: blockedByMe ? 0 : unread.total,
      muted,
      muted_until: muted && state?.muted_until ? state.muted_until.toISOString() : null,
      pinned: !!state?.pinned_at,
      blocked_by_me: blockedByMe,
      last_activity_at: row && !blockedByMe ? row.created_at.toISOString() : null,
    };
    return { items: [view], next_cursor: null, total_unread: view.unread_count };
  }
}
