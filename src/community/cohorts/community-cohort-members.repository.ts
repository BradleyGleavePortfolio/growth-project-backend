import { Injectable } from '@nestjs/common';
import type {
  CommunityMembership,
  CommunityMembershipRole,
  User,
} from '@prisma/client';
import { PrismaService } from '../../prisma.service';

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

export interface MemberPageCursor {
  createdAt: Date;
  id: string;
}

@Injectable()
export class CommunityCohortMembersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Roster page for a cohort, ordered (created_at ASC, id ASC) for a stable
   * keyset cursor. `roleFilter` narrows to a single Prisma role. Removed rows
   * are excluded so the roster reflects the live membership. Fetches `limit`
   * rows; the caller derives next_cursor when a full page comes back.
   */
  async listMembers(params: {
    cohortId: string;
    limit: number;
    cursor: MemberPageCursor | null;
    roleFilter: CommunityMembershipRole | null;
  }): Promise<MembershipWithUser[]> {
    const { cohortId, limit, cursor, roleFilter } = params;
    return this.prisma.communityMembership.findMany({
      where: {
        cohort_id: cohortId,
        status: { not: 'removed' },
        ...(roleFilter ? { role: roleFilter } : {}),
        ...(cursor
          ? {
              OR: [
                { created_at: { gt: cursor.createdAt } },
                {
                  created_at: cursor.createdAt,
                  id: { gt: cursor.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      take: limit,
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    });
  }

  /** A single membership in a cohort (any status) joined to its user, or null. */
  async findMembership(
    cohortId: string,
    userId: string,
  ): Promise<MembershipWithUser | null> {
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
  ): Promise<Pick<User, 'id' | 'name' | 'email'> | null> {
    return this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true, name: true, email: true },
    });
  }

  async findUserById(
    userId: string,
  ): Promise<Pick<User, 'id' | 'name' | 'email'> | null> {
    return this.prisma.user.findUnique({
      where: { id: userId },
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
  async removeMembership(
    cohortId: string,
    userId: string,
  ): Promise<MembershipWithUser> {
    return this.prisma.communityMembership.update({
      where: { cohort_id_user_id: { cohort_id: cohortId, user_id: userId } },
      data: { status: 'removed', removed_at: new Date() },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  }
}
