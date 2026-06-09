import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CommunityCohort,
  CommunityMembershipRole,
  User,
} from '@prisma/client';
import { CommunityAccessService } from '../community-access.service';
import {
  CommunityCohortMembersRepository,
  MemberPageCursor,
  MembershipWithUser,
} from './community-cohort-members.repository';
import {
  AssignMemberDto,
  AssignableMemberRole,
  CohortMemberListResponse,
  CohortMemberListResponseSchema,
  CohortMemberResponse,
  CohortMemberResponseSchema,
  CohortMemberView,
  ListMembersQueryDto,
} from './community-cohort-members.dto';

const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;

const NOT_FOUND = {
  error: 'not_found',
  code: 'community.cohort.not_found',
} as const;

const FORBIDDEN = {
  error: 'forbidden',
  code: 'community.cohort.not_coach',
} as const;

const PROTECT_OWNER = {
  error: 'forbidden',
  code: 'community.cohort.cannot_remove_owner_coach',
} as const;

const USER_NOT_FOUND = {
  error: 'not_found',
  code: 'community.cohort.user_not_found',
} as const;

const BAD_TARGET = {
  error: 'bad_request',
  code: 'community.cohort.invalid_assign_target',
} as const;

// Map the API member role to the Prisma enum. `co_coach` → `assistant`; the
// owning coach's `coach` row is never written through these routes.
const API_TO_PRISMA_ROLE: Record<
  AssignableMemberRole,
  CommunityMembershipRole
> = {
  student: 'student',
  co_coach: 'assistant',
};

const PRISMA_TO_API_ROLE: Record<
  CommunityMembershipRole,
  'student' | 'co_coach' | 'coach'
> = {
  student: 'student',
  assistant: 'co_coach',
  coach: 'coach',
};

/**
 * Cohort membership administration.
 *
 * READ (GET roster) is allowed for the workspace coach/owner OR any active
 * member of the cohort; a coach sees full rows, a fellow member sees only the
 * sanitized roster (id + display name + role) — sensitive fields (status,
 * email, joined_at) are coach-only. WRITE (assign/remove) is coach-owner only.
 *
 * Cross-workspace and cross-cohort attacks are blocked by resolving the cohort
 * row first and authorising against ITS workspace_id (never the URL or body).
 */
@Injectable()
export class CommunityCohortMembersService {
  constructor(
    private readonly access: CommunityAccessService,
    private readonly repo: CommunityCohortMembersRepository,
  ) {}

  private parseLimit(limit: string | undefined): number {
    if (!limit) return DEFAULT_PAGE;
    const n = parseInt(limit, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE;
    return Math.min(n, MAX_PAGE);
  }

  /** Opaque keyset cursor: base64url("<iso>|<id>"). Null/garbage → no cursor. */
  private decodeCursor(raw: string | undefined): MemberPageCursor | null {
    if (!raw) return null;
    try {
      const decoded = Buffer.from(raw, 'base64url').toString('utf8');
      const sep = decoded.lastIndexOf('|');
      if (sep <= 0) return null;
      const iso = decoded.slice(0, sep);
      const id = decoded.slice(sep + 1);
      const createdAt = new Date(iso);
      if (Number.isNaN(createdAt.getTime()) || !id) return null;
      return { createdAt, id };
    } catch {
      return null;
    }
  }

  private encodeCursor(row: { created_at: Date; id: string }): string {
    return Buffer.from(
      `${row.created_at.toISOString()}|${row.id}`,
      'utf8',
    ).toString('base64url');
  }

  /** Full coach-facing member view (all fields). */
  private coachView(m: MembershipWithUser): CohortMemberView {
    return {
      id: m.id,
      user_id: m.user_id,
      display_name: m.user.name,
      role: PRISMA_TO_API_ROLE[m.role],
      status: m.status,
      email: m.user.email,
      joined_at: m.joined_at?.toISOString() ?? null,
    };
  }

  /** Sanitized roster view for a non-coach member (no PII/status). */
  private rosterView(m: MembershipWithUser): CohortMemberView {
    return {
      id: m.id,
      user_id: m.user_id,
      display_name: m.user.name,
      role: PRISMA_TO_API_ROLE[m.role],
      status: null,
      email: null,
      joined_at: null,
    };
  }

  private async resolveCohortOrThrow(
    cohortId: string,
  ): Promise<CommunityCohort> {
    const cohort = await this.access.findCohort(cohortId);
    if (!cohort) throw new NotFoundException(NOT_FOUND);
    return cohort;
  }

  private async isWorkspaceCoach(
    workspaceId: string,
    user: User,
  ): Promise<boolean> {
    return (
      user.role === 'owner' ||
      (await this.access.isWorkspaceCoach(workspaceId, user.id))
    );
  }

  private async assertWorkspaceCoach(
    workspaceId: string,
    user: User,
  ): Promise<void> {
    if (!(await this.isWorkspaceCoach(workspaceId, user))) {
      throw new ForbiddenException(FORBIDDEN);
    }
  }

  async list(
    user: User,
    cohortId: string,
    query: ListMembersQueryDto,
  ): Promise<CohortMemberListResponse> {
    const cohort = await this.resolveCohortOrThrow(cohortId);
    const isCoach = await this.isWorkspaceCoach(cohort.workspace_id, user);
    if (!isCoach) {
      // A non-coach may read the roster only if they are an ACTIVE member of
      // this exact cohort. A foreign cohort id resolves to 404 (non-leak).
      const membership = await this.access.membershipInCohort(
        cohort.id,
        user.id,
      );
      if (membership?.status !== 'active') {
        throw new NotFoundException(NOT_FOUND);
      }
    }

    const limit = this.parseLimit(query.limit);
    const roleFilter: CommunityMembershipRole | null =
      query.role === 'co_coach'
        ? 'assistant'
        : query.role === 'student'
          ? 'student'
          : query.role === 'coach'
            ? 'coach'
            : null;

    const rows = await this.repo.listMembers({
      cohortId: cohort.id,
      limit,
      cursor: this.decodeCursor(query.cursor),
      roleFilter,
    });
    const nextCursor =
      rows.length === limit ? this.encodeCursor(rows[rows.length - 1]) : null;

    return CohortMemberListResponseSchema.parse({
      members: rows.map((m) =>
        isCoach ? this.coachView(m) : this.rosterView(m),
      ),
      next_cursor: nextCursor,
    });
  }

  async assign(
    user: User,
    cohortId: string,
    body: AssignMemberDto,
  ): Promise<CohortMemberResponse> {
    const cohort = await this.resolveCohortOrThrow(cohortId);
    await this.assertWorkspaceCoach(cohort.workspace_id, user);

    // Exactly one of user_id / email must be supplied (XOR). The role/user are
    // always derived from the validated body — never an auth identity.
    const hasUserId = typeof body.user_id === 'string' && body.user_id !== '';
    const hasEmail = typeof body.email === 'string' && body.email !== '';
    if (hasUserId === hasEmail) {
      throw new BadRequestException(BAD_TARGET);
    }

    const prismaRole = API_TO_PRISMA_ROLE[body.role];

    if (hasUserId) {
      const target = await this.repo.findUserById(body.user_id as string);
      if (!target) throw new NotFoundException(USER_NOT_FOUND);
      // Direct assign of a known user → active immediately (idempotent: an
      // existing/removed row is revived to the requested role + active).
      const row = await this.repo.upsertMembership({
        workspaceId: cohort.workspace_id,
        cohortId: cohort.id,
        userId: target.id,
        role: prismaRole,
        status: 'active',
        joinedAt: new Date(),
      });
      return CohortMemberResponseSchema.parse({ member: this.coachView(row) });
    }

    // email path: if the email maps to an existing platform user, create a
    // pending invite (status='invited', no joined_at). If no user exists yet,
    // we cannot create a membership row (user_id is a required, FK-backed
    // column) — surface a clear 404 so the coach uses the existing invite-codes
    // onboarding flow first. (Decision documented in the PR body: cohort
    // membership reuses the CommunityMembership row with status='invited'
    // rather than the unrelated coach-roster invite-codes module.)
    const target = await this.repo.findUserByEmail(body.email as string);
    if (!target) throw new NotFoundException(USER_NOT_FOUND);
    const row = await this.repo.upsertMembership({
      workspaceId: cohort.workspace_id,
      cohortId: cohort.id,
      userId: target.id,
      role: prismaRole,
      status: 'invited',
      joinedAt: null,
    });
    return CohortMemberResponseSchema.parse({ member: this.coachView(row) });
  }

  async remove(
    user: User,
    cohortId: string,
    userId: string,
  ): Promise<CohortMemberResponse> {
    const cohort = await this.resolveCohortOrThrow(cohortId);
    await this.assertWorkspaceCoach(cohort.workspace_id, user);

    const membership = await this.repo.findMembership(cohort.id, userId);
    if (!membership) throw new NotFoundException(NOT_FOUND);

    // Never strip the owning coach's own membership (the `coach` role row).
    // Removing it would orphan the cohort. 403 regardless of who asks.
    if (membership.role === 'coach') {
      throw new ForbiddenException(PROTECT_OWNER);
    }

    // Idempotent: already removed is a no-op success.
    if (membership.status === 'removed') {
      return CohortMemberResponseSchema.parse({
        member: this.coachView(membership),
      });
    }
    const removed = await this.repo.removeMembership(cohort.id, userId);
    return CohortMemberResponseSchema.parse({
      member: this.coachView(removed),
    });
  }
}
