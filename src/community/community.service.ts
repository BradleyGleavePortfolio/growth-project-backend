import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { CommunityMembership, CommunityWorkspace, User } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { CommunityRepository } from './community.repository';
import { CommunitySafetyService } from './safety/community-safety.service';
import { memberFirstName } from './member-display-name';
import {
  WIN_NOT_FOUND,
  WIN_POSTING_REMOVED,
  removedFromWorkspace,
  winModerationWorkspaceId,
} from './community-wins.policy';
import { resolveCommunityFlag } from './community-feature-flag.guard';
import {
  CommunityMeResponse,
  CommunityMeResponseSchema,
  CommunityNotifyLevel,
} from './dto/community-me.dto';
import { CommunityTodayResponse, CommunityTodayResponseSchema } from './dto/community-today.dto';
import {
  CommunityWorkspaceResponse,
  CommunityWorkspaceResponseSchema,
} from './dto/community-workspace.dto';
import {
  CommunityCohortListResponse,
  CommunityCohortListResponseSchema,
  CommunityCohortResponse,
  CommunityCohortResponseSchema,
} from './dto/community-cohort.dto';

const FORBIDDEN_WORKSPACE = {
  error: 'forbidden',
  code: 'community.workspace.no_access',
} as const;
const FORBIDDEN_COHORT = {
  error: 'forbidden',
  code: 'community.cohort.no_access',
} as const;

/**
 * Community v1-2 foundation service.
 *
 * Two intentional, gap-G19-tracked zeros live in getMe(): dm_messages and
 * mentions are always 0 in v1-2 because the per-DM read-marker table
 * (community_dm_state) and the message-mention feature both land in v1-3.
 * See the TODO(v1-3) annotations at their use sites.
 *
 * The platform "owner" role is User.role === 'owner'. Community membership rows
 * use the schema enum coach|assistant|student (no owner); the API surfaces the
 * caller's *effective* role: owner > coach > student.
 */
@Injectable()
export class CommunityService {
  constructor(
    private prisma: PrismaService,
    private readonly repo: CommunityRepository,
    private readonly safety: CommunitySafetyService,
  ) {}

  // ── Effective-role + tri-state helpers ────────────────────────────────────

  /**
   * Caller's effective role in the API's vocabulary (gap G14): the schema's
   * `student` becomes the UI-facing `client`; `coach` and `owner` pass through.
   */
  effectiveRole(user: Pick<User, 'role'>): 'client' | 'coach' | 'owner' {
    if (user.role === 'owner') return 'owner';
    if (user.role === 'coach') return 'coach';
    return 'client';
  }

  /** Internal scoping role used to branch repository queries. */
  private scopingRole(user: Pick<User, 'role'>): 'student' | 'coach' | 'owner' {
    if (user.role === 'owner') return 'owner';
    if (user.role === 'coach') return 'coach';
    return 'student';
  }

  /**
   * G3 — dm_enabled tri-state contract. A membership's dm_enabled is nullable:
   * null means "inherit the workspace default", an explicit boolean overrides.
   */
  resolveDmEnabled(
    membership: Pick<CommunityMembership, 'dm_enabled'> | null,
    workspace: Pick<CommunityWorkspace, 'dm_enabled_default'> | null,
  ): boolean {
    if (membership && membership.dm_enabled !== null) {
      return membership.dm_enabled;
    }
    return workspace?.dm_enabled_default ?? false;
  }

  /** Map the free-form notify_level column onto the response enum. */
  normalizeNotifyLevel(value: string | null | undefined): CommunityNotifyLevel {
    return value === 'live' || value === 'quiet' || value === 'digest' ? value : 'digest';
  }

  private flagState(userId: string): 'enabled' | 'disabled' {
    return resolveCommunityFlag(userId);
  }

  // ── GET /community/me ──────────────────────────────────────────────────────

  async getMe(user: User): Promise<CommunityMeResponse> {
    const flag = this.flagState(user.id);
    const role = this.effectiveRole(user);
    const scope = this.scopingRole(user);

    const flags = {
      community_api: flag === 'enabled',
      community_dm: process.env.FEATURE_COMMUNITY_DM === 'true',
      community_realtime: process.env.FEATURE_COMMUNITY_REALTIME === 'true',
      community_push: process.env.FEATURE_COMMUNITY_PUSH === 'true',
      community_telemetry: process.env.FEATURE_COMMUNITY_TELEMETRY === 'true',
    };

    if (flag === 'disabled') {
      return CommunityMeResponseSchema.parse({
        feature_flag_state: 'disabled',
        workspace_id: null,
        membership: null,
        unread: { cohort_messages: 0, dm_messages: 0, mentions: 0 },
        flags,
      });
    }

    let membership = await this.repo.findActiveMembershipForUser(user.id);
    let workspace: CommunityWorkspace | null = null;

    if (scope === 'coach') {
      // Coaches do not ride in community_memberships the way students do; their
      // relationship to a workspace is ownership. Surface the owned workspace
      // and a synthetic coach membership view (no row) when one exists.
      workspace = await this.repo.findWorkspaceOwnedByCoach(user.id);
    } else if (scope === 'student' && !membership) {
      // Bootstrap (readiness §4 item 4): first touch creates the student's
      // membership in their coach's default cohort. Idempotent via upsert.
      if (user.coach_id) {
        const cohort = await this.repo.findDefaultCohortForCoach(user.coach_id);
        if (cohort) {
          membership = await this.repo.bootstrapStudentMembership({
            workspaceId: cohort.workspace_id,
            cohortId: cohort.id,
            userId: user.id,
          });
        }
      }
    }

    if (membership && !workspace) {
      workspace = await this.repo.findWorkspaceById(membership.workspace_id);
    }

    let unreadCohort = 0;
    if (membership) {
      const cohortIds = await this.repo.findActiveCohortIdsForUser(user.id);
      unreadCohort = await this.repo.countUnreadCohortMessages({
        userId: user.id,
        cohortIds,
        since: membership.last_read_message_at,
      });
    }

    const membershipView = membership
      ? {
          id: membership.id,
          role,
          notify_level: this.normalizeNotifyLevel(membership.notify_level),
          dm_enabled_effective: this.resolveDmEnabled(membership, workspace),
          last_read_message_at: membership.last_read_message_at?.toISOString() ?? null,
          joined_at: (membership.joined_at ?? membership.created_at).toISOString(),
        }
      : null;

    return CommunityMeResponseSchema.parse({
      feature_flag_state: 'enabled',
      workspace_id: workspace?.id ?? null,
      membership: membershipView,
      unread: {
        cohort_messages: unreadCohort,
        // TODO(v1-3): wire to community_dm_state read markers — currently zero by design
        dm_messages: 0,
        // TODO(v1-3): mentions are a v1-3 message feature — currently zero by design
        mentions: 0,
      },
      flags,
    });
  }

  // ── GET /community/today ────────────────────────────────────────────────────

  async getToday(user: User): Promise<CommunityTodayResponse> {
    const flag = this.flagState(user.id);
    if (flag === 'disabled') {
      return CommunityTodayResponseSchema.parse({
        feature_flag_state: 'disabled',
        cohort: null,
        event: null,
        pinned_post: null,
        challenge: null,
        empty_reason: null,
      });
    }

    const scope = this.scopingRole(user);
    const membership = await this.repo.findActiveMembershipForUser(user.id);
    const workspace =
      scope === 'coach'
        ? await this.repo.findWorkspaceOwnedByCoach(user.id)
        : membership
          ? await this.repo.findWorkspaceById(membership.workspace_id)
          : null;

    if (!workspace) {
      return CommunityTodayResponseSchema.parse({
        feature_flag_state: 'enabled',
        cohort: null,
        event: null,
        pinned_post: null,
        challenge: null,
        empty_reason: 'no_membership',
      });
    }

    const cohort =
      membership && membership.cohort_id
        ? await this.repo.findCohortById(membership.cohort_id)
        : null;

    const {
      event: eventRow,
      pinnedPost: pinnedRow,
      challenge: challengeRow,
    } = await this.repo.findTodayContent(workspace.id, new Date());
    // Two-way block: Today never surfaces a pinned post, event or challenge
    // authored by someone in a block relation with the caller (the Hall,
    // events and challenges lists hide them too). One block lookup.
    const hidden =
      pinnedRow || eventRow || challengeRow ? await this.safety.hiddenFromViewer(user.id) : null;
    const visibleTo = (authorId: string | null | undefined) =>
      !hidden || !authorId || !hidden.has(authorId);
    const pinnedPost = pinnedRow && visibleTo(pinnedRow.author_id) ? pinnedRow : null;
    const event = eventRow && visibleTo(eventRow.created_by_id) ? eventRow : null;
    const challenge = challengeRow && visibleTo(challengeRow.created_by_id) ? challengeRow : null;

    const cohortCard = cohort
      ? {
          id: cohort.id,
          name: cohort.name,
          member_count: await this.repo.cohortMemberCount(cohort.id),
        }
      : null;

    const anyContent =
      cohortCard !== null || event !== null || pinnedPost !== null || challenge !== null;

    return CommunityTodayResponseSchema.parse({
      feature_flag_state: 'enabled',
      cohort: cohortCard,
      event: event
        ? {
            id: event.id,
            title: event.title,
            starts_at: event.starts_at.toISOString(),
            live_url: event.live_url ?? null,
          }
        : null,
      pinned_post: pinnedPost
        ? {
            id: pinnedPost.id,
            title: pinnedPost.title ?? '',
            author_user_id: pinnedPost.author_id,
          }
        : null,
      challenge:
        challenge && challenge.ends_at
          ? {
              id: challenge.id,
              title: challenge.title,
              ends_at: challenge.ends_at.toISOString(),
            }
          : null,
      empty_reason: anyContent ? null : 'no_today_content',
    });
  }

  // ── GET /community/workspaces/:id ─────────────────────────────────────────

  async getWorkspace(user: User, workspaceId: string): Promise<CommunityWorkspaceResponse> {
    const role = this.effectiveRole(user);
    const workspace = await this.repo.findWorkspaceById(workspaceId);
    if (!workspace) {
      throw new NotFoundException({
        error: 'not_found',
        code: 'community.workspace.not_found',
      });
    }

    const isOwner = workspace.coach_id === user.id;
    const isMember =
      role === 'owner' || (await this.repo.userHasMembershipInWorkspace(workspaceId, user.id));

    if (!isOwner && !isMember) {
      throw new ForbiddenException(FORBIDDEN_WORKSPACE);
    }

    return CommunityWorkspaceResponseSchema.parse({
      feature_flag_state: 'enabled',
      id: workspace.id,
      name: workspace.name,
      owner_coach_user_id: workspace.coach_id,
      dm_enabled_default: workspace.dm_enabled_default,
      created_at: workspace.created_at.toISOString(),
      access: isOwner ? 'owner' : 'member',
    });
  }

  // ── GET /community/cohorts ────────────────────────────────────────────────

  async getCohorts(user: User): Promise<CommunityCohortListResponse> {
    const role = this.effectiveRole(user);
    const cohorts = await this.repo.findCohortsForUser({
      userId: user.id,
      role: this.scopingRole(user),
    });

    const summaries = await Promise.all(
      cohorts.map(async (c) => ({
        id: c.id,
        workspace_id: c.workspace_id,
        name: c.name,
        is_default: await this.repo.isDefaultCohort(c),
        member_count: await this.repo.cohortMemberCount(c.id),
        my_role: role,
      })),
    );

    return CommunityCohortListResponseSchema.parse({
      feature_flag_state: 'enabled',
      cohorts: summaries,
    });
  }

  // ── GET /community/cohorts/:id ────────────────────────────────────────────

  async getCohort(user: User, cohortId: string): Promise<CommunityCohortResponse> {
    const role = this.effectiveRole(user);
    const cohort = await this.repo.findCohortById(cohortId);
    if (!cohort) {
      throw new NotFoundException({
        error: 'not_found',
        code: 'community.cohort.not_found',
      });
    }

    const workspace = await this.repo.findWorkspaceById(cohort.workspace_id);
    const isOwner = workspace?.coach_id === user.id;
    const membership = await this.repo.findMembershipInCohort(cohortId, user.id);
    const canRead = role === 'owner' || isOwner || membership?.status === 'active';

    if (!canRead) {
      throw new ForbiddenException(FORBIDDEN_COHORT);
    }

    return CommunityCohortResponseSchema.parse({
      feature_flag_state: 'enabled',
      id: cohort.id,
      workspace_id: cohort.workspace_id,
      name: cohort.name,
      is_default: await this.repo.isDefaultCohort(cohort),
      member_count: await this.repo.cohortMemberCount(cohort.id),
      created_at: cohort.created_at.toISOString(),
      my_membership:
        membership && membership.status === 'active'
          ? {
              id: membership.id,
              notify_level: this.normalizeNotifyLevel(membership.notify_level),
              last_read_message_at: membership.last_read_message_at?.toISOString() ?? null,
              joined_at: (membership.joined_at ?? membership.created_at).toISOString(),
            }
          : null,
    });
  }

  // ── Legacy endpoints (preserved from v0; see community.controller.ts) ──────

  async getLeaderboard(userId: string, period: 'week' | 'month' = 'week') {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const coachId = user?.role === 'coach' ? user.id : user?.coach_id;
    if (!coachId) return [];

    const students = await this.prisma.user.findMany({
      where: { coach_id: coachId, role: 'student' },
    });
    if (students.length === 0) return [];

    const start = new Date();
    if (period === 'week') start.setDate(start.getDate() - 7);
    else start.setMonth(start.getMonth() - 1);

    const grouped = await this.prisma.workoutSession.groupBy({
      by: ['user_id'],
      where: { user_id: { in: students.map((s) => s.id) }, date: { gte: start } },
      _count: { _all: true },
    });

    const countByUser = new Map<string, number>();
    for (const g of grouped) countByUser.set(g.user_id, g._count._all);

    // Two-way block: hide roster rows in a block relation with the caller.
    const visibleStudents = await this.safety.filterBlocked(userId, students, (s) => s.id);
    // Client privacy: members see first names only; the coach sees full names.
    const isCoachView = user?.role === 'coach';
    const leaderboard = visibleStudents.map((s) => ({
      user_id: s.id,
      name: isCoachView ? s.name : memberFirstName(s.name),
      workouts_completed: countByUser.get(s.id) ?? 0,
    }));

    return leaderboard.sort((a, b) => b.workouts_completed - a.workouts_completed);
  }

  /**
   * GET /community/feed — the last 30 member wins the caller may see (see
   * community-wins.policy.ts): the coach's circle when the coach runs a
   * moderated community workspace, otherwise the caller's own wins only.
   * Never another tenant's wins. Hidden wins, wins by members removed from
   * the workspace, and wins by anyone in a block relation with the caller
   * (either direction) are dropped. Other members appear by first name only.
   */
  async getFeed(userId: string): Promise<CommunityWinView[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, coach_id: true },
    });
    if (!user) return [];
    const coachId = user.role === 'coach' ? user.id : user.coach_id;
    const workspaceId = await winModerationWorkspaceId(this.prisma, coachId);
    const where =
      workspaceId && coachId
        ? { coach_id: coachId, hidden_at: null }
        : { user_id: userId, hidden_at: null };

    const wins = await this.prisma.communityWin.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: 30,
      select: WIN_SELECT,
    });

    let visible = wins;
    if (workspaceId) {
      const others = [...new Set(wins.map((w) => w.user_id))].filter((id) => id !== userId);
      const removed = await removedFromWorkspace(this.prisma, workspaceId, others);
      if (removed.size > 0) visible = visible.filter((w) => !removed.has(w.user_id));
    }
    // Two-way block: hide wins by anyone in a block relation with the caller.
    visible = await this.safety.filterBlocked(userId, visible, (w) => w.user_id);
    return visible.map((w) => winView(w, userId));
  }

  /**
   * POST /community/wins — share a win with the coach's circle. The content
   * filter runs before the write (422 community.content.rejected, nothing
   * stored). A member removed from the coach's community cannot post (403
   * community.win.removed_member). Visibility is always the circle.
   */
  async postWin(
    userId: string,
    data: { title: string; description: string; visibility?: 'circle' | 'public' },
  ): Promise<CommunityWinView> {
    this.safety.assertAllowed(data.title, data.description);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { coach_id: true, role: true, id: true },
    });
    const coachId = user?.role === 'coach' ? user.id : (user?.coach_id ?? null);
    const workspaceId = await winModerationWorkspaceId(this.prisma, coachId);
    if (workspaceId && (await removedFromWorkspace(this.prisma, workspaceId, [userId])).size > 0) {
      throw new ForbiddenException(WIN_POSTING_REMOVED);
    }

    const win = await this.prisma.communityWin.create({
      data: {
        user_id: userId,
        coach_id: coachId,
        title: data.title,
        description: data.description,
        // No cross-tenant public feed: every win is shared with the circle.
        visibility: 'circle',
      },
      select: WIN_SELECT,
    });
    return winView(win, userId);
  }

  /**
   * DELETE /community/wins/:id — the author deletes their own win (hard
   * delete; it is their content). Anyone else, or a missing id, gets the same
   * 404 so ids cannot be probed. Open reports on it show as "Removed".
   */
  async deleteWin(userId: string, winId: string): Promise<{ id: string; deleted: true }> {
    const win = await this.prisma.communityWin.findUnique({
      where: { id: winId },
      select: { id: true, user_id: true },
    });
    if (!win || win.user_id !== userId) throw new NotFoundException(WIN_NOT_FOUND);
    await this.prisma.communityWin.deleteMany({ where: { id: winId, user_id: userId } });
    return { id: winId, deleted: true };
  }
}

const WIN_SELECT = {
  id: true,
  user_id: true,
  title: true,
  description: true,
  created_at: true,
  user: { select: { name: true } },
} as const;

interface WinRow {
  id: string;
  user_id: string;
  title: string;
  description: string;
  created_at: Date;
  user: { name: string | null } | null;
}

/**
 * One member win as the app renders it. `displayName` / `action` /
 * `createdAt` are the legacy keys older app builds read; new builds use the
 * snake_case keys.
 */
export interface CommunityWinView {
  id: string;
  user_id: string;
  display_name: string;
  title: string;
  description: string;
  created_at: string;
  is_mine: boolean;
  displayName: string;
  action: string;
  createdAt: string;
}

function winView(w: WinRow, viewerId: string): CommunityWinView {
  // Client privacy: other members see first names only.
  const name = memberFirstName(w.user?.name);
  const created = w.created_at.toISOString();
  return {
    id: w.id,
    user_id: w.user_id,
    display_name: name,
    title: w.title,
    description: w.description,
    created_at: created,
    is_mine: w.user_id === viewerId,
    displayName: name,
    action: w.title,
    createdAt: created,
  };
}
