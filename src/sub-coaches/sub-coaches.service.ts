import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { TeamService } from '../team/team.service';
import { SubCoachAnalyticsService } from './sub-coach-analytics.service';
import { SubCoachInviteService } from './sub-coach-invite.service';
import {
  DEFAULT_MAX_CLIENTS,
  SUB_COACH_HEAD_CAP,
  TIER_MAX_CLIENTS,
} from './sub-coaches.types';
import type {
  AcceptInviteResult,
  InvitePreviewView,
  InviteResult,
  ReassignResult,
  RevokeResult,
  SubCoachDetailView,
  SubCoachSummaryView,
} from './sub-coaches.types';

// Re-export the types/constants from the in-folder types module so older
// callers that imported them from sub-coaches.service.ts continue to
// resolve them at the same path. Pure module surface — no runtime
// behaviour change.
export type {
  AcceptInviteResult,
  InvitePreviewView,
  InviteResult,
  ReassignResult,
  RevokeResult,
  SubCoachDetailView,
  SubCoachSummaryView,
} from './sub-coaches.types';

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
//
// M9 refactor: invite lifecycle moved to SubCoachInviteService and
// engagement analytics moved to SubCoachAnalyticsService. This facade
// keeps the same public method signatures so the controllers do not
// change.
@Injectable()
export class SubCoachesService {
  private readonly logger = new Logger(SubCoachesService.name);

  // The new sub-services are wired through Nest DI in production. In
  // unit tests that hand-construct SubCoachesService with just
  // (prisma, team), they're @Optional() and we fall back to building a
  // local instance on the same prisma/team — preserves the pre-split
  // test surface and keeps test compatibility.
  private readonly invites: SubCoachInviteService;
  private readonly analyticsService: SubCoachAnalyticsService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly team: TeamService,
    @Optional() invites?: SubCoachInviteService,
    @Optional() analyticsService?: SubCoachAnalyticsService,
  ) {
    this.invites = invites ?? new SubCoachInviteService(prisma, team);
    this.analyticsService =
      analyticsService ?? new SubCoachAnalyticsService(prisma);
  }

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
    const tierMap = await this.analyticsService.bulkResolveTiers(ids);
    const assignedMap = await this.analyticsService.bulkAssignedCounts(ids);

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

    const tierMap = await this.analyticsService.bulkResolveTiers([subCoachId]);
    const assignedMap = await this.analyticsService.bulkAssignedCounts([
      subCoachId,
    ]);
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

  // GET /sub-coaches/:id/analytics — delegated to SubCoachAnalyticsService.
  async analytics(
    callerId: string,
    callerRole: string,
    subCoachId: string,
  ): Promise<SubCoachSummaryView['engagement']> {
    return this.analyticsService.analytics(callerId, callerRole, subCoachId);
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

  // ── invite lifecycle — delegated to SubCoachInviteService ──────────

  async invite(
    headCoachId: string,
    input: { email: string; name?: string | null; max_clients?: number | null },
  ): Promise<InviteResult> {
    return this.invites.invite(headCoachId, input);
  }

  async previewByToken(token: string): Promise<InvitePreviewView> {
    return this.invites.previewByToken(token);
  }

  async accept(
    callerId: string,
    callerRole: string,
    callerEmail: string,
    token: string,
  ): Promise<AcceptInviteResult> {
    return this.invites.accept(callerId, callerRole, callerEmail, token);
  }

  async reissueInvite(
    headCoachId: string,
    inviteId: string,
    input: { email?: string | null; name?: string | null } = {},
  ): Promise<InviteResult> {
    return this.invites.reissueInvite(headCoachId, inviteId, input);
  }

  async revoke(
    headCoachId: string,
    subCoachId: string,
    payload: { reason?: string },
  ): Promise<RevokeResult> {
    return this.invites.revoke(headCoachId, subCoachId, payload);
  }

  // ── helpers ───────────────────────────────────────────────────────

  async assertCanReadSubCoach(
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

  async teamCoachIds(headCoachId: string): Promise<Set<string>> {
    const rows = await this.prisma.teamSubCoachAssignment.findMany({
      where: { head_coach_id: headCoachId, archived_at: null },
      select: { sub_coach_id: true },
    });
    return new Set<string>([headCoachId, ...rows.map((r) => r.sub_coach_id)]);
  }

  toSummary(
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

  priceIdToTier(priceId: string | null): string {
    if (!priceId) return 'unknown';
    if (priceId === process.env.STRIPE_PRICE_GROWTH) return 'growth';
    if (priceId === process.env.STRIPE_PRICE_PRO) return 'pro';
    if (priceId === process.env.STRIPE_PRICE_ENTERPRISE) return 'enterprise';
    return 'unknown';
  }

  // Helper exposed for tests/admin tooling to assert the cap.
  static get headCap(): number {
    return SUB_COACH_HEAD_CAP;
  }
}
