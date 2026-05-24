import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, User } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { AuditService, AuditAction } from '../audit/audit.service';
import { SubCoachScopeService } from '../sub-coach/sub-coach-scope.service';

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
    private audit: AuditService,
    // Phase 11: sub-coach overlay. Optional in the type signature so the
    // many existing unit tests that build V1CoachService directly with
    // (prisma, supabase) keep compiling. In production DI it's always
    // populated because SubCoachModule is @Global.
    private subCoachScope?: SubCoachScopeService,
  ) {}

  /**
   * Scope a User-table query for the given caller. Head coach → own
   * roster. Sub-coach → only assigned clients. Owner → no scope.
   */
  private async clientScope(caller: Caller): Promise<Prisma.UserWhereInput> {
    if (caller.role === 'owner') return {};
    if (caller.role !== 'coach') {
      throw new ForbiddenException();
    }
    if (!this.subCoachScope) return { coach_id: caller.id };
    const isSub = await this.subCoachScope.isSubCoach(caller.id);
    if (!isSub) return { coach_id: caller.id };
    const ids = await this.subCoachScope.getAuthorizedClientIds(caller.id);
    if (ids.length === 0) return { id: { in: [] } };
    return { id: { in: ids } };
  }

  /**
   * The coach_id under which messages/drafts for this caller live.
   * Sub-coaches share the head coach's thread namespace; head coaches use
   * their own id; owners use whatever explicit coachId path supplies.
   */
  private async messagingCoachIdFor(caller: Caller): Promise<string> {
    if (caller.role === 'owner') return caller.id;
    if (!this.subCoachScope) return caller.id;
    const head = await this.subCoachScope.getHeadCoachIdForSubCoach(caller.id);
    return head ?? caller.id;
  }

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
            brandAccent: profile.branding_accent_color,
            logoUrl: profile.branding_logo_url,
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
    const scope = await this.clientScope(caller);
    const messagingCoachId = await this.messagingCoachIdFor(caller);
    const clients = await this.prisma.user.findMany({
      where: { ...scope, role: 'student' },
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
          coach_id: messagingCoachId,
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
    for (const r of lastCoachReplies) {
      if (r.client_id !== null) {
        lastCoachReplyByClient.set(r.client_id, r._max.created_at);
      }
    }

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
    const messagingCoachId = await this.messagingCoachIdFor(caller);
    // For sub-coaches we restrict the thread list to clients explicitly
    // assigned via SubCoachAssignment so they don't see the whole head-
    // coach team's inbox.
    const authorizedClientIds = this.subCoachScope
      ? await this.subCoachScope.getAuthorizedClientIds(coachId)
      : null;
    const isSubCoach = this.subCoachScope
      ? await this.subCoachScope.isSubCoach(coachId)
      : false;
    if (isSubCoach && authorizedClientIds && authorizedClientIds.length === 0) {
      return [];
    }

    // Pull every coach-message row for this coach in a single query, then
    // fold per client. We over-fetch but the dataset is small (one coach has
    // tens of threads, hundreds of messages) and one round-trip beats N+1.
    const messages = await this.prisma.coachMessage.findMany({
      where: {
        coach_id: messagingCoachId,
        ...(isSubCoach && authorizedClientIds
          ? { client_id: { in: authorizedClientIds } }
          : {}),
      },
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
      // Phase 6C: `body` may be null when the message is voice-only. The
      // BFF surfaces an empty string in that case so the existing UI does
      // not break; future surfaces should branch on `voice_url` instead.
      lastMessage: string;
      lastAt: Date;
      lastFrom: 'coach' | 'client';
      unread: number;
    };
    const byClient = new Map<string, Bucket>();
    for (const m of messages) {
      // Skip rows whose client_id was nulled by the SET NULL FK on a
      // hard-deleted user — there's no thread row left to render.
      if (m.client_id === null) continue;
      // Coach-side iff the sender is not the client. Covers head coach,
      // sub-coach, and OWNER sends within the thread.
      const fromCoachSide = m.sender_id !== m.client_id;
      const b = byClient.get(m.client_id);
      if (!b) {
        byClient.set(m.client_id, {
          lastMessage: m.body ?? '',
          lastAt: m.created_at,
          lastFrom: fromCoachSide ? 'coach' : 'client',
          unread: !fromCoachSide && m.read_at === null ? 1 : 0,
        });
      } else if (!fromCoachSide && m.read_at === null) {
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
      where: {
        coach_id: messagingCoachId,
        client_id: { in: clientIds },
        NOT: { sender_id: { in: clientIds } },
      },
      _max: { created_at: true },
    });
    const lastCoachReplyByClient = new Map<string, Date | null>();
    for (const r of lastCoachReplies) {
      if (r.client_id !== null) {
        lastCoachReplyByClient.set(r.client_id, r._max.created_at);
      }
    }

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
    // Resolve the thread's coach. For OWNERs, derive from the client's
    // assigned coach. For head coaches, it's themselves. For sub-coaches,
    // it's their head coach (messages live under the head coach's
    // namespace) — and the caller must have an open assignment to the
    // client.
    const scope = await this.clientScope(caller);
    const client = await this.prisma.user.findFirst({
      where: ownerBypass
        ? { id: clientId, role: 'student' }
        : { id: clientId, ...scope, role: 'student' },
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
    // OWNER read of a coach<->client thread is a sensitive event (support
    // dispute / impersonation investigation). Log it.
    if (caller.role === 'owner') {
      void this.audit.write({
        action: AuditAction.MESSAGE_THREAD_VIEWED_BY_OWNER,
        actorId: caller.id,
        actorRole: 'owner',
        targetUserId: clientId,
        targetType: 'coach_message_thread',
        targetId: `${threadCoachId}:${clientId}`,
        tenantCoachId: threadCoachId,
        metadata: { message_count: messages.length },
      });
    }
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
        // Coach-side iff the sender isn't the client. Covers head coach,
        // sub-coach, and OWNER replies in the same thread.
        from: m.sender_id === clientId ? 'client' : 'coach',
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
    const scope = await this.clientScope(caller);
    const client = await this.prisma.user.findFirst({
      where: ownerBypass
        ? { id: clientId, role: 'student' }
        : { id: clientId, ...scope, role: 'student' },
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
    if (caller.role === 'owner') {
      void this.audit.write({
        action: AuditAction.MESSAGE_SENT_BY_OWNER,
        actorId: caller.id,
        actorRole: 'owner',
        targetUserId: clientId,
        targetType: 'coach_message',
        targetId: created.id,
        tenantCoachId: threadCoachId,
        metadata: {
          message_kind: 'text',
          body_length: body.length,
          snippet_id: snippetId ?? null,
        },
      });
    }

    return {
      id: created.id,
      coachId: threadCoachId,
      clientId,
      // Label by the caller's role rather than ID equality with the thread
      // coach. Sub-coaches send under the head coach's thread (senderId !==
      // threadCoachId) but should appear to the client as 'coach', not
      // 'owner'. Only the platform OWNER role gets the 'owner' label.
      from: caller.role === 'owner' ? 'owner' : 'coach',
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
    const scope = await this.clientScope(caller);
    const client = await this.prisma.user.findFirst({
      where: ownerBypass
        ? { id: clientId, role: 'student' }
        : { id: clientId, ...scope, role: 'student' },
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
    const scope = await this.clientScope(caller);
    const client = await this.prisma.user.findFirst({
      where: ownerBypass
        ? { id: clientId, role: 'student' }
        : { id: clientId, ...scope, role: 'student' },
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
