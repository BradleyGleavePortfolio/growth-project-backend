import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { TeamProfile, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { FeePolicyService } from '../connect/fees/fee-policy.service';
import { AuditService, AuditAction } from '../audit/audit.service';

// Phase 8 Team Profile service.
//
// Owns the head-coach-side team record: business name, public team code,
// member roster, and the cached capacity counters. Sub-coach invites and
// the head-coach <-> sub-coach assignment graph live in
// TeamModeService / SubCoachesService (this service does not write to
// TeamSubCoachAssignment directly — it reads it for the roster view).
//
// Tier-based soft caps for the per-coach max_clients counter surfaced on
// the team screen. These are NOT enforced server-side — they're a
// presentation hint so the head coach can plan capacity. The actual
// per-coach client cap belongs in a future plan-tier doc; until then we
// surface the same numbers the marketing site uses for each tier.
const TIER_MAX_CLIENTS: Record<string, number> = {
  growth: 30,
  pro: 150,
  enterprise: 500,
};
const DEFAULT_MAX_CLIENTS = 30;

export interface TeamMemberView {
  id: string;
  name: string;
  email: string;
  role: 'head_coach' | 'sub_coach';
  assigned_clients: number;
  max_clients: number;
  created_at: Date;
}

export interface TeamProfileView {
  id: string;
  business_name: string;
  team_code: string;
  client_capacity: number;
  clients_assigned: number;
  payouts_enabled: boolean;
}

@Injectable()
export class TeamService {
  private readonly logger = new Logger(TeamService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly feePolicy: FeePolicyService,
    private readonly audit: AuditService,
  ) {}

  // GET /coach/team — return the calling head coach's profile or 404.
  async getProfile(headCoachId: string): Promise<TeamProfileView> {
    const profile = await this.prisma.teamProfile.findUnique({
      where: { head_coach_id: headCoachId },
    });
    if (!profile) {
      // 404 is the explicit "not set up yet" signal the mobile client
      // collapses into a `not_configured` empty state.
      throw new NotFoundException({
        kind: 'team_profile_not_configured',
        message: 'No team profile yet. PUT /coach/team to create one.',
      });
    }
    // Recompute counters on read so the view is always honest even if
    // a write path forgot to bump them. This is bounded — one head
    // coach has O(sub-coaches + clients) rows.
    const { client_capacity, clients_assigned } =
      await this.computeCounters(headCoachId);
    if (
      profile.client_capacity !== client_capacity ||
      profile.clients_assigned !== clients_assigned
    ) {
      await this.prisma.teamProfile.update({
        where: { id: profile.id },
        data: { client_capacity, clients_assigned },
      });
    }
    const payoutsEnabled = await this.resolvePayoutsEnabled(headCoachId);
    return this.toView({ ...profile, client_capacity, clients_assigned }, payoutsEnabled);
  }

  // PUT /coach/team — upsert. Creates on first call; updates business_name
  // (and optionally team_code, with collision check) thereafter.
  async upsertProfile(
    headCoachId: string,
    input: { business_name: string; team_code?: string },
  ): Promise<TeamProfileView> {
    const trimmedName = input.business_name.trim();
    if (!trimmedName) {
      throw new BadRequestException({
        kind: 'invalid_business_name',
        message: 'business_name cannot be empty.',
      });
    }

    const existing = await this.prisma.teamProfile.findUnique({
      where: { head_coach_id: headCoachId },
    });
    const teamCode = input.team_code?.trim() || existing?.team_code || (await this.generateUniqueTeamCode());

    if (input.team_code && input.team_code !== existing?.team_code) {
      const collide = await this.prisma.teamProfile.findUnique({
        where: { team_code: teamCode },
      });
      if (collide && collide.head_coach_id !== headCoachId) {
        throw new ConflictException({
          kind: 'team_code_taken',
          message: 'That team code is already in use. Choose another.',
        });
      }
    }

    const { client_capacity, clients_assigned } =
      await this.computeCounters(headCoachId);
    const payoutsEnabled = await this.resolvePayoutsEnabled(headCoachId);

    const updated = await this.prisma.teamProfile.upsert({
      where: { head_coach_id: headCoachId },
      create: {
        head_coach_id: headCoachId,
        business_name: trimmedName,
        team_code: teamCode,
        client_capacity,
        clients_assigned,
        payouts_enabled: payoutsEnabled,
      },
      update: {
        business_name: trimmedName,
        team_code: teamCode,
        client_capacity,
        clients_assigned,
        payouts_enabled: payoutsEnabled,
      },
    });
    return this.toView(updated, payoutsEnabled);
  }

  // GET /coach/team/members — head coach + every non-archived sub-coach.
  async listMembers(headCoachId: string): Promise<TeamMemberView[]> {
    const head = await this.prisma.user.findUnique({
      where: { id: headCoachId },
      select: { id: true, name: true, email: true, created_at: true },
    });
    if (!head) throw new NotFoundException('Head coach not found');

    const assignments = await this.prisma.teamSubCoachAssignment.findMany({
      where: { head_coach_id: headCoachId, archived_at: null },
      orderBy: { created_at: 'desc' },
    });
    const subCoachIds = assignments.map((a) => a.sub_coach_id);

    // Bulk fetch sub-coach users + per-user assignment counts in two queries.
    const [subCoaches, perCoachAssigned, headTier, subTiers] = await Promise.all([
      subCoachIds.length === 0
        ? Promise.resolve([])
        : this.prisma.user.findMany({
            where: { id: { in: subCoachIds } },
            select: { id: true, name: true, email: true, created_at: true },
          }),
      this.prisma.user.groupBy({
        by: ['coach_id'],
        where: {
          role: 'student',
          deleted_at: null,
          coach_id: { in: [headCoachId, ...subCoachIds] },
        },
        _count: { _all: true },
      }),
      this.resolveTier(headCoachId),
      subCoachIds.length === 0
        ? Promise.resolve(new Map<string, string>())
        : this.bulkResolveTiers(subCoachIds),
    ]);
    const countByCoach = new Map<string, number>();
    for (const row of perCoachAssigned) {
      if (row.coach_id) countByCoach.set(row.coach_id, row._count._all);
    }

    const result: TeamMemberView[] = [
      {
        id: head.id,
        name: head.name,
        email: head.email,
        role: 'head_coach',
        assigned_clients: countByCoach.get(head.id) ?? 0,
        max_clients: TIER_MAX_CLIENTS[headTier] ?? DEFAULT_MAX_CLIENTS,
        created_at: head.created_at,
      },
      ...subCoaches.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: 'sub_coach' as const,
        assigned_clients: countByCoach.get(u.id) ?? 0,
        max_clients:
          TIER_MAX_CLIENTS[subTiers.get(u.id) ?? 'growth'] ?? DEFAULT_MAX_CLIENTS,
        created_at: u.created_at,
      })),
    ];
    return result;
  }

  // ── Revenue sharing toggle ──────────────────────────────────────────
  //
  // Controls whether a sub-coach's sales trigger the 5% head-coach split.
  // Implemented via the FeePolicy override row for the sub-coach:
  //   enabled=true  → head_coach_split_bps=null (default 500 bps = 5%)
  //   enabled=false → head_coach_split_bps=0 (no split)

  // GET /coach/team/members/:sub_coach_id/revenue-sharing
  async getRevenueSharing(
    headCoachId: string,
    subCoachId: string,
  ): Promise<{ revenue_sharing_enabled: boolean }> {
    await this.assertSubCoachRelationship(headCoachId, subCoachId);

    const override = await this.prisma.feePolicy.findUnique({
      where: { coach_id: subCoachId },
      select: { head_coach_split_bps: true },
    });

    // No row OR null bps → default 5% split is active → enabled
    const enabled =
      !override || override.head_coach_split_bps === null || override.head_coach_split_bps !== 0;
    return { revenue_sharing_enabled: enabled };
  }

  // PATCH /coach/team/members/:sub_coach_id/revenue-sharing
  //
  // SOC2-material: every call is audited. We read the previous split BEFORE
  // the update so the audit row captures both values. The read + update +
  // teamAuditEvent write are wrapped in a $transaction for atomicity; the
  // AuditService (SOC2 log) write fires after and is fire-and-forget — a
  // failure logs a warning but does not roll back the user-facing result.
  async setRevenueSharing(
    headCoachId: string,
    subCoachId: string,
    enabled: boolean,
    actorUserId?: string,
    actorRole?: string,
  ): Promise<{ revenue_sharing_enabled: boolean }> {
    await this.assertSubCoachRelationship(headCoachId, subCoachId);

    // Read the previous split before mutating so the audit metadata is accurate.
    const previousOverride = await this.prisma.feePolicy.findUnique({
      where: { coach_id: subCoachId },
      select: { head_coach_split_bps: true },
    });
    // Null or missing → default 5% (500 bps) is active.
    const previousBps: number | null = previousOverride?.head_coach_split_bps ?? null;
    // enabled=true  → null (falls back to default 5% = 500 bps)
    // enabled=false → 0 (no split)
    const newBps: number | null = enabled ? null : 0;

    // Atomic: update the FeePolicy override and write an in-app teamAuditEvent
    // in the same transaction so both land or neither does.
    await this.prisma.$transaction(async (tx) => {
      await tx.feePolicy.upsert({
        where: { coach_id: subCoachId },
        create: {
          coach_id: subCoachId,
          head_coach_split_bps: newBps,
        },
        update: {
          head_coach_split_bps: newBps,
        },
      });

      // In-app team feed event — matches the pattern used by other mutations
      // in sub-coach-invite.service.ts (e.g. sub_coach_assigned, sub_coach_removed).
      await tx.teamAuditEvent.create({
        data: {
          head_coach_id: headCoachId,
          actor_user_id: actorUserId ?? headCoachId,
          target_client_id: null,
          event_kind: 'revenue_sharing_changed',
          summary: `Revenue sharing for sub-coach ${subCoachId} set to ${enabled ? 'enabled (5%)' : 'disabled (0%)'}`,
          metadata: {
            sub_coach_id: subCoachId,
            previous_split_bps: previousBps,
            new_split_bps: newBps,
            enabled,
            actor_role: actorRole ?? null,
            source: 'team_controller',
          } as Prisma.InputJsonValue,
        },
      });
    });

    // SOC2 compliance log — fire-and-forget. AuditService already swallows
    // write failures and logs them; we match that contract here.
    void this.audit
      .write({
        action: AuditAction.TEAM_REVENUE_SHARING_UPDATED,
        actorId: actorUserId ?? headCoachId,
        actorRole: actorRole ?? null,
        targetUserId: subCoachId,
        targetType: 'sub_coach',
        tenantCoachId: headCoachId,
        metadata: {
          previous_split_bps: previousBps,
          new_split_bps: newBps,
          team_id: headCoachId,
          enabled,
        },
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`SOC2 audit write failed for revenue_sharing_changed: ${msg}`);
      });

    return { revenue_sharing_enabled: enabled };
  }

  private async assertSubCoachRelationship(
    headCoachId: string,
    subCoachId: string,
  ): Promise<void> {
    const assignment = await this.prisma.teamSubCoachAssignment.findFirst({
      where: {
        head_coach_id: headCoachId,
        sub_coach_id: subCoachId,
        archived_at: null,
      },
      select: { id: true },
    });
    if (!assignment) {
      throw new NotFoundException({
        error: 'SUB_COACH_NOT_FOUND',
        message: 'No active sub-coach assignment found for the given IDs',
      });
    }
  }

  // ── helpers ───────────────────────────────────────────────────────

  private async computeCounters(
    headCoachId: string,
  ): Promise<{ client_capacity: number; clients_assigned: number }> {
    const subCoachIds = (
      await this.prisma.teamSubCoachAssignment.findMany({
        where: { head_coach_id: headCoachId, archived_at: null },
        select: { sub_coach_id: true },
      })
    ).map((r) => r.sub_coach_id);

    const allCoachIds = [headCoachId, ...subCoachIds];
    const assigned = await this.prisma.user.count({
      where: {
        role: 'student',
        deleted_at: null,
        coach_id: { in: allCoachIds },
      },
    });

    const [headTier, subTiers] = await Promise.all([
      this.resolveTier(headCoachId),
      subCoachIds.length === 0
        ? Promise.resolve(new Map<string, string>())
        : this.bulkResolveTiers(subCoachIds),
    ]);
    let capacity = TIER_MAX_CLIENTS[headTier] ?? DEFAULT_MAX_CLIENTS;
    for (const id of subCoachIds) {
      capacity += TIER_MAX_CLIENTS[subTiers.get(id) ?? 'growth'] ?? DEFAULT_MAX_CLIENTS;
    }
    return { client_capacity: capacity, clients_assigned: assigned };
  }

  private async resolvePayoutsEnabled(headCoachId: string): Promise<boolean> {
    const acct = await this.prisma.connectAccount.findUnique({
      where: { coach_user_id: headCoachId },
      select: { payouts_enabled: true },
    });
    return !!acct?.payouts_enabled;
  }

  private async resolveTier(coachId: string): Promise<string> {
    const sub = await this.prisma.coachSubscription.findUnique({
      where: { coach_id: coachId },
      select: { stripe_price_id: true },
    });
    return this.priceIdToTier(sub?.stripe_price_id ?? null);
  }

  private async bulkResolveTiers(
    coachIds: string[],
  ): Promise<Map<string, string>> {
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

  private priceIdToTier(priceId: string | null): string {
    if (!priceId) return 'unknown';
    if (priceId === process.env.STRIPE_PRICE_GROWTH) return 'growth';
    if (priceId === process.env.STRIPE_PRICE_PRO) return 'pro';
    if (priceId === process.env.STRIPE_PRICE_ENTERPRISE) return 'enterprise';
    return 'unknown';
  }

  private toView(
    row: TeamProfile,
    payoutsEnabled: boolean,
  ): TeamProfileView {
    return {
      id: row.id,
      business_name: row.business_name,
      team_code: row.team_code,
      client_capacity: row.client_capacity,
      clients_assigned: row.clients_assigned,
      payouts_enabled: payoutsEnabled,
    };
  }

  // 8 bytes base32 produces a 13-char URL-safe code, prefixed for
  // readability ("GP-TEAM-XXXXXXXX"). Collision-checked up to a small
  // bounded retry; the alphabet space is far larger than any plausible
  // team count.
  private async generateUniqueTeamCode(): Promise<string> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = `GP-TEAM-${this.randomCode(8)}`;
      const exists = await this.prisma.teamProfile.findUnique({
        where: { team_code: code },
        select: { id: true },
      });
      if (!exists) return code;
    }
    throw new ConflictException({
      kind: 'team_code_generation_failed',
      message: 'Could not generate a unique team code after multiple attempts.',
    });
  }

  private randomCode(bytes: number): string {
    // Crockford-style base32 (no ambiguous chars) keeps the code
    // readable when handed out in person.
    const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
    const buf = randomBytes(bytes);
    let out = '';
    for (const b of buf) out += alphabet[b % alphabet.length];
    return out;
  }

  // Used by SubCoachesService.revoke to bump the cached counters when
  // a sub-coach is removed mid-flight; safe to call without a profile
  // row (no-op if absent).
  async refreshCounters(headCoachId: string): Promise<void> {
    const profile = await this.prisma.teamProfile.findUnique({
      where: { head_coach_id: headCoachId },
      select: { id: true },
    });
    if (!profile) return;
    const counters = await this.computeCounters(headCoachId);
    await this.prisma.teamProfile.update({
      where: { id: profile.id },
      data: counters,
    });
  }

  // Exposed for SubCoachesService so it can stamp the audit event
  // metadata without re-resolving.
  tierMaxClients(tier: string): number {
    return TIER_MAX_CLIENTS[tier] ?? DEFAULT_MAX_CLIENTS;
  }

  // Type-only helper kept here for cross-service use without leaking the
  // Prisma row shape.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private _typeAnchor(_x: Prisma.TeamProfileWhereInput): void {}
}
