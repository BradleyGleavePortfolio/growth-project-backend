// Opus C-6 (FR-1138): while FEATURE_COMMUNITY_SPACE_PUSH is off, a High alert does nothing (no mark, no count
// against today's 3, no reach in the reply) and the preview route answers 404.
import type { CommunityMessage, User } from '@prisma/client';
import type { CommunityAccessService } from '../../../src/community/community-access.service';
import { CommunityMessagesService } from '../../../src/community/messages/community-messages.service';
import type { CommunityMessagesRepository } from '../../../src/community/messages/community-messages.repository';
import type { CommunityNotificationsService } from '../../../src/community/notifications/community-notifications.service';
import type { PlanContextService } from '../../../src/community/plan-context/plan-context.service';
import type { CommunityRealtimeService } from '../../../src/community/realtime/community-realtime.service';
import type { CommunitySafetyService } from '../../../src/community/safety/community-safety.service';
import { CommunitySpacePushController } from '../../../src/community/space-push/community-space-push.controller';
import type { CommunitySpacePushService } from '../../../src/community/space-push/community-space-push.service';
import type { AuthedRequest } from '../../../src/auth/auth-request';

const stub = <T>(v: unknown): T => v as T;
const COHORT = '11111111-1111-1111-1111-111111111111';
const WORKSPACE = '22222222-2222-2222-2222-222222222222';
const COACH = 'aaaaaaaa-0000-0000-0000-000000000001';
const at = new Date('2026-10-24T16:00:00Z');
const message = stub<CommunityMessage>({
  id: 'eeeeeeee-0000-0000-0000-000000000001',
  workspace_id: WORKSPACE,
  cohort_id: COHORT,
  scope: 'cohort',
  kind: 'text',
  sender_id: COACH,
  body: 'team call moved to 6',
  visibility: 'active',
  parent_message_id: null,
  parent_message_at: null,
  high_alert: false,
  created_at: at,
  updated_at: at,
  coach_replied_at: null,
  coach_seen_at: null,
  coach_acked_at: null,
  deleted_at: null,
  plan_context_type: null,
  plan_context_payload: null,
});

function build() {
  const access = {
    findCohort: jest.fn(async () => ({ id: COHORT, workspace_id: WORKSPACE, kind: 'space' })),
    canAccessCohort: jest.fn(async () => true),
    assertCanPost: jest.fn(async () => undefined),
  };
  const repo = {
    findById: jest.fn(async (_id: string): Promise<CommunityMessage | null> => null),
    createCohortMessage: jest.fn(async () => message),
    markCohortClientMessagesReplied: jest.fn(async () => undefined),
    listCohortPushRecipients: jest.fn(async () => []),
  };
  // Today's 3 are used: with the switch on this send is refused (429).
  const spacePush = {
    highAlertAllowance: jest.fn(async () => ({ reach: 4, used_today: 3, limit: 3 })),
    highAlertPreview: jest.fn(async () => ({ reach: 4, used_today: 3, limit: 3 })),
    markHighAlert: jest.fn(async () => undefined),
  };
  const service = new CommunityMessagesService(
    stub<CommunityAccessService>(access),
    stub<CommunityMessagesRepository>(repo),
    stub<CommunityRealtimeService>({ broadcastCommunityEvent: jest.fn(async () => undefined) }),
    stub<PlanContextService>({ validate: jest.fn(async () => null) }),
    stub<CommunitySafetyService>({
      assertAllowed: jest.fn(),
      hiddenFromViewer: jest.fn(async () => new Set()),
      assertVisibleTo: jest.fn(async () => undefined),
    }),
    stub<CommunityNotificationsService>({ pushEnabled: () => false, sendCommunityPush: jest.fn() }),
    undefined,
    stub<CommunitySpacePushService>(spacePush),
  );
  const controller = new CommunitySpacePushController(stub<CommunityAccessService>(access), stub<CommunitySpacePushService>(spacePush));
  return { access, repo, spacePush, service, controller };
}

const coach = stub<User>({ id: COACH, role: 'coach' });
const was = process.env.FEATURE_COMMUNITY_SPACE_PUSH;
afterAll(() => {
  if (was === undefined) delete process.env.FEATURE_COMMUNITY_SPACE_PUSH;
  else process.env.FEATURE_COMMUNITY_SPACE_PUSH = was;
});

describe('Opus C-6: the space switch off', () => {
  beforeEach(() => {
    delete process.env.FEATURE_COMMUNITY_SPACE_PUSH;
  });

  it('a High alert is an ordinary message: no allowance read, no mark, no reach, never the 429', async () => {
    const { spacePush, service } = build();
    const sent = await service.send(coach, COHORT, 'team call moved to 6', undefined, undefined, undefined, true);
    expect(sent.message.id).toBe(message.id);
    expect(sent).not.toHaveProperty('high_alert_reach');
    expect(spacePush.highAlertAllowance).not.toHaveBeenCalled();
    expect(spacePush.markHighAlert).not.toHaveBeenCalled();
  });

  it('the preview route answers 404 before reading the space', async () => {
    const { access, spacePush, controller } = build();
    await expect(controller.preview(stub<AuthedRequest>({ user: coach }), COHORT)).rejects.toMatchObject({
      status: 404,
      response: { code: 'community.cohort.not_found' },
    });
    expect(access.findCohort).not.toHaveBeenCalled();
    expect(spacePush.highAlertAllowance).not.toHaveBeenCalled();
    expect(spacePush.highAlertPreview).not.toHaveBeenCalled();
  });
});

describe('the space switch on (unchanged)', () => {
  beforeEach(() => {
    process.env.FEATURE_COMMUNITY_SPACE_PUSH = 'true';
  });

  it('a High alert past today\'s 3 is refused; under it the message is marked and the reach returned', async () => {
    const { spacePush, service } = build();
    await expect(service.send(coach, COHORT, 'team call moved to 6', undefined, undefined, undefined, true)).rejects.toMatchObject({ status: 429 });
    spacePush.highAlertAllowance.mockResolvedValueOnce({ reach: 4, used_today: 1, limit: 3 });
    const sent = await service.send(coach, COHORT, 'team call moved to 6', undefined, undefined, undefined, true);
    expect(sent).toMatchObject({ high_alert_reach: 4 });
    expect(spacePush.markHighAlert).toHaveBeenCalledWith(message.id);
  });

  // FR-1168R2 C1: the reach returned for a High alert reply is the reach in its thread (the thread's first message;
  // tapping a reply joins that thread), so it leaves out who left the thread, as the push does.
  it('a High alert sent as a reply asks the reach for its thread; a new message asks for the whole space', async () => {
    const { repo, spacePush, service } = build();
    spacePush.highAlertAllowance.mockResolvedValue({ reach: 2, used_today: 0, limit: 3 });
    const root = stub<CommunityMessage>({ ...message, id: 'eeeeeeee-0000-0000-0000-0000000000a1', sender_id: COACH });
    const reply = stub<CommunityMessage>({ ...message, id: 'eeeeeeee-0000-0000-0000-0000000000a2', parent_message_id: root.id });
    repo.findById.mockImplementation(async (id: string) => [root, reply].find((m) => m.id === id) ?? null);
    const sent = await service.send(coach, COHORT, 'team call moved to 6', undefined, reply.id, undefined, true);
    expect(sent).toMatchObject({ high_alert_reach: 2 });
    expect(spacePush.highAlertAllowance).toHaveBeenLastCalledWith(COACH, expect.objectContaining({ id: COHORT }), root.id);
    await service.send(coach, COHORT, 'team call moved to 6', undefined, undefined, undefined, true);
    expect(spacePush.highAlertAllowance).toHaveBeenLastCalledWith(COACH, expect.objectContaining({ id: COHORT }), null);
  });

  it('the preview route answers the allowance', async () => {
    const { controller } = build();
    await expect(controller.preview(stub<AuthedRequest>({ user: coach }), COHORT)).resolves.toEqual({ reach: 4, used_today: 3, limit: 3 });
  });

  // FR-1168R2 C1: the preview takes the message a High alert reply answers (?reply_to=), so the reach the coach sees
  // before sending is the thread's, as it is after sending; a new message sends none.
  it('the preview route passes reply_to on, and nothing for a new message', async () => {
    const { controller, spacePush } = build();
    const req = stub<AuthedRequest>({ user: coach });
    const answers = 'eeeeeeee-0000-0000-0000-0000000000a2';
    await expect(controller.preview(req, COHORT, answers)).resolves.toEqual({ reach: 4, used_today: 3, limit: 3 });
    expect(spacePush.highAlertPreview).toHaveBeenLastCalledWith(COACH, expect.objectContaining({ id: COHORT }), answers);
    await controller.preview(req, COHORT);
    expect(spacePush.highAlertPreview).toHaveBeenLastCalledWith(COACH, expect.objectContaining({ id: COHORT }), null);
  });
});
