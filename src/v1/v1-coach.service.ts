import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { SupabaseService } from '../supabase/supabase.service';

// V1 BFF service for the coach console. Returns enriched payloads documented
// in tgp-coach-console/INTEGRATION_NOTES.md. OWNER callers bypass the coach
// scoping checks; COACH callers are scoped to their own roster.

const ACTIVE_PRESENCE_MINUTES = 5;
const RISK_NO_CHECKIN_DAYS = 5;
const RISK_ADHERENCE_PCT = 50;
const RISK_NO_REPLY_DAYS = 7;

type Caller = Pick<User, 'id' | 'role'>;

// scopeCoachId — given the authenticated caller and an explicit coachId from
// the path, returns the coachId to use for filtering. OWNER may target any
// coach by passing a coachId; otherwise the coach acts as themselves.
function resolveCoachId(caller: Caller, requested?: string | null): string {
  if (caller.role === 'owner') {
    return requested ?? caller.id;
  }
  if (caller.role === 'coach') {
    if (requested && requested !== caller.id) {
      throw new ForbiddenException();
    }
    return caller.id;
  }
  throw new ForbiddenException();
}

@Injectable()
export class V1CoachService {
  constructor(
    private prisma: PrismaService,
    private supabase: SupabaseService,
  ) {}

  // GET /v1/coach/me — coach profile, brand accent, invite code, billing
  // status. Returns null-shaped fields when the coach has not been onboarded
  // through CoachProfile/CoachSubscription yet so the console can still
  // render.
  async getMe(caller: Caller) {
    const coachId = resolveCoachId(caller);
    const [user, profile, subscription] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: coachId } }),
      this.prisma.coachProfile.findUnique({ where: { user_id: coachId } }),
      this.prisma.coachSubscription.findUnique({ where: { coach_id: coachId } }),
    ]);
    if (!user) throw new NotFoundException('Coach not found');
    return {
      id: user.id,
      email: user.email,
      fullName: user.name,
      role: user.role,
      profile: profile
        ? {
            businessName: profile.business_name,
            bio: profile.bio,
            brandAccent: profile.brand_accent,
            logoUrl: profile.logo_url,
            timezone: profile.timezone,
            inviteCode: profile.invite_code,
          }
        : null,
      subscription: subscription
        ? {
            status: subscription.status,
            currentPeriodEnd: subscription.current_period_end,
            trialEnd: subscription.trial_end,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
            lastPaymentFailedAt: subscription.last_payment_failed_at,
          }
        : null,
    };
  }

  // GET /v1/coach/me/clients — coach-scoped roster with light enrichment
  // (last check-in, last activity). The console additionally calls /metrics
  // for adherence percentages; we do not duplicate that aggregation here.
  async listClients(caller: Caller) {
    const coachId = resolveCoachId(caller);
    const clients = await this.prisma.user.findMany({
      where: { coach_id: coachId, role: 'student' },
      select: {
        id: true,
        name: true,
        email: true,
        archived_at: true,
        created_at: true,
      },
      orderBy: { created_at: 'desc' },
    });
    if (clients.length === 0) return [];

    const clientIds = clients.map((c) => c.id);
    const since = new Date();
    since.setDate(since.getDate() - 14);

    const [lastCheckIns, lastWorkouts, lastCoachReplies] = await Promise.all([
      this.prisma.checkIn.groupBy({
        by: ['user_id'],
        where: { user_id: { in: clientIds } },
        _max: { date: true },
      }),
      this.prisma.workoutSession.groupBy({
        by: ['user_id'],
        where: { user_id: { in: clientIds } },
        _max: { date: true },
      }),
      this.prisma.coachMessage.groupBy({
        by: ['client_id'],
        where: {
          coach_id: coachId,
          client_id: { in: clientIds },
          sender_id: coachId,
        },
        _max: { created_at: true },
      }),
    ]);

    const lastCheckInByClient = new Map<string, Date | null>();
    for (const r of lastCheckIns) lastCheckInByClient.set(r.user_id, r._max.date);
    const lastWorkoutByClient = new Map<string, Date | null>();
    for (const r of lastWorkouts) lastWorkoutByClient.set(r.user_id, r._max.date);
    const lastCoachReplyByClient = new Map<string, Date | null>();
    for (const r of lastCoachReplies)
      lastCoachReplyByClient.set(r.client_id, r._max.created_at);

    const now = new Date();
    return clients.map((c) => {
      const lastCheckIn = lastCheckInByClient.get(c.id) ?? null;
      const lastWorkout = lastWorkoutByClient.get(c.id) ?? null;
      const lastCoachReply = lastCoachReplyByClient.get(c.id) ?? null;
      const risk = computeRisk({
        now,
        lastCheckIn,
        lastCoachReply,
      });
      return {
        id: c.id,
        name: c.name,
        email: c.email,
        archivedAt: c.archived_at,
        joinedAt: c.created_at,
        lastCheckInAt: lastCheckIn,
        lastWorkoutAt: lastWorkout,
        lastCoachReplyAt: lastCoachReply,
        risk: risk.bucket,
        riskReason: risk.reason,
      };
    });
  }

  // GET /v1/coach/me/threads — enriched thread list per integration notes.
  async listThreads(caller: Caller) {
    const coachId = resolveCoachId(caller);

    // Pull every coach-message row for this coach in a single query, then
    // fold per client. We over-fetch but the dataset is small (one coach has
    // tens of threads, hundreds of messages) and one round-trip beats N+1.
    const messages = await this.prisma.coachMessage.findMany({
      where: { coach_id: coachId },
      orderBy: { created_at: 'desc' },
      select: {
        client_id: true,
        sender_id: true,
        body: true,
        created_at: true,
        read_at: true,
      },
    });

    type Bucket = {
      lastMessage: string;
      lastAt: Date;
      lastFrom: 'coach' | 'client';
      unread: number;
    };
    const byClient = new Map<string, Bucket>();
    for (const m of messages) {
      const b = byClient.get(m.client_id);
      if (!b) {
        byClient.set(m.client_id, {
          lastMessage: m.body,
          lastAt: m.created_at,
          lastFrom: m.sender_id === coachId ? 'coach' : 'client',
          unread:
            m.sender_id !== coachId && m.read_at === null ? 1 : 0,
        });
      } else if (m.sender_id !== coachId && m.read_at === null) {
        b.unread += 1;
      }
    }

    if (byClient.size === 0) return [];

    const clientIds = Array.from(byClient.keys());
    const clients = await this.prisma.user.findMany({
      where: { id: { in: clientIds } },
      select: { id: true, name: true, profile: { select: { avatar_url: true } } },
    });
    const clientById = new Map<string, (typeof clients)[number]>();
    for (const c of clients) clientById.set(c.id, c);

    const now = new Date();
    const presenceCutoff = new Date(now.getTime() - ACTIVE_PRESENCE_MINUTES * 60_000);
    const lastCheckIns = await this.prisma.checkIn.groupBy({
      by: ['user_id'],
      where: { user_id: { in: clientIds } },
      _max: { date: true },
    });
    const lastCheckInByClient = new Map<string, Date | null>();
    for (const r of lastCheckIns)
      lastCheckInByClient.set(r.user_id, r._max.date);

    const lastCoachReplies = await this.prisma.coachMessage.groupBy({
      by: ['client_id'],
      where: { coach_id: coachId, sender_id: coachId },
      _max: { created_at: true },
    });
    const lastCoachReplyByClient = new Map<string, Date | null>();
    for (const r of lastCoachReplies)
      lastCoachReplyByClient.set(r.client_id, r._max.created_at);

    const out = Array.from(byClient.entries()).map(([clientId, b]) => {
      const c = clientById.get(clientId);
      const risk = computeRisk({
        now,
        lastCheckIn: lastCheckInByClient.get(clientId) ?? null,
        lastCoachReply: lastCoachReplyByClient.get(clientId) ?? null,
      });
      return {
        clientId,
        clientName: c?.name ?? 'Unknown',
        avatarUrl: c?.profile?.avatar_url ?? null,
        lastMessage: b.lastMessage,
        lastAt: b.lastAt,
        lastFrom: b.lastFrom,
        unreadCount: b.unread,
        risk: risk.bucket,
        appAccess: 'fitness',
        fitnessAdherencePct: null,
        online: b.lastAt >= presenceCutoff && b.lastFrom === 'client',
      };
    });
    out.sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime());
    return out;
  }

  // GET /v1/coach/me/threads/:clientId — full message history for a thread.
  async getThread(caller: Caller, clientId: string) {
    const coachId = resolveCoachId(caller);
    const ownerBypass = caller.role === 'owner';
    // Resolve the thread's coach (for OWNERs, derive from the client's
    // assigned coach; for coaches, it's themselves).
    const client = await this.prisma.user.findFirst({
      where: ownerBypass
        ? { id: clientId, role: 'student' }
        : { id: clientId, coach_id: coachId, role: 'student' },
      select: { id: true, coach_id: true, name: true },
    });
    if (!client) throw new NotFoundException('Client not found');
    const threadCoachId = client.coach_id ?? coachId;

    const messages = await this.prisma.coachMessage.findMany({
      where: { coach_id: threadCoachId, client_id: clientId },
      orderBy: { created_at: 'asc' },
      select: {
        id: true,
        body: true,
        sender_id: true,
        created_at: true,
        read_at: true,
      },
    });
    const draft = await this.prisma.messageDraft.findUnique({
      where: {
        MessageDraft_coach_client_key: {
          coach_id: threadCoachId,
          client_id: clientId,
        },
      },
    });

    return {
      clientId,
      clientName: client.name,
      messages: messages.map((m) => ({
        id: m.id,
        body: m.body,
        from: m.sender_id === threadCoachId ? 'coach' : 'client',
        createdAt: m.created_at,
        readAt: m.read_at,
      })),
      draft: draft
        ? {
            body: draft.body,
            snippetId: draft.snippet_id,
            updatedAt: draft.updated_at,
          }
        : null,
    };
  }

  // POST /v1/coach/me/threads/:clientId/messages — coach sends a message.
  // Coach-scoped with OWNER bypass. Persists message + activity event +
  // clears the draft for that thread, then fires the realtime ping.
  async sendMessage(
    caller: Caller,
    clientId: string,
    body: string,
    snippetId?: string,
  ) {
    const coachId = resolveCoachId(caller);
    const ownerBypass = caller.role === 'owner';
    const client = await this.prisma.user.findFirst({
      where: ownerBypass
        ? { id: clientId, role: 'student' }
        : { id: clientId, coach_id: coachId, role: 'student' },
      select: { id: true, coach_id: true },
    });
    if (!client) throw new NotFoundException('Client not found');
    // For OWNER, the message is recorded against the client's actual coach.
    // If the client has no coach the OWNER acts as the coach themselves so
    // the message still has a legitimate row in the table.
    const threadCoachId = client.coach_id ?? coachId;
    const senderId = caller.id;

    const created = await this.prisma.coachMessage.create({
      data: {
        coach_id: threadCoachId,
        client_id: clientId,
        sender_id: senderId,
        body,
      },
    });

    // Best-effort side effects. Errors here must not fail the request: the
    // message is durably stored, downstream signals can be replayed.
    void this.recordActivityEvent({
      actorId: senderId,
      actorRole: caller.role,
      coachId: threadCoachId,
      clientId,
      type: 'coach.message_sent',
      summary: snippetId ? `Sent snippet: ${snippetId}` : 'Sent message',
      payload: { messageId: created.id, snippetId: snippetId ?? null },
    });
    void this.clearDraft(threadCoachId, clientId);
    void this.supabase.broadcastNewMessage(clientId);

    return {
      id: created.id,
      coachId: threadCoachId,
      clientId,
      from: senderId === threadCoachId ? 'coach' : 'owner',
      body: created.body,
      createdAt: created.created_at,
      readAt: created.read_at,
      snippetId: snippetId ?? null,
    };
  }

  // POST /v1/coach/me/threads/:clientId/draft — autosave. Idempotent on
  // (coachId, clientId) — re-posting overwrites the body in place. The
  // updated_at timestamp tells the console when the last save landed so it
  // can render the "Draft saved" hint.
  async saveDraft(
    caller: Caller,
    clientId: string,
    body: string,
    snippetId?: string,
  ) {
    const coachId = resolveCoachId(caller);
    const ownerBypass = caller.role === 'owner';
    const client = await this.prisma.user.findFirst({
      where: ownerBypass
        ? { id: clientId, role: 'student' }
        : { id: clientId, coach_id: coachId, role: 'student' },
      select: { id: true, coach_id: true },
    });
    if (!client) throw new NotFoundException('Client not found');
    const threadCoachId = client.coach_id ?? coachId;

    // Empty bodies clear the draft. The console autosaves the live composer
    // contents; once the coach hits send (which itself clears the draft) the
    // next debounce fires with the empty composer, so an empty body means
    // "no draft" rather than "store empty string".
    if (body.trim().length === 0) {
      await this.clearDraft(threadCoachId, clientId);
      return {
        coachId: threadCoachId,
        clientId,
        body: '',
        snippetId: snippetId ?? null,
        updatedAt: new Date(),
        cleared: true,
      };
    }

    const draft = await this.prisma.messageDraft.upsert({
      where: {
        MessageDraft_coach_client_key: {
          coach_id: threadCoachId,
          client_id: clientId,
        },
      },
      create: {
        coach_id: threadCoachId,
        client_id: clientId,
        body,
        snippet_id: snippetId ?? null,
      },
      update: { body, snippet_id: snippetId ?? null },
    });
    return {
      coachId: threadCoachId,
      clientId,
      body: draft.body,
      snippetId: draft.snippet_id,
      updatedAt: draft.updated_at,
      cleared: false,
    };
  }

  // GET /v1/coach/me/threads/:clientId/draft — read the current draft (used
  // when the console resumes a thread after a reload).
  async getDraft(caller: Caller, clientId: string) {
    const coachId = resolveCoachId(caller);
    const ownerBypass = caller.role === 'owner';
    const client = await this.prisma.user.findFirst({
      where: ownerBypass
        ? { id: clientId, role: 'student' }
        : { id: clientId, coach_id: coachId, role: 'student' },
      select: { id: true, coach_id: true },
    });
    if (!client) throw new NotFoundException('Client not found');
    const threadCoachId = client.coach_id ?? coachId;
    const draft = await this.prisma.messageDraft.findUnique({
      where: {
        MessageDraft_coach_client_key: {
          coach_id: threadCoachId,
          client_id: clientId,
        },
      },
    });
    return draft
      ? {
          coachId: threadCoachId,
          clientId,
          body: draft.body,
          snippetId: draft.snippet_id,
          updatedAt: draft.updated_at,
        }
      : null;
  }

  private async clearDraft(coachId: string, clientId: string) {
    try {
      await this.prisma.messageDraft.delete({
        where: {
          MessageDraft_coach_client_key: { coach_id: coachId, client_id: clientId },
        },
      });
    } catch {
      // Already absent — ignore. Prisma throws P2025 on a missing row.
    }
  }

  private async recordActivityEvent(input: {
    actorId: string;
    actorRole: string;
    coachId: string | null;
    clientId: string | null;
    type: string;
    summary?: string;
    payload?: Record<string, unknown>;
  }) {
    try {
      await this.prisma.activityEvent.create({
        data: {
          actor_id: input.actorId,
          actor_role: input.actorRole,
          coach_id: input.coachId,
          client_id: input.clientId,
          type: input.type,
          summary: input.summary,
          payload: (input.payload ?? undefined) as never,
        },
      });
    } catch {
      // Activity stream is best-effort; never fail the parent request on it.
    }
  }
}

function computeRisk(input: {
  now: Date;
  lastCheckIn: Date | null;
  lastCoachReply: Date | null;
}): { bucket: 'healthy' | 'watch' | 'at_risk'; reason: string | null } {
  const reasons: string[] = [];
  const daysSince = (d: Date | null) =>
    d ? (input.now.getTime() - d.getTime()) / 86_400_000 : Infinity;

  if (daysSince(input.lastCheckIn) > RISK_NO_CHECKIN_DAYS) {
    reasons.push(`No check-in in ${RISK_NO_CHECKIN_DAYS}+ days`);
  }
  if (daysSince(input.lastCoachReply) > RISK_NO_REPLY_DAYS) {
    reasons.push(`Last coach reply older than ${RISK_NO_REPLY_DAYS} days`);
  }
  void RISK_ADHERENCE_PCT;
  if (reasons.length >= 2) return { bucket: 'at_risk', reason: reasons.join('; ') };
  if (reasons.length === 1) return { bucket: 'watch', reason: reasons[0] };
  return { bucket: 'healthy', reason: null };
}
