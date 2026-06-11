/**
 * v3-1 R1 regression — cross-surface containment (Finding 1).
 *
 * Challenge encouragement comments and per-participant leaderboard opt-in
 * sentinels are persisted as CommunityMessage rows carrying a non-null
 * `plan_context_type` discriminator (CHALLENGE_COMMENT_CONTEXT_TYPE /
 * CHALLENGE_OPTIN_CONTEXT_TYPE). They MUST never be reachable through the
 * cohort-chat message endpoints, and must never inflate the unread badge.
 *
 * These unit tests pin the fixed boundary directly:
 *   - CommunityMessagesService.getOne / edit / remove return 404 for ANY row
 *     with a non-null plan_context_type (challenge comment, opt-in sentinel, or
 *     post comment), and still serve a plain (null-context) message.
 *   - CommunityRepository.countUnreadCohortMessages filters on
 *     plan_context_type: null, so sub-surface rows are excluded from the count.
 *
 * Repo + access are mocked (no DB). Users come from the typed factory (R0: no
 * `as unknown as`).
 */
import { NotFoundException } from '@nestjs/common';
import type { CommunityMessage } from '@prisma/client';
import { CommunityMessagesService } from '../../../src/community/messages/community-messages.service';
import { CommunityRepository } from '../../../src/community/community.repository';
import {
  CHALLENGE_COMMENT_CONTEXT_TYPE,
  CHALLENGE_OPTIN_CONTEXT_TYPE,
} from '../../../src/community/challenges/community-challenges.repository';
import { COMMENT_CONTEXT_TYPE } from '../../../src/community/messages/community-messages.repository';
import { makeUser } from './test-user.factory';

const COHORT = '11111111-1111-1111-1111-111111111111';
const WORKSPACE = '22222222-2222-2222-2222-222222222222';
const MSG_ID = '33333333-3333-3333-3333-333333333333';

const member = makeUser({
  id: '44444444-4444-4444-4444-444444444444',
  role: 'student',
});

const NOW = new Date('2026-03-01T00:00:00.000Z');

function message(over: Partial<CommunityMessage> = {}): CommunityMessage {
  return {
    id: MSG_ID,
    created_at: NOW,
    updated_at: NOW,
    workspace_id: WORKSPACE,
    cohort_id: COHORT,
    scope: 'cohort',
    sender_id: member.id,
    kind: 'text',
    body: 'hello',
    visibility: 'active',
    coach_replied_at: null,
    deleted_at: null,
    plan_context_type: null,
    plan_context_id: null,
    plan_context_payload: null,
    ...over,
  } as CommunityMessage;
}

describe('v3-1 cross-surface containment (Finding 1)', () => {
  describe('CommunityMessagesService — challenge rows invisible to message paths', () => {
    let access: { findCohort: jest.Mock; canAccessCohort: jest.Mock };
    let repo: {
      findById: jest.Mock;
      updateBody: jest.Mock;
      softDelete: jest.Mock;
    };
    let realtime: {
      channels: { cohort: jest.Mock };
      cohortShard: jest.Mock;
      broadcastCommunityEvent: jest.Mock;
    };
    let planContext: { validate: jest.Mock };
    let service: CommunityMessagesService;

    beforeEach(() => {
      access = {
        findCohort: jest.fn(async () => ({ id: COHORT, workspace_id: WORKSPACE })),
        canAccessCohort: jest.fn(async () => true),
      };
      repo = {
        findById: jest.fn(),
        updateBody: jest.fn(async (m) => m),
        softDelete: jest.fn(async (m) => m),
      };
      realtime = {
        channels: { cohort: jest.fn(() => 'cohort-channel') },
        cohortShard: jest.fn(() => 0),
        broadcastCommunityEvent: jest.fn(async () => undefined),
      };
      planContext = { validate: jest.fn(async (_u, tag) => tag) };
      service = new CommunityMessagesService(
        access as never,
        repo as never,
        realtime as never,
        planContext as never,
      );
    });

    const subSurfaceTypes = [
      ['challenge comment', CHALLENGE_COMMENT_CONTEXT_TYPE],
      ['leaderboard opt-in sentinel', CHALLENGE_OPTIN_CONTEXT_TYPE],
      ['post comment', COMMENT_CONTEXT_TYPE],
    ] as const;

    for (const [label, ctx] of subSurfaceTypes) {
      it(`getOne 404s a ${label}`, async () => {
        repo.findById.mockResolvedValue(
          message({ plan_context_type: ctx, plan_context_id: COHORT }),
        );
        await expect(service.getOne(member, MSG_ID)).rejects.toBeInstanceOf(
          NotFoundException,
        );
      });

      it(`edit 404s a ${label} (no update issued)`, async () => {
        repo.findById.mockResolvedValue(
          message({ plan_context_type: ctx, plan_context_id: COHORT }),
        );
        await expect(
          service.edit(member, MSG_ID, 'tampered'),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(repo.updateBody).not.toHaveBeenCalled();
      });

      it(`remove 404s a ${label} (no delete issued)`, async () => {
        repo.findById.mockResolvedValue(
          message({ plan_context_type: ctx, plan_context_id: COHORT }),
        );
        await expect(service.remove(member, MSG_ID)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect(repo.softDelete).not.toHaveBeenCalled();
      });
    }

    it('still serves a plain (null-context) cohort message', async () => {
      repo.findById.mockResolvedValue(message({ plan_context_type: null }));
      const res = await service.getOne(member, MSG_ID);
      expect(res.message.id).toBe(MSG_ID);
    });
  });

  describe('CommunityRepository.countUnreadCohortMessages — sub-surface rows excluded', () => {
    type CountArg = {
      where: {
        plan_context_type: unknown;
        scope: unknown;
        deleted_at: unknown;
      };
    };
    it('counts only plan_context_type: null cohort messages', async () => {
      const count = jest.fn<Promise<number>, [CountArg]>(async () => 3);
      const prisma = { communityMessage: { count } };
      const repository = new CommunityRepository(prisma as never);

      await repository.countUnreadCohortMessages({
        userId: member.id,
        cohortIds: [COHORT],
        since: NOW,
      });

      expect(count).toHaveBeenCalledTimes(1);
      const arg = count.mock.calls[0][0];
      expect(arg.where.plan_context_type).toBeNull();
      expect(arg.where.scope).toBe('cohort');
      expect(arg.where.deleted_at).toBeNull();
    });
  });
});
