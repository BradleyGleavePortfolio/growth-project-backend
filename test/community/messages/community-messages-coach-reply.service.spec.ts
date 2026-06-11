/**
 * Unit tests for the v1-6 coach-inbox producer wired into
 * CommunityMessagesService.send (R1-P2-001).
 *
 * The coach inbox marks a client message "unanswered" while
 * community_messages.coach_replied_at IS NULL. Before this fix nothing ever
 * wrote that column, so every client message stayed unanswered forever. These
 * tests pin the producer contract: a coach/owner cohort message stamps the
 * cohort's outstanding client messages (clearing them from the inbox); a client
 * message does not. Repo + realtime are mocked (no DB).
 */
import type { CommunityMessage, User } from '@prisma/client';
import { CommunityMessagesService } from '../../../src/community/messages/community-messages.service';

const COHORT = '11111111-1111-1111-1111-111111111111';
const WORKSPACE = '22222222-2222-2222-2222-222222222222';

const coach = {
  id: 'cccccccc-0000-0000-0000-00000000000a',
  role: 'coach',
} as unknown as User;
const client = {
  id: 'dddddddd-0000-0000-0000-00000000000b',
  role: 'student',
} as unknown as User;

function createdMessage(senderId: string): CommunityMessage {
  const at = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'eeeeeeee-0000-0000-0000-000000000001',
    created_at: at,
    updated_at: at,
    workspace_id: WORKSPACE,
    cohort_id: COHORT,
    scope: 'cohort',
    sender_id: senderId,
    kind: 'text',
    body: 'noted, keep going',
    coach_replied_at: null,
    deleted_at: null,
    plan_context_type: null,
    plan_context_payload: null,
  } as unknown as CommunityMessage;
}

describe('CommunityMessagesService.send — coach-inbox producer', () => {
  let access: { findCohort: jest.Mock; canAccessCohort: jest.Mock };
  let repo: {
    createCohortMessage: jest.Mock;
    markCohortClientMessagesReplied: jest.Mock;
  };
  let realtime: {
    channels: { cohort: jest.Mock };
    cohortShard: jest.Mock;
    broadcastCommunityEvent: jest.Mock;
  };
  // v2-1: CommunityMessagesService now takes PlanContextService. These coach-
  // reply tests never attach a plan_context, so validate() is never reached;
  // the stub just satisfies the constructor arity.
  let planContext: { validate: jest.Mock };
  let service: CommunityMessagesService;

  beforeEach(() => {
    access = {
      findCohort: jest.fn(async () => ({ id: COHORT, workspace_id: WORKSPACE })),
      canAccessCohort: jest.fn(async () => true),
    };
    repo = {
      createCohortMessage: jest.fn(),
      markCohortClientMessagesReplied: jest.fn(async () => 2),
    };
    realtime = {
      channels: { cohort: jest.fn(() => 'cohort-channel') },
      cohortShard: jest.fn(() => 0),
      broadcastCommunityEvent: jest.fn(async () => undefined),
    };
    planContext = {
      validate: jest.fn(async (_user, tag) => tag),
    };
    service = new CommunityMessagesService(
      access as never,
      repo as never,
      realtime as never,
      planContext as never,
    );
  });

  it('stamps the cohort\'s outstanding client messages when a COACH replies', async () => {
    repo.createCohortMessage.mockResolvedValue(createdMessage(coach.id));
    await service.send(coach, COHORT, 'noted, keep going');
    expect(repo.markCohortClientMessagesReplied).toHaveBeenCalledTimes(1);
    expect(repo.markCohortClientMessagesReplied).toHaveBeenCalledWith({
      cohortId: COHORT,
      repliedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  it('stamps when an OWNER replies (owner moderates as a coach)', async () => {
    const owner = {
      id: 'aaaaaaaa-0000-0000-0000-0000000000ff',
      role: 'owner',
    } as unknown as User;
    repo.createCohortMessage.mockResolvedValue(createdMessage(owner.id));
    await service.send(owner, COHORT, 'looks good');
    expect(repo.markCohortClientMessagesReplied).toHaveBeenCalledTimes(1);
  });

  it('does NOT stamp when a CLIENT sends a message (keeps it unanswered)', async () => {
    repo.createCohortMessage.mockResolvedValue(createdMessage(client.id));
    await service.send(client, COHORT, 'still stuck, help?');
    expect(repo.markCohortClientMessagesReplied).not.toHaveBeenCalled();
  });

  it('uses the write result cohort_id (never the request param) when stamping', async () => {
    const persisted = createdMessage(coach.id);
    persisted.cohort_id = COHORT;
    repo.createCohortMessage.mockResolvedValue(persisted);
    // Caller passes a different (spoofed) cohort id; producer must follow the
    // persisted row, not the param.
    await service.send(coach, 'ffffffff-9999-9999-9999-999999999999', 'ok');
    expect(repo.markCohortClientMessagesReplied).toHaveBeenCalledWith({
      cohortId: COHORT,
      repliedAt: persisted.created_at,
    });
  });
});
