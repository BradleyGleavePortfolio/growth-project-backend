import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { PtmService } from '../ptm/ptm.service';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type ListOpts = { before?: string; limit?: number };

@Injectable()
export class MessagingService {
  constructor(
    private prisma: PrismaService,
    private supabase: SupabaseService,
    private analytics: AnalyticsService,
    private ptm: PtmService,
  ) {}

  // ---- helpers ----

  private clampLimit(limit?: number): number {
    if (!limit || limit <= 0) return DEFAULT_LIMIT;
    return Math.min(limit, MAX_LIMIT);
  }

  private parseBefore(before?: string): Date | undefined {
    if (!before) return undefined;
    const d = new Date(before);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }

  // Look up a client and verify they belong to this coach. 404 on missing /
  // foreign — the existence of a foreign client must not leak. When the caller
  // is OWNER, the coach scoping check is bypassed (OWNER reads any thread).
  // The returned coach_id is the thread's coach (the client's assigned coach
  // for OWNERs; the caller for normal coaches).
  private async assertClientOfCoach(
    coachId: string,
    clientId: string,
    opts: { ownerBypass?: boolean } = {},
  ): Promise<{ id: string; coach_id: string | null }> {
    if (opts.ownerBypass) {
      const client = await this.prisma.user.findFirst({
        where: { id: clientId, role: 'student' },
        select: { id: true, coach_id: true },
      });
      if (!client) throw new NotFoundException('Client not found');
      return client;
    }
    const client = await this.prisma.user.findFirst({
      where: { id: clientId, coach_id: coachId, role: 'student' },
      select: { id: true, coach_id: true },
    });
    if (!client) throw new NotFoundException('Client not found');
    return client;
  }

  // Load the current coach_id for a client. Throws 409 if no coach assigned —
  // callers map this to the NO_COACH_ASSIGNED contract.
  private async requireClientCoachId(clientId: string): Promise<string> {
    const me = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { coach_id: true },
    });
    if (!me?.coach_id) {
      throw new ConflictException({ error: 'NO_COACH_ASSIGNED' });
    }
    return me.coach_id;
  }

  // ---- thread read ----

  // Paginated thread, newest-first. `before` is a strict `<` on created_at so
  // the client can pass the oldest timestamp it has seen to fetch the next
  // page without duplicates. Composite index (coach_id, client_id, created_at)
  // makes this a single seek.
  private async listThread(coachId: string, clientId: string, opts: ListOpts) {
    const limit = this.clampLimit(opts.limit);
    const before = this.parseBefore(opts.before);
    return this.prisma.coachMessage.findMany({
      where: {
        coach_id: coachId,
        client_id: clientId,
        ...(before ? { created_at: { lt: before } } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
  }

  async listThreadForCoach(coachId: string, clientId: string, opts: ListOpts) {
    await this.assertClientOfCoach(coachId, clientId);
    return this.listThread(coachId, clientId, opts);
  }

  async listThreadForClient(clientId: string, opts: ListOpts) {
    const coachId = await this.requireClientCoachId(clientId);
    return this.listThread(coachId, clientId, opts);
  }

  // ---- send ----

  async sendAsCoach(coachId: string, clientId: string, body: string) {
    await this.assertClientOfCoach(coachId, clientId);
    const created = await this.prisma.coachMessage.create({
      data: { coach_id: coachId, client_id: clientId, sender_id: coachId, body },
    });
    // Realtime ping to the recipient (the client). No body is sent over the
    // wire — just a refresh signal. The mobile client refetches via the
    // authenticated REST endpoint when it receives the ping. Fire-and-
    // forget so a Realtime hiccup never delays the API response.
    void this.supabase.broadcastNewMessage(clientId);
    this.analytics.capture(coachId, Events.COACH_MESSAGE_SENT, {
      client_id: clientId,
      body_length: body.length,
    });
    // PTM signals: from the CLIENT's perspective, a coach send is an inbound
    // message and a coach note. userId is the client, never the coach — the
    // PTM model scores clients, not coaches.
    this.ptm.emit(clientId, 'message_received', body.length);
    this.ptm.emit(clientId, 'coach_note_received', 1);
    return created;
  }

  async sendAsClient(clientId: string, body: string) {
    const coachId = await this.requireClientCoachId(clientId);
    const created = await this.prisma.coachMessage.create({
      data: { coach_id: coachId, client_id: clientId, sender_id: clientId, body },
    });
    // Ping the coach.
    void this.supabase.broadcastNewMessage(coachId);
    this.analytics.capture(clientId, Events.CLIENT_MESSAGE_SENT, {
      coach_id: coachId,
      body_length: body.length,
    });
    this.ptm.emit(clientId, 'message_sent', body.length);
    return created;
  }

  // ---- read markers ----

  // Mark every message from the *other* party in this thread as read. We only
  // touch rows where read_at IS NULL so repeated calls are idempotent and the
  // original read timestamp survives.
  async markReadByCoach(coachId: string, clientId: string) {
    await this.assertClientOfCoach(coachId, clientId);
    const result = await this.prisma.coachMessage.updateMany({
      where: {
        coach_id: coachId,
        client_id: clientId,
        sender_id: clientId,
        read_at: null,
      },
      data: { read_at: new Date() },
    });
    return { updated: result.count };
  }

  async markReadByClient(clientId: string) {
    const coachId = await this.requireClientCoachId(clientId);
    const result = await this.prisma.coachMessage.updateMany({
      where: {
        coach_id: coachId,
        client_id: clientId,
        sender_id: coachId,
        read_at: null,
      },
      data: { read_at: new Date() },
    });
    return { updated: result.count };
  }

  // ---- unread counts ----

  // Coach's unread inbox: messages where the coach is the recipient
  // (sender = client). Returns total + per-client breakdown so the coach UI
  // can badge each thread row without N extra round-trips.
  async unreadCountForCoach(coachId: string) {
    const groups = await this.prisma.coachMessage.groupBy({
      by: ['client_id'],
      where: {
        coach_id: coachId,
        read_at: null,
        NOT: { sender_id: coachId },
      },
      _count: { _all: true },
    });
    const by_client: Record<string, number> = {};
    let total = 0;
    for (const g of groups) {
      by_client[g.client_id] = g._count._all;
      total += g._count._all;
    }
    return { total, by_client };
  }

  async unreadCountForClient(clientId: string) {
    const coachId = await this.prisma.user
      .findUnique({ where: { id: clientId }, select: { coach_id: true } })
      .then((u) => u?.coach_id ?? null);
    // No coach → nothing to read. We *don't* 409 here because the mobile client
    // polls this endpoint on every screen focus and a 409 would spam logs.
    if (!coachId) return { total: 0 };
    const total = await this.prisma.coachMessage.count({
      where: {
        coach_id: coachId,
        client_id: clientId,
        sender_id: coachId,
        read_at: null,
      },
    });
    return { total };
  }
}

// Re-export ForbiddenException so service consumers can distinguish authorization
// failures without importing from @nestjs/common themselves.
export { ForbiddenException };
