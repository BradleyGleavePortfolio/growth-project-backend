import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CommunityChallenge,
  CommunityChallengeParticipation,
  CommunityChallengeStatus,
  CommunityMessage,
  User,
} from '@prisma/client';
import { CommunityAccessService } from '../community-access.service';
import { CommunityRealtimeService } from '../realtime/community-realtime.service';
import { CommunityNotificationsService } from '../notifications/community-notifications.service';
import { COMMUNITY_BROADCAST_EVENTS } from '../community-events';
import { NotificationKind } from '../../notifications/notification-kind';
import { CommunityModerationService } from '../moderation/community-moderation.service';
import type { CommunityModerationItemResponse } from '../dto/community-moderation.dto';
import {
  CHALLENGE_COMMENT_CONTEXT_TYPE,
  CommunityChallengesRepository,
} from './community-challenges.repository';
import {
  ChallengeCommentListResponse,
  ChallengeCommentListResponseSchema,
  ChallengeCommentResponse,
  ChallengeCommentResponseSchema,
  ChallengeCommentView,
  ChallengeListResponse,
  ChallengeListResponseSchema,
  ChallengeResponse,
  ChallengeResponseSchema,
  ChallengeView,
  LeaderboardResponse,
  LeaderboardResponseSchema,
  LeaderboardRowView,
  ParticipationResponse,
  ParticipationResponseSchema,
  ParticipationView,
} from './community-challenges.dto';

const NOT_FOUND = {
  error: 'not_found',
  code: 'community.challenge.not_found',
} as const;

const VALID_STATUSES: readonly CommunityChallengeStatus[] = [
  'draft',
  'active',
  'completed',
  'archived',
];

/**
 * Community challenges: coach-authored, participation-focused, opt-in ranking.
 *
 * BEHAVIORAL-GAMIFICATION DOCTRINE (DESIGN_INTELLIGENCE Part III). Three active
 * mechanics, ≤4 (S-curve §3.3):
 *   1. Challenge participation/completion (the core behavior).
 *   2. Progress vs the participant's OWN target — a competence signal in real
 *      metric units, not badge theater (§3.7). Progress is monotonic (never
 *      decremented), so there is no streak to break and no shame state (§3.4).
 *   3. Opt-in, cohort-LOCAL leaderboard (Strava local-winnable model §3.2),
 *      OFF by default and shown to a participant only after they personally
 *      opt in. There is no global ranking and no public-failure surface.
 *
 * TENANCY (v1-2 doctrine): the app runs as service_role (BYPASSRLS), so a
 * non-member read resolves to 404 (never leaking existence) and an unauthorised
 * write resolves to 403. Cohort-scoped challenges are visible only to that
 * cohort's active members.
 *
 * NO SCHEMA CHANGE (R69): the CommunityChallenge / CommunityChallengeParticipation
 * models are used exactly as they exist on main. Comments and the per-participant
 * leaderboard opt-in reuse the CommunityMessage model via distinct discriminators
 * (see the repository). Comment moderation reuses the public moderation service
 * by import — challenge comments are CommunityMessage rows, so the existing
 * `report(user, 'comment', id)` path resolves them with no moderation change.
 */
@Injectable()
export class CommunityChallengesService {
  constructor(
    private readonly access: CommunityAccessService,
    private readonly repo: CommunityChallengesRepository,
    private readonly moderation: CommunityModerationService,
    private readonly realtime: CommunityRealtimeService,
    private readonly communityPush: CommunityNotificationsService,
  ) {}

  // ── Views ───────────────────────────────────────────────────────────────────

  private toNumber(d: Prisma.Decimal | null): number | null {
    return d === null ? null : d.toNumber();
  }

  private challengeView(c: CommunityChallenge): ChallengeView {
    return {
      id: c.id,
      workspace_id: c.workspace_id,
      cohort_id: c.cohort_id,
      created_by_user_id: c.created_by_id,
      title: c.title,
      description: c.description,
      status: c.status,
      starts_at: c.starts_at?.toISOString() ?? null,
      ends_at: c.ends_at?.toISOString() ?? null,
      metric_key: c.metric_key,
      target_value: this.toNumber(c.target_value),
      unit: c.unit,
      leaderboard_enabled: c.leaderboard_enabled,
      created_at: c.created_at.toISOString(),
      updated_at: c.updated_at.toISOString(),
      archived: c.archived_at !== null,
    };
  }

  private participationView(
    p: CommunityChallengeParticipation,
    target: number | null,
    optedIn: boolean,
  ): ParticipationView {
    const progress = p.progress_value.toNumber();
    // Fraction is capped at 1 — overshooting the goal stays a positive 100%
    // (closure), never an "over budget" framing.
    const fraction =
      target === null || target <= 0 ? null : Math.min(progress / target, 1);
    return {
      challenge_id: p.challenge_id,
      user_id: p.user_id,
      progress_value: progress,
      target_value: target,
      progress_fraction: fraction,
      completed: p.completed_at !== null,
      completed_at: p.completed_at?.toISOString() ?? null,
      last_logged_at: p.last_logged_at?.toISOString() ?? null,
      leaderboard_opted_in: optedIn,
    };
  }

  private commentView(m: CommunityMessage): ChallengeCommentView {
    return {
      id: m.id,
      challenge_id: m.plan_context_id ?? '',
      author_user_id: m.sender_id,
      body: m.body ?? '',
      created_at: m.created_at.toISOString(),
    };
  }

  // ── Authorization helpers ─────────────────────────────────────────────────

  /** Coach (workspace owner) or platform owner. */
  private async assertCoach(
    workspaceId: string,
    user: User,
  ): Promise<void> {
    if (user.role === 'owner') return;
    if (await this.access.isWorkspaceCoach(workspaceId, user.id)) return;
    throw new ForbiddenException({
      error: 'forbidden',
      code: 'community.challenge.not_coach',
    });
  }

  /**
   * Resolve a challenge the caller may READ, or throw 404. A challenge scoped to
   * a cohort is readable only by that cohort's active members (plus coach/owner);
   * a workspace-wide challenge by any workspace member. Cross-tenant access
   * resolves to 404 so challenge existence never leaks.
   */
  private async readableChallenge(
    user: User,
    challengeId: string,
  ): Promise<CommunityChallenge> {
    const challenge = await this.repo.findChallengeById(challengeId);
    if (!challenge || challenge.archived_at) {
      throw new NotFoundException(NOT_FOUND);
    }
    if (challenge.cohort_id) {
      const cohort = await this.access.findCohort(challenge.cohort_id);
      if (!cohort || !(await this.access.canAccessCohort(cohort, user))) {
        throw new NotFoundException(NOT_FOUND);
      }
    } else if (!(await this.access.canAccessWorkspace(challenge.workspace_id, user))) {
      throw new NotFoundException(NOT_FOUND);
    }
    return challenge;
  }

  // ── Coach CRUD ──────────────────────────────────────────────────────────────

  async create(
    user: User,
    workspaceId: string,
    input: {
      title: string;
      description?: string;
      cohort_id?: string;
      starts_at?: string;
      ends_at?: string;
      metric_key?: string;
      target_value?: number;
      unit?: string;
      leaderboard_enabled?: boolean;
    },
  ): Promise<ChallengeResponse> {
    const workspace = await this.access.findWorkspace(workspaceId);
    // Non-members can't learn the workspace exists (404); members who aren't the
    // coach get an explicit 403.
    if (!workspace || !(await this.access.canAccessWorkspace(workspaceId, user))) {
      throw new NotFoundException(NOT_FOUND);
    }
    await this.assertCoach(workspaceId, user);

    let cohortId: string | null = null;
    if (input.cohort_id) {
      const cohort = await this.access.findCohort(input.cohort_id);
      if (!cohort || cohort.workspace_id !== workspaceId) {
        throw new NotFoundException(NOT_FOUND);
      }
      cohortId = cohort.id;
    }

    const startsAt = this.parseDate(input.starts_at);
    const endsAt = this.parseDate(input.ends_at);
    if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'community.challenge.invalid_window',
      });
    }

    const created = await this.repo.createChallenge({
      workspaceId,
      cohortId,
      createdById: user.id,
      title: input.title,
      description: input.description ?? null,
      startsAt,
      endsAt,
      metricKey: input.metric_key ?? null,
      targetValue: input.target_value ?? null,
      unit: input.unit ?? null,
      // Even if the coach enables the leaderboard, each participant must still
      // opt in personally before appearing — this flag only unlocks that choice.
      leaderboardEnabled: input.leaderboard_enabled ?? false,
    });
    return ChallengeResponseSchema.parse({
      challenge: this.challengeView(created),
      participation: null,
    });
  }

  async edit(
    user: User,
    challengeId: string,
    input: {
      title?: string;
      description?: string;
      starts_at?: string;
      ends_at?: string;
      metric_key?: string;
      target_value?: number;
      unit?: string;
      leaderboard_enabled?: boolean;
    },
  ): Promise<ChallengeResponse> {
    const challenge = await this.readableChallenge(user, challengeId);
    await this.assertCoach(challenge.workspace_id, user);

    const startsAt =
      input.starts_at !== undefined
        ? this.parseDate(input.starts_at)
        : challenge.starts_at;
    const endsAt =
      input.ends_at !== undefined
        ? this.parseDate(input.ends_at)
        : challenge.ends_at;
    if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'community.challenge.invalid_window',
      });
    }

    const data: Prisma.CommunityChallengeUpdateInput = {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.starts_at !== undefined ? { starts_at: startsAt } : {}),
      ...(input.ends_at !== undefined ? { ends_at: endsAt } : {}),
      ...(input.metric_key !== undefined ? { metric_key: input.metric_key } : {}),
      ...(input.target_value !== undefined
        ? { target_value: new Prisma.Decimal(input.target_value) }
        : {}),
      ...(input.unit !== undefined ? { unit: input.unit } : {}),
      ...(input.leaderboard_enabled !== undefined
        ? { leaderboard_enabled: input.leaderboard_enabled }
        : {}),
    };
    const updated = await this.repo.updateChallenge(challengeId, data);
    return ChallengeResponseSchema.parse({
      challenge: this.challengeView(updated),
      participation: null,
    });
  }

  async archive(user: User, challengeId: string): Promise<ChallengeResponse> {
    const challenge = await this.readableChallenge(user, challengeId);
    await this.assertCoach(challenge.workspace_id, user);
    // Idempotent: archiving an already-archived challenge would have 404'd in
    // readableChallenge, so here it is always a live → archived transition.
    const archived = await this.repo.archiveChallenge(challengeId);
    return ChallengeResponseSchema.parse({
      challenge: this.challengeView(archived),
      participation: null,
    });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async list(
    user: User,
    workspaceId: string,
    query: { cohort_id?: string; status?: string },
  ): Promise<ChallengeListResponse> {
    const workspace = await this.access.findWorkspace(workspaceId);
    if (!workspace || !(await this.access.canAccessWorkspace(workspaceId, user))) {
      throw new NotFoundException(NOT_FOUND);
    }
    const isCoach =
      user.role === 'owner' ||
      (await this.access.isWorkspaceCoach(workspaceId, user.id));

    // A member sees workspace-wide challenges plus those of cohorts they are an
    // active member of; a coach/owner sees the whole workspace. We resolve the
    // member's accessible cohort and filter to that, or to workspace-wide rows.
    let cohortFilter: string | null = null;
    if (query.cohort_id) {
      const cohort = await this.access.findCohort(query.cohort_id);
      if (!cohort || cohort.workspace_id !== workspaceId) {
        throw new NotFoundException(NOT_FOUND);
      }
      if (!(await this.access.canAccessCohort(cohort, user))) {
        throw new NotFoundException(NOT_FOUND);
      }
      cohortFilter = cohort.id;
    }

    const status = this.parseStatus(query.status);
    const rows = await this.repo.listChallenges({
      workspaceId,
      cohortId: cohortFilter,
      status,
    });

    // Visibility filter for non-coaches: drop cohort-scoped challenges the
    // caller is not an active member of. Coaches see everything in their ws.
    const visible: CommunityChallenge[] = [];
    for (const c of rows) {
      if (isCoach || c.cohort_id === null) {
        visible.push(c);
        continue;
      }
      const cohort = await this.access.findCohort(c.cohort_id);
      if (cohort && (await this.access.canAccessCohort(cohort, user))) {
        visible.push(c);
      }
    }

    return ChallengeListResponseSchema.parse({
      challenges: visible.map((c) => this.challengeView(c)),
    });
  }

  async getOne(user: User, challengeId: string): Promise<ChallengeResponse> {
    const challenge = await this.readableChallenge(user, challengeId);
    const participation = await this.repo.findParticipation(
      challengeId,
      user.id,
    );
    const optedIn =
      participation !== null &&
      (await this.repo.findOptIn(challengeId, user.id)) !== null;
    return ChallengeResponseSchema.parse({
      challenge: this.challengeView(challenge),
      participation:
        participation === null
          ? null
          : this.participationView(
              participation,
              this.toNumber(challenge.target_value),
              optedIn,
            ),
    });
  }

  // ── Participation ───────────────────────────────────────────────────────────

  async join(user: User, challengeId: string): Promise<ParticipationResponse> {
    const challenge = await this.readableChallenge(user, challengeId);
    const existing = await this.repo.findParticipation(challengeId, user.id);
    // Idempotent join: a second join returns the current participation rather
    // than erroring, so the "Join" tap is always safe to repeat.
    const participation =
      existing ??
      (await this.repo.createParticipation({
        workspaceId: challenge.workspace_id,
        challengeId,
        userId: user.id,
      }));
    return ParticipationResponseSchema.parse({
      participation: this.participationView(
        participation,
        this.toNumber(challenge.target_value),
        false,
      ),
    });
  }

  async updateProgress(
    user: User,
    challengeId: string,
    progressValue: number,
  ): Promise<ParticipationResponse> {
    const challenge = await this.readableChallenge(user, challengeId);
    const existing = await this.repo.findParticipation(challengeId, user.id);
    if (!existing) {
      throw new ForbiddenException({
        error: 'forbidden',
        code: 'community.challenge.not_joined',
      });
    }

    // Monotonic progress + idempotent completion claim (Finding 2): the
    // repository applies GREATEST(progress_value, incoming) and then, as a
    // SEPARATE conditional write, claims the completion transition only when
    // this call is the one that flipped completed_at from null. Racing writers
    // can no longer lose the higher value, regress the bar (design §3.4, no
    // shame state), or double-fire completion — completionTransitioned is true
    // for at most one of the concurrent target-reaching writers.
    const { participation: updated, completionTransitioned } =
      await this.repo.applyProgressAtomically({
        challengeId,
        userId: user.id,
        incoming: new Prisma.Decimal(progressValue),
        target: challenge.target_value,
        now: new Date(),
      });

    const target = this.toNumber(challenge.target_value);
    const next = updated.progress_value.toNumber();
    const percent =
      target !== null && target > 0 ? Math.min(next / target, 1) : 0;

    // Best-effort realtime ping (IDs + percent only, no PII). The progress
    // channel is per-challenge; clients refetch their own row via REST.
    void this.realtime.broadcastCommunityEvent(
      this.realtime.channels.challenge(challengeId),
      COMMUNITY_BROADCAST_EVENTS.challengeProgressChanged,
      { challengeId, userId: user.id, percent },
      { distinctId: user.id, channelKind: 'challenge' },
    );

    // Celebrate the participant's OWN completion as a positive milestone — a
    // self-directed closure event, never a comparison against others. Emitted
    // ONLY when the atomic statement actually flipped completed_at from null,
    // so concurrent target-reaching writes yield exactly one milestone push.
    //
    // Delivery semantics are deliberately AT-MOST-ONCE, not exactly-once. The
    // completion claim (repository: conditional UPDATE that flips completed_at)
    // and this push are separate, non-transactional steps: completed_at is
    // already committed before we get here, and the push is fire-and-forget
    // (void). If the process dies after the claim commits but before this call
    // is dispatched, the milestone is simply not delivered and is never
    // retried, because this slice intentionally carries no durable notification
    // outbox. That loss is accepted here: the milestone is a non-critical,
    // self-directed celebration with no downstream state or money attached, the
    // participant still sees completion via their own REST row, and adding an
    // outbox would be scope creep for a best-effort signal (matches the
    // campaign's documented best-effort reminder convention). A future durable
    // path would persist a notification-intent row inside the completion claim
    // transaction and drain it idempotently keyed by
    // (kind, recipientId, targetType, targetId). See the PR "Declared
    // deviations" entry for the full rationale.
    if (completionTransitioned) {
      void this.communityPush.sendCommunityPush({
        recipientId: user.id,
        kind: NotificationKind.COMMUNITY_CHALLENGE_MILESTONE,
        targetType: 'challenge',
        targetId: challengeId,
        deepLink: `tgp://community/challenges/${challengeId}`,
      });
    }

    const optedIn = (await this.repo.findOptIn(challengeId, user.id)) !== null;
    return ParticipationResponseSchema.parse({
      participation: this.participationView(updated, target, optedIn),
    });
  }

  // ── Leaderboard (strictly opt-in) ───────────────────────────────────────────

  async setLeaderboardOptIn(
    user: User,
    challengeId: string,
    optedIn: boolean,
  ): Promise<ParticipationResponse> {
    const challenge = await this.readableChallenge(user, challengeId);
    const participation = await this.repo.findParticipation(challengeId, user.id);
    if (!participation) {
      throw new ForbiddenException({
        error: 'forbidden',
        code: 'community.challenge.not_joined',
      });
    }
    if (optedIn) {
      await this.repo.setOptIn({
        workspaceId: challenge.workspace_id,
        cohortId: challenge.cohort_id,
        challengeId,
        userId: user.id,
      });
    } else {
      await this.repo.clearOptIn(challengeId, user.id);
    }
    return ParticipationResponseSchema.parse({
      participation: this.participationView(
        participation,
        this.toNumber(challenge.target_value),
        optedIn,
      ),
    });
  }

  /**
   * Leaderboard read. Returns `available: false` and NO rows unless BOTH the
   * coach has enabled the leaderboard AND the caller has personally opted in.
   * The board lists only other opted-in participants (consent on both sides),
   * is cohort-local (winnable), and exposes opaque user ids + rank — never a
   * "you are losing" framing and never a row for a non-consenting participant.
   */
  async getLeaderboard(
    user: User,
    challengeId: string,
  ): Promise<LeaderboardResponse> {
    const challenge = await this.readableChallenge(user, challengeId);
    const selfOptedIn =
      (await this.repo.findOptIn(challengeId, user.id)) !== null;

    if (!challenge.leaderboard_enabled || !selfOptedIn) {
      return LeaderboardResponseSchema.parse({
        available: false,
        opted_in: selfOptedIn,
        rows: [],
      });
    }

    const optedInIds = await this.repo.listOptedInUserIds(challengeId);
    const participations = await this.repo.listParticipationsByProgress(
      challengeId,
    );
    const rows: LeaderboardRowView[] = [];
    let rank = 0;
    for (const p of participations) {
      if (!optedInIds.has(p.user_id)) continue;
      rank += 1;
      rows.push({
        user_id: p.user_id,
        rank,
        progress_value: p.progress_value.toNumber(),
        is_self: p.user_id === user.id,
      });
    }
    return LeaderboardResponseSchema.parse({
      available: true,
      opted_in: true,
      rows,
    });
  }

  // ── Comments + moderation hook ──────────────────────────────────────────────

  async addComment(
    user: User,
    challengeId: string,
    body: string,
  ): Promise<ChallengeCommentResponse> {
    const challenge = await this.readableChallenge(user, challengeId);
    const created = await this.repo.createComment({
      workspaceId: challenge.workspace_id,
      cohortId: challenge.cohort_id,
      senderId: user.id,
      challengeId,
      body,
    });
    return ChallengeCommentResponseSchema.parse({
      comment: this.commentView(created),
    });
  }

  async listComments(
    user: User,
    challengeId: string,
  ): Promise<ChallengeCommentListResponse> {
    await this.readableChallenge(user, challengeId);
    const rows = await this.repo.listComments(challengeId);
    return ChallengeCommentListResponseSchema.parse({
      comments: rows.map((m) => this.commentView(m)),
    });
  }

  /**
   * Report a challenge comment. The comment is a CommunityMessage row, so this
   * delegates to the public moderation service's existing comment path (no
   * moderation internals are modified).
   *
   * Sub-surface binding (Finding 5): readableChallenge confirms the caller may
   * see the challenge, then we BIND the commentId to THIS challenge before
   * delegating — the row must be a non-deleted challenge comment
   * (plan_context_type === CHALLENGE_COMMENT_CONTEXT_TYPE) whose
   * plan_context_id is exactly challengeId and whose workspace/cohort match the
   * challenge. Any mismatch returns the SAME 404, so the report endpoint can
   * never be steered at an unrelated message while appearing challenge-scoped.
   */
  async reportComment(
    user: User,
    challengeId: string,
    commentId: string,
    reason: string,
    notes: string | undefined,
  ): Promise<CommunityModerationItemResponse> {
    const challenge = await this.readableChallenge(user, challengeId);
    const comment = await this.repo.findCommentById(commentId);
    if (
      !comment ||
      comment.deleted_at !== null ||
      comment.plan_context_type !== CHALLENGE_COMMENT_CONTEXT_TYPE ||
      comment.plan_context_id !== challengeId ||
      comment.workspace_id !== challenge.workspace_id ||
      comment.cohort_id !== challenge.cohort_id
    ) {
      throw new NotFoundException(NOT_FOUND);
    }
    return this.moderation.report(user, 'comment', commentId, reason, notes);
  }

  // ── Parsing helpers ──────────────────────────────────────────────────────────

  private parseDate(value: string | undefined): Date | null {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  private parseStatus(
    value: string | undefined,
  ): CommunityChallengeStatus | null {
    if (!value) return null;
    return VALID_STATUSES.includes(value as CommunityChallengeStatus)
      ? (value as CommunityChallengeStatus)
      : null;
  }
}
