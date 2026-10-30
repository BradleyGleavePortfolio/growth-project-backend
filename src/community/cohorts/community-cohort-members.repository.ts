import { Injectable } from '@nestjs/common';
import type {
  CommunityCohort,
  CommunityMembership,
  CommunityMembershipRole,
  Prisma,
  User,
} from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { liftWorkspaceBan } from '../community-ban';
import { membersNow } from '../community-space-access';
import { liveAccessWhere } from '../../checkout/dunning-v2/dunning-grace';

/**
 * Data access for cohort membership administration (list / assign / remove).
 *
 * Tenant scoping follows the v1-2 doctrine: the app connects as service_role
 * (BYPASSRLS), so isolation is enforced at the SERVICE layer
 * (CommunityAccessService). Postgres RLS (community_memberships_coach_all +
 * community_memberships_self_or_shared_cohort_select) remains as
 * defence-in-depth. Methods here take an already-authorised cohort id.
 */
export type MembershipWithUser = CommunityMembership & {
  user: Pick<User, 'id' | 'name' | 'email'>;
};

/** C6-BVIS: one person a space's roster lists, with their row there if they hold one. */
export type SpacePerson = Pick<User, 'id' | 'name' | 'email'> & {
  row: Pick<CommunityMembership, 'id' | 'role' | 'status' | 'joined_at'> | null;
};

/**
 * B-AUTHZ-1: who a coach may add to a cohort. A target qualifies only when it
 * is a live client of the workspace coach (`coach_id` match, not deleted) or
 * already on the workspace's team (an active co-coach row; C6-BVIS).
 */
export interface AssignTargetScope {
  workspaceId: string;
  coachId: string;
}

function assignTargetFilter(scope: AssignTargetScope | null): Prisma.UserWhereInput {
  if (!scope) return {};
  return {
    deleted_at: null,
    OR: [
      { coach_id: scope.coachId },
      {
        community_memberships: {
          some: { workspace_id: scope.workspaceId, status: 'active', role: { not: 'student' } },
        },
      },
    ],
  };
}

@Injectable()
export class CommunityCohortMembersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** C6-BVIS: everyone the rule lists in the space (a client of a clients or package space needs no
   * row), each with their row here if any, by user id for a stable cursor. FR-1168R2 B1: the people of the
   * space now (membersNow, the rule member_count uses), so a person who left is not listed until they join again. */
  async people(cohort: Pick<CommunityCohort, 'id' | 'workspace_id'>): Promise<SpacePerson[]> {
    const ids = await membersNow(this.prisma, cohort, true);
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        email: true,
        community_memberships: {
          where: { cohort_id: cohort.id },
          select: { id: true, role: true, status: true, joined_at: true },
        },
      },
    });
    return users
      .map(({ community_memberships: [row], ...u }) => ({ ...u, row: row ?? null }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** C6-BVIS: why each client is in a package space, the live purchase of a linked package that
   * runs longest (no end first), as app.community_can_access counts it. */
  async packageAccess(
    cohortId: string,
    coachId: string,
    ids: string[],
  ): Promise<Map<string, { package_id: string; until: Date | null }>> {
    const live = await this.prisma.clientPurchase.findMany({
      where: {
        client_user_id: { in: ids },
        coach_user_id: coachId,
        // FR-1190 (LS-1190 B1): the live rule, as app.community_can_access (20270502010000) counts it.
        ...liveAccessWhere(),
        package: { community_spaces: { some: { cohort_id: cohortId } } },
      },
      select: { client_user_id: true, package_id: true, access_expires_at: true },
    });
    const best = new Map<string, { package_id: string; until: Date | null }>();
    for (const p of live) {
      const had = best.get(p.client_user_id);
      if (!had || (had.until && (!p.access_expires_at || p.access_expires_at > had.until))) {
        best.set(p.client_user_id, { package_id: p.package_id, until: p.access_expires_at });
      }
    }
    return best;
  }

  async findMembership(cohortId: string, userId: string): Promise<MembershipWithUser | null> {
    return this.prisma.communityMembership.findUnique({
      where: { cohort_id_user_id: { cohort_id: cohortId, user_id: userId } },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  }

  /**
   * Resolve a user by email, case-insensitively (R1-P2-002).
   *
   * The DTO lowercases the lookup, but User.email is a plain unique String with
   * no DB-level case-folding and is not normalized at write time (auth compares
   * with .toLowerCase() on both sides). A mixed-case stored email (e.g.
   * `Jane@Example.com`) would miss an exact-match findUnique and 404 a real
   * user. `mode: 'insensitive'` (Postgres ILIKE-equivalent) matches regardless
   * of casing; findFirst because an insensitive predicate is not a unique key.
   */
  async findUserByEmail(
    email: string,
    scope: AssignTargetScope | null = null,
  ): Promise<Pick<User, 'id' | 'name' | 'email'> | null> {
    return this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, ...assignTargetFilter(scope) },
      select: { id: true, name: true, email: true },
    });
  }

  /**
   * Resolve an assign target by id. With a scope, a user outside it resolves
   * to null exactly like an unknown id (no existence leak).
   */
  async findUserById(
    userId: string,
    scope: AssignTargetScope | null = null,
  ): Promise<Pick<User, 'id' | 'name' | 'email'> | null> {
    return this.prisma.user.findFirst({
      where: { id: userId, ...assignTargetFilter(scope) },
      select: { id: true, name: true, email: true },
    });
  }

  /**
   * Idempotent assign: create the membership, or revive/re-role an existing
   * row (including a previously-removed one). `status` is 'active' for a direct
   * user assign and 'invited' for an email invite to a known user that has not
   * yet joined; the service passes the resolved values. Uses upsert keyed on
   * the (cohort_id, user_id) unique so re-assign is a no-op-shaped update.
   */
  /**
   * B-610-2: explicit reinstatement. The workspace coach adding a member to a
   * cohort lifts that member's durable community ban in the workspace.
   */
  async liftWorkspaceBan(
    workspaceId: string,
    userId: string,
    liftedById: string,
  ): Promise<boolean> {
    return liftWorkspaceBan(this.prisma, { workspaceId, userId, liftedById, at: new Date() });
  }

  async upsertMembership(params: {
    workspaceId: string;
    cohortId: string;
    userId: string;
    role: CommunityMembershipRole;
    status: 'invited' | 'active';
    joinedAt: Date | null;
  }): Promise<MembershipWithUser> {
    const { workspaceId, cohortId, userId, role, status, joinedAt } = params;
    return this.prisma.communityMembership.upsert({
      where: { cohort_id_user_id: { cohort_id: cohortId, user_id: userId } },
      create: {
        workspace_id: workspaceId,
        cohort_id: cohortId,
        user_id: userId,
        role,
        status,
        joined_at: joinedAt,
      },
      update: {
        role,
        status,
        removed_at: null,
        ...(joinedAt ? { joined_at: joinedAt } : {}),
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  }

  /** Soft-remove: status='removed' + removed_at, preserving history. */
  async removeMembership(cohortId: string, userId: string): Promise<MembershipWithUser> {
    return this.prisma.communityMembership.update({
      where: { cohort_id_user_id: { cohort_id: cohortId, user_id: userId } },
      data: { status: 'removed', removed_at: new Date() },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  }
}
