import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { TeamService } from '../team/team.service';

// Phase 8 — head-coach-facing sub-coach surface.
//
// This service handles the /sub-coaches/* HTTP routes the mobile coach
// app talks to: list/detail/analytics/reassign + invite + revoke. It
// composes on top of:
//   - TeamSubCoachAssignment (the head <-> sub linkage)
//   - SubCoachInvite        (Phase 8 model — outbound invite rows)
//   - TeamAuditEvent        (auditable feed)
//   - User.coach_id         (single-coach legacy field reassignment)
//
// The owner/head-coach gate (only the issuing head coach can revoke or
// reassign for clients on their own sub-coaches) is enforced in every
// mutating path. Sub-coach scope is intentionally narrow — sub-coaches
// can hit GET on themselves but cannot invite or revoke.

const SUB_COACH_HEAD_CAP = 2;
const INVITE_TTL_DAYS = 14;
const TIER_MAX_CLIENTS: Record<string, number> = {
  growth: 30,
  pro: 150,
  enterprise: 500,
};
const DEFAULT_MAX_CLIENTS = 30;

export interface SubCoachSummaryView {
  id: string;
  name: string;
  email: string;
  created_at: Date;
  coach_profile: {
    plan_tier: string;
    business_name: string | null;
  } | null;
  capacity: {
    subCoachId: string;
    assignedClients: number;
    maxClients: number;
    planTier: string;
    hasCapacity: boolean;
  };
  engagement: {
    subCoachId: string;
    score: number;
    breakdown: {
      logged_in_within_7d: number;
      messaged_within_48h_of_checkin: number;
      updated_workout_plan_this_week: number;
      avg_workout_completion_gte_70: number;
    };
  };
}

export interface SubCoachDetailView extends SubCoachSummaryView {
  clients: Array<{
    id: string;
    name: string;
    email: string;
    created_at: Date;
    archived_at: Date | null;
  }>;
  coach_profile: {
    plan_tier: string;
    business_name: string | null;
    bio: string | null;
  } | null;
}

export interface InviteResult {
  inviteId: string;
  email: string;
  inviteUrl: string;
  expires_at: string;
}

export interface RevokeResult {
  ok: true;
  reassignedClientCount: number;
}

export interface ReassignResult {
  clientId: string;
  previousCoachId: string | null;
  newCoachId: string;
  auditLogId: string;
}

// Public-shape preview of a SubCoachInvite. Returned by the unauthenticated
// preview endpoint so the mobile deep-link landing screen can render
// "{head coach name} invited you to join their team" without forcing the
// user through auth first.
export interface InvitePreviewView {
  inviteId: string;
  email: string;
  name: string | null;
  max_clients: number | null;
  expires_at: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  head_coach: {
    id: string;
    name: string;
    business_name: string | null;
  };
}

// Result of POST /sub-coaches/invites/accept. `already_accepted` is true
// on the idempotent re-call path (same caller already accepted) so the
// mobile UI can avoid double-toasting.
export interface AcceptInviteResult {
  ok: true;
  inviteId: string;
  assignmentId: string;
  headCoachId: string;
  subCoachId: string;
  already_accepted: boolean;
}

@Injectable()
export class SubCoachesService {
  private readonly logger = new Logger(SubCoachesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly team: TeamService,
  ) {}

  // GET /sub-coaches — every non-archived sub-coach under the caller.
  async list(headCoachId: string): Promise<SubCoachSummaryView[]> {
    const assignments = await this.prisma.teamSubCoachAssignment.findMany({
      where: { head_coach_id: headCoachId, archived_at: null },
      orderBy: { created_at: 'desc' },
    });
    const ids = assignments.map((a) => a.sub_coach_id);
    if (ids.length === 0) return [];

    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        email: true,
        created_at: true,
        coach_profile: {
          select: { plan_tier: true, business_name: true },
        },
      },
    });
    const tierMap = await this.bulkResolveTiers(ids);
    const assignedMap = await this.bulkAssignedCounts(ids);

    return users.map((u) => this.toSummary(u, tierMap, assignedMap));
  }

  // GET /sub-coaches/:id — detailed view with client list and engagement.
  // Caller must be the head coach for this sub-coach OR the sub-coach
  // themselves (narrow self-read).
  async detail(
    callerId: string,
    callerRole: string,
    subCoachId: string,
  ): Promise<SubCoachDetailView> {
    await this.assertCanReadSubCoach(callerId, callerRole, subCoachId);

    const user = await this.prisma.user.findUnique({
      where: { id: subCoachId },
      select: {
        id: true,
        name: true,
        email: true,
        created_at: true,
        coach_profile: {
          select: { plan_tier: true, business_name: true, bio: true },
        },
      },
    });
    if (!user) throw new NotFoundException('Sub-coach not found');

    const clients = await this.prisma.user.findMany({
      where: { coach_id: subCoachId, role: 'student' },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        name: true,
        email: true,
        created_at: true,
        archived_at: true,
      },
    });

    const tierMap = await this.bulkResolveTiers([subCoachId]);
    const assignedMap = await this.bulkAssignedCounts([subCoachId]);
    const summary = this.toSummary(
      {
        id: user.id,
        name: user.name,
        email: user.email,
        created_at: user.created_at,
        coach_profile: user.coach_profile
          ? {
              plan_tier: user.coach_profile.plan_tier,
              business_name: user.coach_profile.business_name,
            }
          : null,
      },
      tierMap,
      assignedMap,
    );

    return {
      ...summary,
      clients,
      coach_profile: user.coach_profile
        ? {
            plan_tier: user.coach_profile.plan_tier,
            business_name: user.coach_profile.business_name,
            bio: user.coach_profile.bio,
          }
        : null,
    };
  }

  // GET /sub-coaches/:id/analytics — same engagement block as detail,
  // exposed as its own route so the mobile screen can refresh just the
  // metric without re-pulling the full client list.
  async analytics(
    callerId: string,
    callerRole: string,
    subCoachId: string,
  ): Promise<SubCoachSummaryView['engagement']> {
    await this.assertCanReadSubCoach(callerId, callerRole, subCoachId);
    return this.computeEngagement(subCoachId);
  }

  // POST /sub-coaches/:id/reassign-client
  // The head coach reassigns a client to a different sub-coach (or to
  // themselves by passing their own id as :id). The client must
  // currently belong to a coach within the head coach's team.
  async reassignClient(
    headCoachId: string,
    toCoachId: string,
    payload: { clientId: string; reason?: string },
  ): Promise<ReassignResult> {
    if (!payload.clientId) {
      throw new BadRequestException('clientId is required');
    }

    // The target must either be the head coach themselves OR a non-archived
    // sub-coach of the head coach. Anything else is a 403.
    if (toCoachId !== headCoachId) {
      const assignment = await this.prisma.teamSubCoachAssignment.findFirst({
        where: {
          head_coach_id: headCoachId,
          sub_coach_id: toCoachId,
          archived_at: null,
        },
        select: { id: true },
      });
      if (!assignment) {
        throw new ForbiddenException({
          kind: 'target_not_in_team',
          message: 'Target coach is not on your team.',
        });
      }
    }

    const client = await this.prisma.user.findUnique({
      where: { id: payload.clientId },
      select: {
        id: true,
        role: true,
        coach_id: true,
        name: true,
      },
    });
    if (!client) throw new NotFoundException('Client not found');
    if (client.role !== 'student') {
      throw new BadRequestException('Target user is not a client.');
    }

    // The client must currently belong to a coach in the team (head
    // or one of head's sub-coaches). Prevents cross-tenant moves.
    const allowedCoachIds = await this.teamCoachIds(headCoachId);
    if (!client.coach_id || !allowedCoachIds.has(client.coach_id)) {
      throw new ForbiddenException({
        kind: 'client_not_in_team',
        message: 'This client is not currently on your team.',
      });
    }
    const previousCoachId = client.coach_id;
    if (previousCoachId === toCoachId) {
      // No-op move. We still write an audit row so the head coach
      // sees the attempted action; mobile callers can rely on the
      // 200 envelope shape.
      const audit = await this.prisma.teamAuditEvent.create({
        data: {
          head_coach_id: headCoachId,
          actor_user_id: headCoachId,
          target_client_id: client.id,
          event_kind: 'client_reassigned',
          summary: `Client ${client.name} already on target coach; no-op.`,
          metadata: {
            from_coach_id: previousCoachId,
            to_coach_id: toCoachId,
            reason: payload.reason ?? null,
            no_op: true,
          } as Prisma.InputJsonValue,
        },
      });
      return {
        clientId: client.id,
        previousCoachId,
        newCoachId: toCoachId,
        auditLogId: audit.id,
      };
    }

    const audit = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: client.id },
        data: { coach_id: toCoachId },
      });
      return tx.teamAuditEvent.create({
        data: {
          head_coach_id: headCoachId,
          actor_user_id: headCoachId,
          target_client_id: client.id,
          event_kind: 'client_reassigned',
          summary: `Client ${client.name} reassigned.`,
          metadata: {
            from_coach_id: previousCoachId,
            to_coach_id: toCoachId,
            reason: payload.reason ?? null,
          } as Prisma.InputJsonValue,
        },
      });
    });

    await this.team.refreshCounters(headCoachId);

    return {
      clientId: client.id,
      previousCoachId,
      newCoachId: toCoachId,
      auditLogId: audit.id,
    };
  }

  // POST /sub-coaches/invites
  // Issues an invite row. The actual email send is delegated to whatever
  // mailer is wired in (we record the invite either way; the mobile UI
  // surfaces the URL as a copy-paste fallback even when email is off).
  async invite(
    headCoachId: string,
    input: { email: string; name?: string | null; max_clients?: number | null },
  ): Promise<InviteResult> {
    const email = input.email.trim().toLowerCase();
    if (!email) throw new BadRequestException('email is required');

    // Defence-in-depth — class-validator already rejected this at the
    // DTO layer, but the service is a public API too (tests, scripts).
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('email is invalid');
    }

    // Refuse to invite the head coach themselves.
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, role: true },
    });
    if (existingUser?.id === headCoachId) {
      throw new BadRequestException({
        kind: 'self_invite',
        message: 'You cannot invite yourself.',
      });
    }

    // Refuse if the target is already a non-archived sub-coach of this
    // head coach.
    if (existingUser) {
      const already = await this.prisma.teamSubCoachAssignment.findFirst({
        where: {
          head_coach_id: headCoachId,
          sub_coach_id: existingUser.id,
          archived_at: null,
        },
        select: { id: true },
      });
      if (already) {
        throw new ConflictException({
          kind: 'sub_coach_already_assigned',
          message: 'That user is already a sub-coach on your team.',
        });
      }
    }

    // Refuse if an outstanding (not-accepted, not-revoked, not-expired)
    // invite already exists for this (head, email) pair. This keeps the
    // outbox tidy without a unique constraint on (head, email).
    const now = new Date();
    const outstanding = await this.prisma.subCoachInvite.findFirst({
      where: {
        head_coach_id: headCoachId,
        email,
        accepted_at: null,
        revoked_at: null,
        expires_at: { gt: now },
      },
      select: { id: true },
    });
    if (outstanding) {
      throw new ConflictException({
        kind: 'invite_already_outstanding',
        message: 'An outstanding invite already exists for that email.',
      });
    }

    const token = this.randomToken();
    const expiresAt = new Date(now.getTime() + INVITE_TTL_DAYS * 86_400_000);

    const invite = await this.prisma.subCoachInvite.create({
      data: {
        head_coach_id: headCoachId,
        email,
        name: input.name ?? null,
        max_clients: input.max_clients ?? null,
        token,
        expires_at: expiresAt,
      },
    });

    // Audit trail. We do not write a sub_coach_assigned event yet —
    // that fires on acceptance. We do write a feed-visible event so
    // the head coach sees outbound invites.
    await this.prisma.teamAuditEvent.create({
      data: {
        head_coach_id: headCoachId,
        actor_user_id: headCoachId,
        target_client_id: null,
        event_kind: 'invite_sent_by_sub_coach', // closest existing kind
        summary: `Invite sent to ${email} to join your team as a sub-coach.`,
        metadata: {
          invite_id: invite.id,
          invite_kind: 'sub_coach_invite',
          email,
          max_clients: input.max_clients ?? null,
        } as Prisma.InputJsonValue,
      },
    });

    return {
      inviteId: invite.id,
      email,
      inviteUrl: this.buildInviteUrl(token),
      expires_at: expiresAt.toISOString(),
    };
  }

  // GET /sub-coaches/invites/by-token/:token — unauthenticated preview.
  // Lets the mobile deep-link landing screen show "{head coach} invited
  // you to join their team" before the invitee has signed in or has an
  // account. Returns a narrow status field so the UI can branch
  // (pending → show accept CTA; expired/revoked/accepted → show terminal
  // copy). Always returns a 200 envelope when the token shape resolves to
  // a row; throws NotFound for an unknown token so the link is not a
  // probe oracle.
  async previewByToken(token: string): Promise<InvitePreviewView> {
    const trimmed = (token ?? '').trim();
    if (!trimmed) {
      throw new BadRequestException({
        kind: 'invite_token_required',
        message: 'token is required',
      });
    }
    const invite = await this.prisma.subCoachInvite.findUnique({
      where: { token: trimmed },
      include: {
        head_coach: {
          select: {
            id: true,
            name: true,
            coach_profile: { select: { business_name: true } },
          },
        },
      },
    });
    if (!invite) {
      throw new NotFoundException({
        kind: 'invite_not_found',
        message: 'Invite not found.',
      });
    }
    const now = new Date();
    let status: InvitePreviewView['status'] = 'pending';
    if (invite.revoked_at) status = 'revoked';
    else if (invite.accepted_at) status = 'accepted';
    else if (invite.expires_at <= now) status = 'expired';
    return {
      inviteId: invite.id,
      email: invite.email,
      name: invite.name,
      max_clients: invite.max_clients,
      expires_at: invite.expires_at.toISOString(),
      status,
      head_coach: {
        id: invite.head_coach.id,
        name: invite.head_coach.name,
        business_name: invite.head_coach.coach_profile?.business_name ?? null,
      },
    };
  }

  // POST /sub-coaches/invites/accept — authenticated. The caller must be
  // a coach/owner whose email matches the invite. Idempotent: a second
  // call by the same accepter resolves the existing assignment and
  // returns `already_accepted: true` without writing a new audit row.
  //
  // Refusal envelopes are { kind, message } shaped so the mobile typed
  // client can switch on them. See `kind:` values below.
  async accept(
    callerId: string,
    callerRole: string,
    callerEmail: string,
    token: string,
  ): Promise<AcceptInviteResult> {
    const trimmedToken = (token ?? '').trim();
    if (!trimmedToken) {
      throw new BadRequestException({
        kind: 'invite_token_required',
        message: 'token is required',
      });
    }
    if (callerRole !== 'coach' && callerRole !== 'owner') {
      throw new ForbiddenException({
        kind: 'accept_role_not_coach',
        message: 'Only coaches can accept a sub-coach invite.',
      });
    }

    const invite = await this.prisma.subCoachInvite.findUnique({
      where: { token: trimmedToken },
    });
    if (!invite) {
      throw new NotFoundException({
        kind: 'invite_not_found',
        message: 'Invite not found.',
      });
    }

    // Cannot accept your own invite.
    if (invite.head_coach_id === callerId) {
      throw new BadRequestException({
        kind: 'cannot_accept_own_invite',
        message: 'You cannot accept an invite you issued.',
      });
    }

    // Revoked → terminal. Surfaces even if the calling user is the
    // original accepter; revocation overrides idempotency.
    if (invite.revoked_at) {
      throw new ConflictException({
        kind: 'invite_revoked',
        message: 'This invite has been revoked.',
      });
    }

    // Idempotent re-acceptance by the same user.
    if (invite.accepted_at && invite.accepted_by_user_id === callerId) {
      const existing = await this.prisma.teamSubCoachAssignment.findFirst({
        where: {
          head_coach_id: invite.head_coach_id,
          sub_coach_id: callerId,
        },
        select: { id: true },
      });
      if (existing) {
        return {
          ok: true,
          inviteId: invite.id,
          assignmentId: existing.id,
          headCoachId: invite.head_coach_id,
          subCoachId: callerId,
          already_accepted: true,
        };
      }
      // Accepted row exists but assignment row was wiped (e.g. by a
      // later revoke + manual cleanup). Fall through to recreate it.
    }

    // Accepted by someone else.
    if (invite.accepted_at && invite.accepted_by_user_id !== callerId) {
      throw new ConflictException({
        kind: 'invite_already_used',
        message: 'This invite has already been accepted.',
      });
    }

    // Expired (only if not already accepted — an accepted-then-expired
    // invite for the same user remains idempotent above).
    if (invite.expires_at <= new Date()) {
      throw new ConflictException({
        kind: 'invite_expired',
        message: 'This invite has expired. Ask the head coach to send a new one.',
      });
    }

    // Email gate: the invite is bound to the email it was issued to.
    // Compared case-insensitively against the caller's current email.
    if (
      callerEmail.trim().toLowerCase() !== invite.email.trim().toLowerCase()
    ) {
      throw new ForbiddenException({
        kind: 'invite_email_mismatch',
        message: 'This invite was issued to a different email address.',
      });
    }

    // Head-cap: a sub-coach can sit under at most SUB_COACH_HEAD_CAP
    // head coaches. Same envelope shape as the TeamModeService gate.
    const otherHeads = await this.prisma.teamSubCoachAssignment.count({
      where: {
        sub_coach_id: callerId,
        archived_at: null,
        NOT: { head_coach_id: invite.head_coach_id },
      },
    });
    if (otherHeads >= SUB_COACH_HEAD_CAP) {
      throw new ConflictException({
        kind: 'sub_coach_head_cap_exceeded',
        message: `You are already a sub-coach under ${SUB_COACH_HEAD_CAP} head coaches.`,
        cap: SUB_COACH_HEAD_CAP,
      });
    }

    const headCoach = await this.prisma.user.findUnique({
      where: { id: invite.head_coach_id },
      select: { id: true, name: true },
    });
    if (!headCoach) {
      throw new NotFoundException({
        kind: 'head_coach_missing',
        message: 'Head coach no longer exists.',
      });
    }

    const accepter = await this.prisma.user.findUnique({
      where: { id: callerId },
      select: { id: true, name: true },
    });
    if (!accepter) throw new NotFoundException('Accepting user not found');

    // Existing assignment row (may be archived from a prior revoke).
    const existingAssignment =
      await this.prisma.teamSubCoachAssignment.findFirst({
        where: {
          head_coach_id: invite.head_coach_id,
          sub_coach_id: callerId,
        },
      });
    if (existingAssignment && !existingAssignment.archived_at) {
      // Already on the team — treat as idempotent success and mark the
      // invite consumed so the audit feed stays clean.
      const updated = await this.prisma.$transaction(async (tx) => {
        if (!invite.accepted_at) {
          await tx.subCoachInvite.update({
            where: { id: invite.id },
            data: {
              accepted_at: new Date(),
              accepted_by_user_id: callerId,
            },
          });
        }
        return existingAssignment;
      });
      return {
        ok: true,
        inviteId: invite.id,
        assignmentId: updated.id,
        headCoachId: invite.head_coach_id,
        subCoachId: callerId,
        already_accepted: true,
      };
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const acceptedAt = new Date();
      await tx.subCoachInvite.update({
        where: { id: invite.id },
        data: {
          accepted_at: acceptedAt,
          accepted_by_user_id: callerId,
        },
      });
      let assignment;
      if (existingAssignment && existingAssignment.archived_at) {
        // Re-activate the prior archived row instead of creating a dup,
        // since (head_coach_id, sub_coach_id) is a unique pair.
        assignment = await tx.teamSubCoachAssignment.update({
          where: { id: existingAssignment.id },
          data: { archived_at: null },
        });
      } else {
        assignment = await tx.teamSubCoachAssignment.create({
          data: {
            head_coach_id: invite.head_coach_id,
            sub_coach_id: callerId,
            stripe_subscription_item_id: null,
          },
        });
      }
      await tx.teamAuditEvent.create({
        data: {
          head_coach_id: invite.head_coach_id,
          actor_user_id: callerId,
          target_client_id: null,
          event_kind: 'sub_coach_assigned',
          summary: `Sub-coach ${accepter.name} accepted the invite to join your team.`,
          metadata: {
            sub_coach_id: callerId,
            invite_id: invite.id,
            via: 'invite_acceptance',
            max_clients: invite.max_clients ?? null,
          } as Prisma.InputJsonValue,
        },
      });
      return assignment;
    });

    await this.team.refreshCounters(invite.head_coach_id);

    return {
      ok: true,
      inviteId: invite.id,
      assignmentId: result.id,
      headCoachId: invite.head_coach_id,
      subCoachId: callerId,
      already_accepted: false,
    };
  }

  // POST /sub-coaches/:id/revoke — head-coach-only revoke + auto-reassign.
  // Reuses the same Stripe-decrement-aware path the existing
  // TeamModeService.removeSubCoach uses, but is exposed at the top-level
  // /sub-coaches/:id/revoke shape the mobile contract expects.
  async revoke(
    headCoachId: string,
    subCoachId: string,
    payload: { reason?: string },
  ): Promise<RevokeResult> {
    const assignment = await this.prisma.teamSubCoachAssignment.findFirst({
      where: {
        head_coach_id: headCoachId,
        sub_coach_id: subCoachId,
      },
    });
    if (!assignment) {
      throw new NotFoundException({
        kind: 'sub_coach_not_assigned',
        message: 'That sub-coach is not on your team.',
      });
    }
    if (assignment.archived_at) {
      throw new ConflictException({
        kind: 'sub_coach_already_revoked',
        message: 'That sub-coach has already been revoked.',
      });
    }

    const subCoach = await this.prisma.user.findUnique({
      where: { id: subCoachId },
      select: { id: true, name: true },
    });
    if (!subCoach) throw new NotFoundException('Sub-coach user not found');

    // Find clients currently coached by this sub-coach to bounce back
    // to the head coach. Scoped to active, non-archived students whose
    // coach_id is the sub-coach.
    const clientsToReassign = await this.prisma.user.findMany({
      where: {
        coach_id: subCoachId,
        role: 'student',
        deleted_at: null,
      },
      select: { id: true },
    });
    const reassignIds = clientsToReassign.map((c) => c.id);

    await this.prisma.$transaction(async (tx) => {
      if (reassignIds.length > 0) {
        await tx.user.updateMany({
          where: { id: { in: reassignIds } },
          data: { coach_id: headCoachId },
        });
        for (const clientId of reassignIds) {
          await tx.teamAuditEvent.create({
            data: {
              head_coach_id: headCoachId,
              actor_user_id: headCoachId,
              target_client_id: clientId,
              event_kind: 'client_reassigned',
              summary: `Client reassigned to head coach during sub-coach revoke.`,
              metadata: {
                from_sub_coach_id: subCoachId,
                to_head_coach_id: headCoachId,
                revoke_reason: payload.reason ?? null,
              } as Prisma.InputJsonValue,
            },
          });
        }
      }
      await tx.teamSubCoachAssignment.update({
        where: { id: assignment.id },
        data: { archived_at: new Date() },
      });
      await tx.teamAuditEvent.create({
        data: {
          head_coach_id: headCoachId,
          actor_user_id: headCoachId,
          target_client_id: null,
          event_kind: 'sub_coach_removed',
          summary: `Sub-coach ${subCoach.name} revoked from your team.`,
          metadata: {
            sub_coach_id: subCoachId,
            reassigned_client_count: reassignIds.length,
            revoke_reason: payload.reason ?? null,
          } as Prisma.InputJsonValue,
        },
      });
    });

    await this.team.refreshCounters(headCoachId);

    return { ok: true, reassignedClientCount: reassignIds.length };
  }

  // ── helpers ───────────────────────────────────────────────────────

  private async assertCanReadSubCoach(
    callerId: string,
    callerRole: string,
    subCoachId: string,
  ): Promise<void> {
    if (callerRole === 'owner') return;
    if (callerId === subCoachId) return;
    const assigned = await this.prisma.teamSubCoachAssignment.findFirst({
      where: {
        head_coach_id: callerId,
        sub_coach_id: subCoachId,
        archived_at: null,
      },
      select: { id: true },
    });
    if (!assigned) {
      throw new ForbiddenException({
        kind: 'sub_coach_not_on_team',
        message: 'You do not have access to that sub-coach.',
      });
    }
  }

  private async teamCoachIds(headCoachId: string): Promise<Set<string>> {
    const rows = await this.prisma.teamSubCoachAssignment.findMany({
      where: { head_coach_id: headCoachId, archived_at: null },
      select: { sub_coach_id: true },
    });
    return new Set<string>([headCoachId, ...rows.map((r) => r.sub_coach_id)]);
  }

  private async bulkResolveTiers(
    coachIds: string[],
  ): Promise<Map<string, string>> {
    if (coachIds.length === 0) return new Map();
    const subs = await this.prisma.coachSubscription.findMany({
      where: { coach_id: { in: coachIds } },
      select: { coach_id: true, stripe_price_id: true },
    });
    const map = new Map<string, string>();
    for (const s of subs) {
      map.set(s.coach_id, this.priceIdToTier(s.stripe_price_id));
    }
    return map;
  }

  private async bulkAssignedCounts(
    coachIds: string[],
  ): Promise<Map<string, number>> {
    if (coachIds.length === 0) return new Map();
    const rows = await this.prisma.user.groupBy({
      by: ['coach_id'],
      where: {
        role: 'student',
        deleted_at: null,
        coach_id: { in: coachIds },
      },
      _count: { _all: true },
    });
    const map = new Map<string, number>();
    for (const r of rows) {
      if (r.coach_id) map.set(r.coach_id, r._count._all);
    }
    return map;
  }

  private toSummary(
    user: {
      id: string;
      name: string;
      email: string;
      created_at: Date;
      coach_profile: { plan_tier: string; business_name: string | null } | null;
    },
    tierMap: Map<string, string>,
    assignedMap: Map<string, number>,
  ): SubCoachSummaryView {
    const tier = tierMap.get(user.id) ?? 'unknown';
    const assigned = assignedMap.get(user.id) ?? 0;
    const max = TIER_MAX_CLIENTS[tier] ?? DEFAULT_MAX_CLIENTS;
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      created_at: user.created_at,
      coach_profile: user.coach_profile
        ? {
            plan_tier: user.coach_profile.plan_tier,
            business_name: user.coach_profile.business_name,
          }
        : null,
      capacity: {
        subCoachId: user.id,
        assignedClients: assigned,
        maxClients: max,
        planTier: tier,
        hasCapacity: assigned < max,
      },
      engagement: {
        // The full engagement block is exposed via `analytics` — the
        // list view ships a 0-score placeholder so the list payload
        // stays cheap. Mobile already polls /analytics per row when it
        // needs the breakdown.
        subCoachId: user.id,
        score: 0,
        breakdown: {
          logged_in_within_7d: 0,
          messaged_within_48h_of_checkin: 0,
          updated_workout_plan_this_week: 0,
          avg_workout_completion_gte_70: 0,
        },
      },
    };
  }

  // Engagement score (v1): four boolean / averaged signals over the last
  // seven days, each weighted equally. Anything we can't compute on a
  // dry database returns 0 rather than fake data.
  private async computeEngagement(
    subCoachId: string,
  ): Promise<SubCoachSummaryView['engagement']> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
    const fortyEightHours = 48 * 3_600_000;

    const clients = await this.prisma.user.findMany({
      where: { coach_id: subCoachId, role: 'student', deleted_at: null },
      select: { id: true },
    });
    const clientIds = clients.map((c) => c.id);
    const totalClients = clientIds.length;

    // Signal 1 — clients with any LoggedFoodEntry in last 7d.
    // Signal 3 — workout plan touched this week by the sub-coach.
    // Signal 4 — avg WorkoutSession completion ≥ 70%.
    // Signal 2 — sub-coach messaged within 48h of the most recent check-in.
    //
    // Each signal degrades to 0 when there's nothing to measure.
    let loggedIn7d = 0;
    let messagedWithin48hOfCheckin = 0;
    let updatedWorkoutPlanThisWeek = 0;
    let avgWorkoutCompletionGte70 = 0;

    if (totalClients > 0) {
      const loggedClients = await this.prisma.loggedFoodEntry.findMany({
        where: {
          user_id: { in: clientIds },
          logged_at: { gte: sevenDaysAgo },
        },
        select: { user_id: true },
        distinct: ['user_id'],
      });
      loggedIn7d = loggedClients.length;

      // For each client, find the most recent CheckIn timestamp, then
      // check whether the sub-coach sent a CoachMessage within 48h of
      // it. We use logged_at (CheckIn) and created_at (CoachMessage).
      const latestCheckIns = await this.prisma.checkIn.findMany({
        where: { user_id: { in: clientIds } },
        orderBy: { logged_at: 'desc' },
        distinct: ['user_id'],
        select: { user_id: true, logged_at: true },
      });
      if (latestCheckIns.length > 0) {
        const messages = await this.prisma.coachMessage.findMany({
          where: {
            sender_id: subCoachId,
            client_id: { in: latestCheckIns.map((c) => c.user_id) },
          },
          select: { client_id: true, created_at: true },
        });
        const byClient = new Map<string, Date[]>();
        for (const m of messages) {
          if (!m.client_id) continue;
          const list = byClient.get(m.client_id) ?? [];
          list.push(m.created_at);
          byClient.set(m.client_id, list);
        }
        for (const c of latestCheckIns) {
          const list = byClient.get(c.user_id) ?? [];
          if (
            list.some(
              (t) =>
                t.getTime() >= c.logged_at.getTime() &&
                t.getTime() <= c.logged_at.getTime() + fortyEightHours,
            )
          ) {
            messagedWithin48hOfCheckin += 1;
          }
        }
      }

      // Workout plan touched this week by the sub-coach. A new or
      // freshly-completed assignment is the closest proxy for
      // "updated workout plan" on the current schema.
      const recentAssignments =
        await this.prisma.clientWorkoutAssignment.findMany({
          where: {
            assigned_by_coach_id: subCoachId,
            client_id: { in: clientIds },
            OR: [
              { scheduled_for: { gte: sevenDaysAgo } },
              { completed_at: { gte: sevenDaysAgo } },
            ],
          },
          select: { client_id: true },
          distinct: ['client_id'],
        });
      updatedWorkoutPlanThisWeek = recentAssignments.length;

      // Avg workout completion ≥ 70%: in the absence of a per-session
      // completion-percent column, we approximate via assignment
      // completion ratio over the last 7d. A client whose 7-day
      // assignments are at least 70% completed counts.
      const recent7dAssignments =
        await this.prisma.clientWorkoutAssignment.findMany({
          where: {
            client_id: { in: clientIds },
            scheduled_for: { gte: sevenDaysAgo },
          },
          select: { client_id: true, completed_at: true },
        });
      const byClient = new Map<string, { total: number; done: number }>();
      for (const a of recent7dAssignments) {
        const cur = byClient.get(a.client_id) ?? { total: 0, done: 0 };
        cur.total += 1;
        if (a.completed_at) cur.done += 1;
        byClient.set(a.client_id, cur);
      }
      for (const { total, done } of byClient.values()) {
        if (total > 0 && done / total >= 0.7) avgWorkoutCompletionGte70 += 1;
      }
    }

    // Score = mean of four normalized signals (0..1) * 100.
    const norm = (n: number) =>
      totalClients === 0 ? 0 : Math.min(1, n / totalClients);
    const score = Math.round(
      ((norm(loggedIn7d) +
        norm(messagedWithin48hOfCheckin) +
        norm(updatedWorkoutPlanThisWeek) +
        norm(avgWorkoutCompletionGte70)) /
        4) *
        100,
    );

    return {
      subCoachId,
      score,
      breakdown: {
        logged_in_within_7d: loggedIn7d,
        messaged_within_48h_of_checkin: messagedWithin48hOfCheckin,
        updated_workout_plan_this_week: updatedWorkoutPlanThisWeek,
        avg_workout_completion_gte_70: avgWorkoutCompletionGte70,
      },
    };
  }

  private priceIdToTier(priceId: string | null): string {
    if (!priceId) return 'unknown';
    if (priceId === process.env.STRIPE_PRICE_GROWTH) return 'growth';
    if (priceId === process.env.STRIPE_PRICE_PRO) return 'pro';
    if (priceId === process.env.STRIPE_PRICE_ENTERPRISE) return 'enterprise';
    return 'unknown';
  }

  private buildInviteUrl(token: string): string {
    const base =
      process.env.PUBLIC_INVITE_BASE_URL?.trim() || 'https://app.tgp.com/join';
    return `${base}/sub-coach/${token}`;
  }

  private randomToken(): string {
    return randomBytes(24).toString('base64url');
  }

  // Helper exposed for tests/admin tooling to assert the cap.
  static get headCap(): number {
    return SUB_COACH_HEAD_CAP;
  }
}
