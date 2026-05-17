import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { TeamService } from '../team/team.service';
import type {
  AcceptInviteResult,
  InvitePreviewView,
  InviteResult,
} from './sub-coaches.types';
import {
  INVITE_TTL_DAYS,
  SUB_COACH_HEAD_CAP,
} from './sub-coaches.types';

// Phase 8 — invite lifecycle (issue / preview / accept / reissue / revoke).
// Split out of the monolithic SubCoachesService so each surface
// (analytics, invites, list/detail) lives in its own file. No behaviour
// change vs the pre-split code path; SubCoachesService delegates here.
@Injectable()
export class SubCoachInviteService {
  private readonly logger = new Logger(SubCoachInviteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly team: TeamService,
  ) {}

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

    const { invite } = await this.prisma.$transaction(async (tx) => {
      const invite = await tx.subCoachInvite.create({
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
      await tx.teamAuditEvent.create({
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

      return { invite };
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
    //
    // Recovery path (P0 fix): we surface the inviteId + head_coach_id in
    // the refusal so the mobile UI can prompt the head coach to call
    // POST /sub-coaches/invites/:id/reissue with the correct email
    // (which generates a fresh token bound to the right address). Without
    // this hook, an invite typo with no recovery was a TestFlight
    // blocker.
    if (
      callerEmail.trim().toLowerCase() !== invite.email.trim().toLowerCase()
    ) {
      throw new ForbiddenException({
        kind: 'invite_email_mismatch',
        message:
          'This invite was issued to a different email address. Ask the head coach to reissue it to your current email.',
        invite_id: invite.id,
        head_coach_id: invite.head_coach_id,
        recovery: 'reissue',
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

  // POST /sub-coaches/invites/:inviteId/reissue — head-coach-only safety
  // valve when a sub-coach can't accept their invite (typo'd email,
  // alias swap, etc.). Generates a fresh token + expiry on the existing
  // invite row, optionally rebinding the email. Idempotency-friendly:
  // calling twice returns the same row with a freshly-rotated token, so
  // the head coach can re-send without producing duplicates that would
  // trip the (head, email) outstanding-invite guard.
  //
  // Rules:
  //   - Only the issuing head coach may reissue.
  //   - Cannot reissue an already-accepted invite (would silently reset
  //     the sub-coach's link to the team). Use revoke + invite instead.
  //   - Revoked invites can be reissued: that's the whole point — the
  //     head coach changed their mind about the revocation.
  //   - When `email` is supplied, it replaces the bound address. Same
  //     validation as invite() (lowercase, RFC-ish shape). We refuse if
  //     the new email already has a different outstanding invite on
  //     this head coach.
  async reissueInvite(
    headCoachId: string,
    inviteId: string,
    input: { email?: string | null; name?: string | null } = {},
  ): Promise<InviteResult> {
    const invite = await this.prisma.subCoachInvite.findUnique({
      where: { id: inviteId },
    });
    if (!invite) {
      throw new NotFoundException({
        kind: 'invite_not_found',
        message: 'Invite not found.',
      });
    }
    if (invite.head_coach_id !== headCoachId) {
      throw new ForbiddenException({
        kind: 'invite_not_yours',
        message: 'You are not the issuer of this invite.',
      });
    }
    if (invite.accepted_at) {
      throw new ConflictException({
        kind: 'invite_already_accepted',
        message:
          'This invite has already been accepted. Revoke the sub-coach and send a new invite instead.',
      });
    }

    const nextEmail = (input.email ?? invite.email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
      throw new BadRequestException('email is invalid');
    }

    // Refuse if the head coach has a DIFFERENT outstanding invite for
    // the proposed email. Same row is fine — that's the reissue we're
    // about to do.
    if (nextEmail !== invite.email.trim().toLowerCase()) {
      const conflict = await this.prisma.subCoachInvite.findFirst({
        where: {
          head_coach_id: headCoachId,
          email: nextEmail,
          accepted_at: null,
          revoked_at: null,
          expires_at: { gt: new Date() },
          NOT: { id: invite.id },
        },
        select: { id: true },
      });
      if (conflict) {
        throw new ConflictException({
          kind: 'invite_already_outstanding',
          message:
            'An outstanding invite already exists for that email — revoke it before reissuing.',
        });
      }
    }

    const token = this.randomToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);

    const { updated } = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.subCoachInvite.update({
        where: { id: invite.id },
        data: {
          token,
          email: nextEmail,
          name: input.name ?? invite.name,
          expires_at: expiresAt,
          // If we're reviving a revoked invite, clear the revocation
          // marker so it's pending again.
          revoked_at: null,
        },
      });

      await tx.teamAuditEvent.create({
        data: {
          head_coach_id: headCoachId,
          actor_user_id: headCoachId,
          target_client_id: null,
          event_kind: 'invite_sent_by_sub_coach',
          summary: `Invite to ${nextEmail} reissued (id=${invite.id}).`,
          metadata: {
            invite_id: invite.id,
            invite_kind: 'sub_coach_invite_reissue',
            previous_email: invite.email,
            email: nextEmail,
          } as Prisma.InputJsonValue,
        },
      });

      return { updated };
    });

    return {
      inviteId: updated.id,
      email: updated.email,
      inviteUrl: this.buildInviteUrl(updated.token),
      expires_at: updated.expires_at.toISOString(),
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
  ): Promise<{ ok: true; reassignedClientCount: number }> {
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

    // Cross-tenant guard: if the sub-coach works for other head coaches,
    // we cannot safely determine which clients belong to this head coach's
    // team (no TeamClientAssignment table yet). Archive the assignment only
    // and leave User.coach_id untouched to avoid stealing another head
    // coach's clients.
    const otherHeadCount = await this.prisma.teamSubCoachAssignment.count({
      where: {
        sub_coach_id: subCoachId,
        archived_at: null,
        head_coach_id: { not: headCoachId },
      },
    });

    if (otherHeadCount > 0) {
      // Cannot safely reassign clients — sub-coach serves multiple heads.
      // Archive the assignment only; do NOT touch any User.coach_id.
      await this.prisma.$transaction(async (tx) => {
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
            summary: `Sub-coach ${subCoach.name} revoked from your team (clients not reassigned — sub-coach serves multiple head coaches).`,
            metadata: {
              sub_coach_id: subCoachId,
              reassigned_client_count: 0,
              revoke_reason: payload.reason ?? null,
              skip_reason: 'multi_head_sub_coach',
            } as Prisma.InputJsonValue,
          },
        });
      });

      await this.team.refreshCounters(headCoachId);

      return { revoked: true, clients_reassigned: 0, reason: 'multi_head_sub_coach' } as unknown as { ok: true; reassignedClientCount: number };
    }

    // Safe to reassign — sub-coach only serves this head coach.
    // Find clients currently coached by this sub-coach to bounce back
    // to the head coach. Scoped to active, non-deleted students whose
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
        await tx.teamAuditEvent.createMany({
          data: reassignIds.map((clientId) => ({
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
          })),
        });
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

  private buildInviteUrl(token: string): string {
    const base = process.env.PUBLIC_INVITE_BASE_URL?.trim();
    if (!base) {
      throw new InternalServerErrorException('PUBLIC_INVITE_BASE_URL is not configured');
    }
    return `${base}/sub-coach/${token}`;
  }

  private randomToken(): string {
    return randomBytes(24).toString('base64url');
  }
}
