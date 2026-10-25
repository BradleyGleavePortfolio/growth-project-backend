import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CommunityCohort,
  CommunityMembershipRole,
  CommunitySpaceVisibility,
  User,
} from '@prisma/client';
import { CommunityAccessService } from '../community-access.service';
import { CommunitySafetyService } from '../safety/community-safety.service';
import { FULL_NAME_VISIBILITY, memberName } from '../member-display-name';
import {
  AssignTargetScope,
  CommunityCohortMembersRepository,
  MembershipWithUser,
  SpacePerson,
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
const API_TO_PRISMA_ROLE: Record<AssignableMemberRole, CommunityMembershipRole> = {
  student: 'student',
  co_coach: 'assistant',
};

const PRISMA_TO_API_ROLE: Record<CommunityMembershipRole, 'student' | 'co_coach' | 'coach'> = {
  student: 'student',
  assistant: 'co_coach',
  coach: 'coach',
};

// C6-BVIS: why a client is in a space, by its visibility (k04 "Who has access, and why").
const ACCESS_REASON: Record<CommunitySpaceVisibility, 'client' | 'package' | 'member'> = {
  public: 'member',
  clients: 'client',
  package: 'package',
  members: 'member',
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
    private readonly safety: CommunitySafetyService,
  ) {}

  private parseLimit(limit: string | undefined): number {
    if (!limit) return DEFAULT_PAGE;
    const n = parseInt(limit, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE;
    return Math.min(n, MAX_PAGE);
  }

  /** Opaque keyset cursor: base64url(user id), the last person of the page. */
  private decodeCursor(raw: string | undefined): string {
    return raw ? Buffer.from(raw, 'base64url').toString('utf8') : '';
  }

  private encodeCursor(personId: string): string {
    return Buffer.from(personId, 'utf8').toString('base64url');
  }

  /** A row the routes below return, as a roster person. */
  private person(m: MembershipWithUser): SpacePerson {
    return { id: m.user_id, name: m.user.name, email: m.user.email, row: m };
  }

  /**
   * The coach sees every field and, on the roster, why the person is in
   * (C6-BVIS; `access` is null where it is not worked out). Anyone else sees
   * the name and role only (client privacy): the first name, or the full name
   * where `fullName` says so (#C6-MEMBER-NAMES).
   */
  private memberView(
    p: SpacePerson,
    coachView: boolean,
    role: CohortMemberView['role'],
    access: CohortMemberView['access'] = null,
    fullName = false,
  ): CohortMemberView {
    return {
      id: p.row?.id ?? null,
      user_id: p.id,
      display_name: coachView ? p.name : memberName(p.name, fullName),
      role,
      status: coachView ? (p.row?.status ?? 'active') : null,
      email: coachView ? p.email : null,
      joined_at: coachView ? (p.row?.joined_at?.toISOString() ?? null) : null,
      access: coachView ? access : null,
    };
  }

  private coachView(m: MembershipWithUser): CohortMemberView {
    return this.memberView(this.person(m), true, PRISMA_TO_API_ROLE[m.role]);
  }

  private async resolveCohortOrThrow(cohortId: string): Promise<CommunityCohort> {
    const cohort = await this.access.findCohort(cohortId);
    if (!cohort) throw new NotFoundException(NOT_FOUND);
    return cohort;
  }

  private async isWorkspaceCoach(workspaceId: string, user: User): Promise<boolean> {
    return user.role === 'owner' || (await this.access.isWorkspaceCoach(workspaceId, user.id));
  }

  private async assertWorkspaceCoach(workspaceId: string, user: User): Promise<void> {
    if (!(await this.isWorkspaceCoach(workspaceId, user))) {
      throw new ForbiddenException(FORBIDDEN);
    }
  }

  /**
   * Who a cohort assignment may target. `null` (no restriction) only for the
   * platform owner; every coach is limited to the workspace coach's live
   * roster plus the workspace's team (active co-coach rows; C6-BVIS).
   */
  private async assignScope(workspaceId: string, user: User): Promise<AssignTargetScope | null> {
    if (user.role === 'owner') return null;
    const workspace = await this.access.findWorkspace(workspaceId);
    if (!workspace) throw new NotFoundException(NOT_FOUND);
    return { workspaceId: workspace.id, coachId: workspace.coach_id };
  }

  async list(
    user: User,
    cohortId: string,
    query: ListMembersQueryDto,
  ): Promise<CohortMemberListResponse> {
    const cohort = await this.resolveCohortOrThrow(cohortId);
    const isCoach = await this.isWorkspaceCoach(cohort.workspace_id, user);
    // C6-BVIS: a non-coach reads the roster while the rule lets them into the
    // space, row or not; anyone else gets 404, like a foreign id (non-leak).
    if (!isCoach && !(await this.access.canAccessCohort(cohort, user))) {
      throw new NotFoundException(NOT_FOUND);
    }

    const coachId = (await this.access.findWorkspace(cohort.workspace_id))?.coach_id;
    const roleOf = (p: SpacePerson) =>
      p.row ? PRISMA_TO_API_ROLE[p.row.role] : p.id === coachId ? 'coach' : 'student';
    const after = this.decodeCursor(query.cursor);
    const limit = this.parseLimit(query.limit);
    const page = (await this.repo.people(cohort))
      .filter((p) => p.id > after && (!query.role || roleOf(p) === query.role))
      .slice(0, limit);

    // Two-way block on the member roster: a member does not see people they
    // blocked or who blocked them. The coach's management view stays complete
    // (the coach administers every membership; moderation and ban act on it).
    const visible = isCoach ? page : await this.safety.filterBlocked(user.id, page, (p) => p.id);
    const bought =
      isCoach && coachId && cohort.visibility === 'package'
        ? await this.repo.packageAccess(cohort.id, coachId, page.map((p) => p.id))
        : new Map<string, { package_id: string; until: Date | null }>();
    const why = (p: SpacePerson, role: CohortMemberView['role']): CohortMemberView['access'] => {
      const reason =
        p.id === coachId ? 'coach' : role !== 'student' ? 'team' : ACCESS_REASON[cohort.visibility];
      const sale = reason === 'package' ? bought.get(p.id) : undefined;
      return { reason, package_id: sale?.package_id ?? null, until: sale?.until?.toISOString() ?? null };
    };

    // #C6-MEMBER-NAMES: in a space open to all of the coach's clients, the people in it see each
    // other's full names; every other space keeps first names. Only readers the rule lets in get here.
    const fullNames = cohort.visibility === FULL_NAME_VISIBILITY;
    return CohortMemberListResponseSchema.parse({
      members: visible.map((p) => this.memberView(p, isCoach, roleOf(p), why(p, roleOf(p)), fullNames)),
      next_cursor: page.length === limit ? this.encodeCursor(page[page.length - 1].id) : null,
    });
  }

  async assign(user: User, cohortId: string, body: AssignMemberDto): Promise<CohortMemberResponse> {
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

    // B-AUTHZ-1: the target must already belong to this coach's world (their
    // live client roster, or the workspace's team; C6-BVIS) before any
    // lookup data is returned or any membership/ban row changes. A foreign or
    // unknown target gets the same coded 404, so the endpoint never confirms
    // that another coach's client exists. The platform owner may override.
    const scope = await this.assignScope(cohort.workspace_id, user);

    // A coach adds a person by id or by email; both are the same act. There is
    // no accept step anywhere (the phone has none, and an invited client could
    // not even see the space), so the person is in at once, like adding someone
    // to a Slack channel. The rule still decides access: a client who later
    // moves to another coach loses a chosen-members space with their row.
    const target = hasUserId
      ? await this.repo.findUserById(body.user_id as string, scope)
      : await this.repo.findUserByEmail(body.email as string, scope);
    if (!target) throw new NotFoundException(USER_NOT_FOUND);
    // Idempotent: an existing or removed row is revived to the requested role
    // and active. This is the explicit reinstatement path: it lifts a durable
    // community ban in this workspace (B-610-2) so access and membership agree.
    await this.repo.liftWorkspaceBan(cohort.workspace_id, target.id, user.id);
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

  async remove(user: User, cohortId: string, userId: string): Promise<CohortMemberResponse> {
    const cohort = await this.resolveCohortOrThrow(cohortId);
    await this.assertWorkspaceCoach(cohort.workspace_id, user);

    const membership = await this.repo.findMembership(cohort.id, userId);
    if (!membership) throw new NotFoundException(NOT_FOUND);
    // C6-BVIS: an open row the rule does not list answers like no row, before any name or email.
    if (
      membership.status !== 'removed' &&
      (await this.access.peopleInSpace(cohort.id, [membership], (m) => m.user_id)).length === 0
    ) {
      throw new NotFoundException(NOT_FOUND);
    }

    // Never strip the owning coach's own membership (the `coach` role row).
    // Removing it would orphan the cohort. 403 regardless of who asks.
    if (membership.role === 'coach') {
      throw new ForbiddenException(PROTECT_OWNER);
    }

    // Idempotent: already removed is a no-op success. Removing only ever
    // updates an existing row; it never creates or revives one (a person the
    // rule lets in without a row has nothing to remove: 404 above).
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
