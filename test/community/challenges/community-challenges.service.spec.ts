/**
 * Unit tests for CommunityChallengesService (v3-1 community challenges).
 *
 * Mocks CommunityAccessService + CommunityChallengesRepository +
 * CommunityModerationService + realtime + notifications, so these run with NO
 * DB. They pin the slice's behavioral-design and tenancy doctrine:
 *
 *   - Tenancy: a cohort-scoped challenge is 404 to a non-member (existence never
 *     leaks); coach-only writes 403 a non-coach.
 *   - Participation: idempotent join; progress is MONOTONIC (a lower log cannot
 *     reduce the visible number — §3.4 no shame); reaching the OWN target marks
 *     completion exactly once and emits the milestone push.
 *   - Leaderboard is STRICTLY OPT-IN: default OFF returns available:false with no
 *     rows even when the coach enabled it; only opted-in participants ever appear,
 *     and only to an opted-in caller (consent on both sides).
 *   - Comments: visible-challenge gate; report delegates to the public moderation
 *     service's existing comment path (no moderation internals touched).
 */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CommunityChallenge,
  CommunityChallengeParticipation,
  CommunityMessage,
  User,
} from '@prisma/client';
import { CommunityChallengesService } from '../../../src/community/challenges/community-challenges.service';
import { makeUser } from './test-user.factory';

type AccessMock = {
  findWorkspace: jest.Mock;
  findCohort: jest.Mock;
  isWorkspaceCoach: jest.Mock;
  canAccessWorkspace: jest.Mock;
  canAccessCohort: jest.Mock;
  listAccessibleCohortIds: jest.Mock;
};
type RepoMock = {
  createChallenge: jest.Mock;
  findChallengeById: jest.Mock;
  listChallenges: jest.Mock;
  updateChallenge: jest.Mock;
  archiveChallenge: jest.Mock;
  findParticipation: jest.Mock;
  createParticipation: jest.Mock;
  updateParticipation: jest.Mock;
  applyProgressAtomically: jest.Mock;
  listParticipationsByProgress: jest.Mock;
  findOptIn: jest.Mock;
  setOptIn: jest.Mock;
  clearOptIn: jest.Mock;
  createComment: jest.Mock;
  listComments: jest.Mock;
  findCommentById: jest.Mock;
};
type ModerationMock = { report: jest.Mock };
type RealtimeMock = {
  broadcastCommunityEvent: jest.Mock;
  channels: { challenge: (id: string) => string };
};
type PushMock = { sendCommunityPush: jest.Mock };

const WS_A = '11111111-1111-1111-1111-111111111111';
const COHORT_A = '33333333-3333-3333-3333-333333333333';
const CH_A = '44444444-4444-4444-4444-444444444444';
const COACH_A_ID = '55555555-5555-5555-5555-555555555555';
const MEMBER_ID = '66666666-6666-6666-6666-666666666666';
const STRANGER_ID = '77777777-7777-7777-7777-777777777777';
const OWNER_ID = '88888888-8888-8888-8888-888888888888';
const PEER_ID = '99999999-9999-9999-9999-999999999999';
const PART_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const MSG_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const coachA = makeUser({ id: COACH_A_ID, role: 'coach' });
const member = makeUser({ id: MEMBER_ID, role: 'student' });
const stranger = makeUser({ id: STRANGER_ID, role: 'student' });
const owner = makeUser({ id: OWNER_ID, role: 'owner' });

const NOW = new Date('2026-03-01T00:00:00.000Z');

function challenge(over: Partial<CommunityChallenge> = {}): CommunityChallenge {
  return {
    id: CH_A,
    workspace_id: WS_A,
    cohort_id: null,
    created_by_id: coachA.id,
    title: 'Step challenge',
    description: 'Walk together.',
    status: 'active',
    starts_at: null,
    ends_at: null,
    metric_key: 'steps',
    target_value: new Prisma.Decimal(100),
    unit: 'steps',
    leaderboard_enabled: false,
    created_at: NOW,
    updated_at: NOW,
    archived_at: null,
    ...over,
  } as CommunityChallenge;
}

function participation(
  over: Partial<CommunityChallengeParticipation> = {},
): CommunityChallengeParticipation {
  return {
    id: PART_ID,
    workspace_id: WS_A,
    challenge_id: CH_A,
    user_id: MEMBER_ID,
    progress_value: new Prisma.Decimal(40),
    completed_at: null,
    last_logged_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  } as CommunityChallengeParticipation;
}

function optInRow(): CommunityMessage {
  return { id: 'optin-1' } as CommunityMessage;
}

describe('CommunityChallengesService', () => {
  let access: AccessMock;
  let repo: RepoMock;
  let moderation: ModerationMock;
  let realtime: RealtimeMock;
  let push: PushMock;
  let service: CommunityChallengesService;

  beforeEach(() => {
    access = {
      findWorkspace: jest.fn(),
      findCohort: jest.fn(),
      isWorkspaceCoach: jest.fn(),
      canAccessWorkspace: jest.fn(),
      canAccessCohort: jest.fn(),
      listAccessibleCohortIds: jest.fn().mockResolvedValue([]),
    };
    repo = {
      createChallenge: jest.fn(),
      findChallengeById: jest.fn(),
      listChallenges: jest.fn(),
      updateChallenge: jest.fn(),
      archiveChallenge: jest.fn(),
      findParticipation: jest.fn(),
      createParticipation: jest.fn(),
      updateParticipation: jest.fn(),
      applyProgressAtomically: jest.fn(),
      listParticipationsByProgress: jest.fn(),
      findOptIn: jest.fn(),
      setOptIn: jest.fn(),
      clearOptIn: jest.fn(),
      createComment: jest.fn(),
      listComments: jest.fn(),
      findCommentById: jest.fn(),
    };
    moderation = { report: jest.fn() };
    realtime = {
      broadcastCommunityEvent: jest.fn(),
      channels: { challenge: (id: string) => `community:challenge:${id}` },
    };
    push = { sendCommunityPush: jest.fn() };
    service = new CommunityChallengesService(
      access as never,
      repo as never,
      moderation as never,
      realtime as never,
      push as never,
    );
  });

  // ── Coach CRUD ──────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates a workspace-wide challenge for the owning coach', async () => {
      access.findWorkspace.mockResolvedValue({ id: WS_A });
      access.canAccessWorkspace.mockResolvedValue(true);
      access.isWorkspaceCoach.mockResolvedValue(true);
      repo.createChallenge.mockResolvedValue(challenge());

      const res = await service.create(coachA, WS_A, { title: 'Step challenge' });
      expect(res.challenge.id).toBe(CH_A);
      expect(res.participation).toBeNull();
      // Even when a coach later enables the board, creation defaults it OFF.
      expect(repo.createChallenge).toHaveBeenCalledWith(
        expect.objectContaining({ leaderboardEnabled: false }),
      );
    });

    it('403s a member who is not the coach', async () => {
      access.findWorkspace.mockResolvedValue({ id: WS_A });
      access.canAccessWorkspace.mockResolvedValue(true);
      access.isWorkspaceCoach.mockResolvedValue(false);
      await expect(
        service.create(member, WS_A, { title: 'X' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.createChallenge).not.toHaveBeenCalled();
    });

    it('404s a non-member before any write (existence never leaks)', async () => {
      access.findWorkspace.mockResolvedValue({ id: WS_A });
      access.canAccessWorkspace.mockResolvedValue(false);
      await expect(
        service.create(stranger, WS_A, { title: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.createChallenge).not.toHaveBeenCalled();
    });

    it('400s an inverted start/end window', async () => {
      access.findWorkspace.mockResolvedValue({ id: WS_A });
      access.canAccessWorkspace.mockResolvedValue(true);
      access.isWorkspaceCoach.mockResolvedValue(true);
      await expect(
        service.create(coachA, WS_A, {
          title: 'X',
          starts_at: '2026-03-10T00:00:00Z',
          ends_at: '2026-03-01T00:00:00Z',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── Tenancy / visibility ─────────────────────────────────────────────────────

  describe('getOne tenancy', () => {
    it('404s a cohort-scoped challenge for a non-member of that cohort', async () => {
      repo.findChallengeById.mockResolvedValue(
        challenge({ cohort_id: COHORT_A }),
      );
      access.findCohort.mockResolvedValue({ id: COHORT_A });
      access.canAccessCohort.mockResolvedValue(false);
      await expect(
        service.getOne(stranger, CH_A),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns a cohort challenge to an active cohort member', async () => {
      repo.findChallengeById.mockResolvedValue(
        challenge({ cohort_id: COHORT_A }),
      );
      access.findCohort.mockResolvedValue({ id: COHORT_A });
      access.canAccessCohort.mockResolvedValue(true);
      repo.findParticipation.mockResolvedValue(null);

      const res = await service.getOne(member, CH_A);
      expect(res.challenge.id).toBe(CH_A);
      expect(res.participation).toBeNull();
    });

    it('404s an archived challenge', async () => {
      repo.findChallengeById.mockResolvedValue(
        challenge({ archived_at: NOW }),
      );
      await expect(
        service.getOne(member, CH_A),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── Participation ────────────────────────────────────────────────────────────

  describe('join', () => {
    beforeEach(() => {
      repo.findChallengeById.mockResolvedValue(challenge());
      access.canAccessWorkspace.mockResolvedValue(true);
    });

    it('creates participation on first join', async () => {
      repo.findParticipation.mockResolvedValue(null);
      repo.createParticipation.mockResolvedValue(participation());
      const res = await service.join(member, CH_A);
      expect(res.participation.user_id).toBe(member.id);
      expect(repo.createParticipation).toHaveBeenCalledTimes(1);
    });

    it('is idempotent — a second join returns the existing row', async () => {
      repo.findParticipation.mockResolvedValue(participation());
      const res = await service.join(member, CH_A);
      expect(res.participation.progress_value).toBe(40);
      expect(repo.createParticipation).not.toHaveBeenCalled();
    });
  });

  describe('updateProgress', () => {
    beforeEach(() => {
      repo.findChallengeById.mockResolvedValue(challenge());
      access.canAccessWorkspace.mockResolvedValue(true);
      repo.findOptIn.mockResolvedValue(null);
    });

    it('403s progress before joining', async () => {
      repo.findParticipation.mockResolvedValue(null);
      await expect(
        service.updateProgress(member, CH_A, 10),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.updateParticipation).not.toHaveBeenCalled();
    });

    it('is monotonic — the atomic statement receives the raw incoming value', async () => {
      repo.findParticipation.mockResolvedValue(participation()); // current 40
      // The repo statement applies GREATEST in SQL; the service forwards the
      // incoming log unmodified and reads back the clamped row.
      repo.applyProgressAtomically.mockResolvedValue({
        participation: participation({ progress_value: new Prisma.Decimal(40) }),
        completionTransitioned: false,
      });
      const res = await service.updateProgress(member, CH_A, 10);
      const args = repo.applyProgressAtomically.mock.calls[0][0];
      expect((args.incoming as Prisma.Decimal).toNumber()).toBe(10);
      // Visible value reflects the monotonic GREATEST result, never the lower log.
      expect(res.participation.progress_value).toBe(40);
      expect(push.sendCommunityPush).not.toHaveBeenCalled();
    });

    it('raises the value and marks completion + milestone push at target', async () => {
      repo.findParticipation.mockResolvedValue(participation()); // current 40, target 100
      repo.applyProgressAtomically.mockResolvedValue({
        participation: participation({
          progress_value: new Prisma.Decimal(100),
          completed_at: NOW,
        }),
        completionTransitioned: true,
      });
      const res = await service.updateProgress(member, CH_A, 100);
      expect(res.participation.progress_value).toBe(100);
      expect(res.participation.completed).toBe(true);
      expect(push.sendCommunityPush).toHaveBeenCalledTimes(1);
      expect(realtime.broadcastCommunityEvent).toHaveBeenCalledTimes(1);
    });

    it('does not re-fire the milestone when completion did not transition', async () => {
      repo.findParticipation.mockResolvedValue(
        participation({ progress_value: new Prisma.Decimal(100), completed_at: NOW }),
      );
      // Already complete: the atomic statement did not flip completed_at, so
      // completionTransitioned is false and no push fires.
      repo.applyProgressAtomically.mockResolvedValue({
        participation: participation({
          progress_value: new Prisma.Decimal(120),
          completed_at: NOW,
        }),
        completionTransitioned: false,
      });
      await service.updateProgress(member, CH_A, 120);
      expect(push.sendCommunityPush).not.toHaveBeenCalled();
    });

    it('concurrency: races lower/higher logs + double completion — progress never regresses, exactly one milestone', async () => {
      // Two+ concurrent writers hit the SAME participation. The repository
      // contract (monotonic GREATEST progress write + a SEPARATE conditional
      // completion claim that only the first transitioning writer wins) is
      // simulated here by shared server state mutated under each call, pinning
      // the service contract end-to-end: whichever order the writes interleave,
      // the visible value only ever rises and completion emits exactly once.
      // The REAL SQL race against Postgres is exercised by the env-gated
      // live-DB spec (community-challenges-progress.live.spec.ts).
      repo.findParticipation.mockResolvedValue(participation()); // current 40, target 100
      let serverProgress = 40;
      let serverCompleted: Date | null = null;
      repo.applyProgressAtomically.mockImplementation(
        ({ incoming }: { incoming: Prisma.Decimal }) => {
          // Write 1: GREATEST(progress_value, incoming).
          serverProgress = Math.max(serverProgress, incoming.toNumber());
          // Write 2: conditional completion claim — succeeds only for the call
          // that flips completed_at from null while progress has reached target.
          const claimed = serverCompleted === null && serverProgress >= 100;
          if (claimed) serverCompleted = NOW;
          return Promise.resolve({
            participation: participation({
              progress_value: new Prisma.Decimal(serverProgress),
              completed_at: serverCompleted,
            }),
            completionTransitioned: claimed,
          });
        },
      );

      const results = await Promise.all([
        service.updateProgress(member, CH_A, 120),
        service.updateProgress(member, CH_A, 50),
        service.updateProgress(member, CH_A, 110),
      ]);

      // Progress never regressed below the joined value.
      for (const r of results) {
        expect(r.participation.progress_value).toBeGreaterThanOrEqual(40);
      }
      expect(serverProgress).toBe(120);
      // Completion fired exactly once across all racing target-reaching writes.
      expect(push.sendCommunityPush).toHaveBeenCalledTimes(1);
    });
  });

  // ── Leaderboard (strictly opt-in) ─────────────────────────────────────────────

  describe('getLeaderboard', () => {
    it('returns available:false with no rows by DEFAULT even if the coach enabled it', async () => {
      repo.findChallengeById.mockResolvedValue(
        challenge({ leaderboard_enabled: true }),
      );
      access.canAccessWorkspace.mockResolvedValue(true);
      repo.findOptIn.mockResolvedValue(null); // caller has NOT opted in

      const res = await service.getLeaderboard(member, CH_A);
      expect(res.available).toBe(false);
      expect(res.opted_in).toBe(false);
      expect(res.rows).toHaveLength(0);
      expect(repo.listParticipationsByProgress).not.toHaveBeenCalled();
    });

    it('returns available:false when opted in but the coach has NOT enabled it', async () => {
      repo.findChallengeById.mockResolvedValue(
        challenge({ leaderboard_enabled: false }),
      );
      access.canAccessWorkspace.mockResolvedValue(true);
      repo.findOptIn.mockResolvedValue(optInRow());

      const res = await service.getLeaderboard(member, CH_A);
      expect(res.available).toBe(false);
      expect(res.opted_in).toBe(true);
      expect(res.rows).toHaveLength(0);
    });

    it('lists ONLY opted-in participants, ranked, for an opted-in caller', async () => {
      repo.findChallengeById.mockResolvedValue(
        challenge({ leaderboard_enabled: true }),
      );
      access.canAccessWorkspace.mockResolvedValue(true);
      repo.findOptIn.mockResolvedValue(optInRow());
      // B-PAG-1 R4: the consent predicate is pushed INTO the repository as a
      // bounded DB-side EXISTS, so the page (and its next_cursor) only ever
      // contains opted-in participants — the service no longer post-filters NOR
      // pre-loads the opt-in id set. The repo mock returns the already-consent-
      // scoped page.
      repo.listParticipationsByProgress.mockResolvedValue({
        items: [
          participation({ user_id: PEER_ID, progress_value: new Prisma.Decimal(90) }),
          participation({ user_id: MEMBER_ID, progress_value: new Prisma.Decimal(40) }),
        ],
        nextCursor: null,
      });

      const res = await service.getLeaderboard(member, CH_A);
      expect(res.available).toBe(true);
      expect(res.rows.map((r) => r.user_id)).toEqual([PEER_ID, MEMBER_ID]);
      expect(res.rows[0].rank).toBe(1);
      expect(res.rows[1].is_self).toBe(true);
      // The service forwards the challenge's workspace as the consent scope so
      // the repository enforces consent DB-side on the page + cursor anchor; it
      // does NOT pre-load an opt-in id set. A non-consenting user can never be
      // returned NOR become a public cursor token (Failure #5 IDOR / #21 / #23).
      const call = repo.listParticipationsByProgress.mock.calls[0][0];
      expect(call.challengeId).toBe(CH_A);
      expect(call.consent).toEqual({ workspaceId: WS_A });
    });
  });

  describe('setLeaderboardOptIn', () => {
    beforeEach(() => {
      repo.findChallengeById.mockResolvedValue(
        challenge({ leaderboard_enabled: true }),
      );
      access.canAccessWorkspace.mockResolvedValue(true);
    });

    it('403s opting in before joining', async () => {
      repo.findParticipation.mockResolvedValue(null);
      await expect(
        service.setLeaderboardOptIn(member, CH_A, true),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.setOptIn).not.toHaveBeenCalled();
    });

    it('opts in, then opts out via the sentinel', async () => {
      repo.findParticipation.mockResolvedValue(participation());
      const inRes = await service.setLeaderboardOptIn(member, CH_A, true);
      expect(repo.setOptIn).toHaveBeenCalledTimes(1);
      expect(inRes.participation.leaderboard_opted_in).toBe(true);

      const outRes = await service.setLeaderboardOptIn(member, CH_A, false);
      expect(repo.clearOptIn).toHaveBeenCalledTimes(1);
      expect(outRes.participation.leaderboard_opted_in).toBe(false);
    });
  });

  // ── Comments + moderation ──────────────────────────────────────────────────────

  describe('comments', () => {
    beforeEach(() => {
      repo.findChallengeById.mockResolvedValue(challenge());
      access.canAccessWorkspace.mockResolvedValue(true);
    });

    it('adds an encouragement comment on a visible challenge', async () => {
      repo.createComment.mockResolvedValue({
        id: MSG_ID,
        plan_context_id: CH_A,
        sender_id: MEMBER_ID,
        body: 'Great work!',
        created_at: NOW,
      } as CommunityMessage);
      const res = await service.addComment(member, CH_A, 'Great work!');
      expect(res.comment.body).toBe('Great work!');
      expect(res.comment.challenge_id).toBe(CH_A);
    });

    it('404s commenting on a challenge the caller cannot see', async () => {
      repo.findChallengeById.mockResolvedValue(
        challenge({ cohort_id: COHORT_A }),
      );
      access.findCohort.mockResolvedValue({ id: COHORT_A });
      access.canAccessCohort.mockResolvedValue(false);
      await expect(
        service.addComment(stranger, CH_A, 'hi'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.createComment).not.toHaveBeenCalled();
    });

    it('delegates a report to moderation when the comment is bound to the challenge', async () => {
      repo.findCommentById.mockResolvedValue({
        id: MSG_ID,
        workspace_id: WS_A,
        cohort_id: null,
        plan_context_type: 'community_challenge_comment',
        plan_context_id: CH_A,
        deleted_at: null,
      } as CommunityMessage);
      moderation.report.mockResolvedValue({ item: { id: 'rep-1' } });
      await service.reportComment(member, CH_A, MSG_ID, 'inappropriate', undefined);
      expect(moderation.report).toHaveBeenCalledWith(
        member,
        'comment',
        MSG_ID,
        'inappropriate',
        undefined,
      );
    });

    it('404s without delegating when the comment is not bound to THIS challenge', async () => {
      // A real, visible message — but its plan_context_id points at a DIFFERENT
      // challenge, so the report must not be steered at it.
      repo.findCommentById.mockResolvedValue({
        id: MSG_ID,
        workspace_id: WS_A,
        cohort_id: null,
        plan_context_type: 'community_challenge_comment',
        plan_context_id: '00000000-0000-4000-8000-000000000999',
        deleted_at: null,
      } as CommunityMessage);
      await expect(
        service.reportComment(member, CH_A, MSG_ID, 'inappropriate', undefined),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(moderation.report).not.toHaveBeenCalled();
    });

    it('404s a plain cohort message (wrong discriminator) without delegating', async () => {
      repo.findCommentById.mockResolvedValue({
        id: MSG_ID,
        workspace_id: WS_A,
        cohort_id: null,
        plan_context_type: null,
        plan_context_id: null,
        deleted_at: null,
      } as CommunityMessage);
      await expect(
        service.reportComment(member, CH_A, MSG_ID, 'spam', undefined),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(moderation.report).not.toHaveBeenCalled();
    });

    it('404s a soft-deleted challenge comment without delegating', async () => {
      repo.findCommentById.mockResolvedValue({
        id: MSG_ID,
        workspace_id: WS_A,
        cohort_id: null,
        plan_context_type: 'community_challenge_comment',
        plan_context_id: CH_A,
        deleted_at: NOW,
      } as CommunityMessage);
      await expect(
        service.reportComment(member, CH_A, MSG_ID, 'spam', undefined),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(moderation.report).not.toHaveBeenCalled();
    });
  });
});
