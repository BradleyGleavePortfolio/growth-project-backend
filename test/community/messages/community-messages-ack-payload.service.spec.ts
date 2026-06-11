/**
 * v2-2 (R1 fixer, B-P2) — message READ ack-payload contract tests.
 *
 * The transition endpoints (POST seen/acked/replied) already have coverage; what
 * the R1 code audit flagged as missing was a pin on the READ side: that
 * `CommunityMessagesService.getOne` and `.list` attach the coach ack envelope
 * ONLY when `FEATURE_COMMUNITY_ACKS` is on, and omit the key entirely when off
 * (kill-switch / byte-for-byte back-compat invariant). The read path NEVER
 * mutates ack state, so these tests also assert no repo write method is touched.
 *
 * Message-view ack shape is the FLAT `MessageAckEnvelope`
 * `{ seen_at, acked_at, replied_at, sla_state }` (NOT the full inbox/transition
 * `AckStateDto`) — see CommunityMessagesService.viewAck. Repo + access +
 * realtime + planContext are mocked (no DB).
 */
import type { CommunityMessage, User } from '@prisma/client';
import { CommunityMessagesService } from '../../../src/community/messages/community-messages.service';
import { FEATURE_COMMUNITY_ACKS_ENV } from '../../../src/community/ack/ack.feature';

const COHORT = '11111111-1111-1111-1111-111111111111';
const WORKSPACE = '22222222-2222-2222-2222-222222222222';
const MESSAGE_ID = 'eeeeeeee-0000-0000-0000-000000000001';

const coach = {
  id: 'cccccccc-0000-0000-0000-00000000000a',
  role: 'coach',
} as unknown as User;

/**
 * A cohort-scoped client message that has been seen + acked by the coach but
 * not yet replied. created_at is recent (now) so the derived SLA state is
 * `within` regardless of the default 24h/48h thresholds.
 */
function cohortMessage(over?: Partial<CommunityMessage>): CommunityMessage {
  const at = new Date();
  return {
    id: MESSAGE_ID,
    created_at: at,
    updated_at: at,
    workspace_id: WORKSPACE,
    cohort_id: COHORT,
    scope: 'cohort',
    sender_id: 'dddddddd-0000-0000-0000-00000000000b',
    kind: 'text',
    body: 'still stuck on day 3, help?',
    coach_seen_at: new Date(at.getTime() - 60_000),
    coach_acked_at: new Date(at.getTime() - 30_000),
    coach_replied_at: null,
    deleted_at: null,
    plan_context_type: null,
    plan_context_payload: null,
    ...over,
  } as unknown as CommunityMessage;
}

describe('CommunityMessagesService read ack payload (B-P2)', () => {
  let access: { findCohort: jest.Mock; canAccessCohort: jest.Mock };
  let repo: {
    findById: jest.Mock;
    listCohortMessages: jest.Mock;
    createCohortMessage: jest.Mock;
    markCohortClientMessagesReplied: jest.Mock;
    updateMessage: jest.Mock;
    softDeleteMessage: jest.Mock;
  };
  let realtime: {
    channels: { cohort: jest.Mock };
    cohortShard: jest.Mock;
    broadcastCommunityEvent: jest.Mock;
  };
  let planContext: { validate: jest.Mock };
  let service: CommunityMessagesService;
  const prevFlag = process.env[FEATURE_COMMUNITY_ACKS_ENV];

  beforeEach(() => {
    access = {
      findCohort: jest.fn(async () => ({ id: COHORT, workspace_id: WORKSPACE })),
      canAccessCohort: jest.fn(async () => true),
    };
    repo = {
      findById: jest.fn(async () => cohortMessage()),
      listCohortMessages: jest.fn(async () => [cohortMessage()]),
      createCohortMessage: jest.fn(),
      markCohortClientMessagesReplied: jest.fn(),
      updateMessage: jest.fn(),
      softDeleteMessage: jest.fn(),
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

  afterEach(() => {
    if (prevFlag === undefined) delete process.env[FEATURE_COMMUNITY_ACKS_ENV];
    else process.env[FEATURE_COMMUNITY_ACKS_ENV] = prevFlag;
    jest.clearAllMocks();
  });

  // ── getOne ────────────────────────────────────────────────────────────────

  describe('getOne', () => {
    it('attaches the flat ack envelope when FEATURE_COMMUNITY_ACKS is on', async () => {
      process.env[FEATURE_COMMUNITY_ACKS_ENV] = 'true';
      const res = await service.getOne(coach, MESSAGE_ID);
      expect(res.message.ack).toBeDefined();
      // FLAT message-view shape: exactly these four keys, no `state`, no `sla`.
      expect(Object.keys(res.message.ack as object).sort()).toEqual(
        ['acked_at', 'replied_at', 'seen_at', 'sla_state'].sort(),
      );
      expect(res.message.ack).toEqual({
        seen_at: expect.any(String),
        acked_at: expect.any(String),
        replied_at: null,
        sla_state: 'within',
      });
    });

    it('mirrors the persisted coach_*_at columns into the envelope', async () => {
      process.env[FEATURE_COMMUNITY_ACKS_ENV] = 'true';
      const m = cohortMessage({
        coach_seen_at: new Date('2026-01-01T00:00:00.000Z'),
        coach_acked_at: null,
        coach_replied_at: null,
      });
      repo.findById.mockResolvedValueOnce(m);
      const res = await service.getOne(coach, MESSAGE_ID);
      expect(res.message.ack).toMatchObject({
        seen_at: '2026-01-01T00:00:00.000Z',
        acked_at: null,
        replied_at: null,
      });
    });

    it('OMITS the ack key entirely when the flag is off (back-compat)', async () => {
      delete process.env[FEATURE_COMMUNITY_ACKS_ENV];
      const res = await service.getOne(coach, MESSAGE_ID);
      expect('ack' in (res.message as object)).toBe(false);
      expect(res.message.ack).toBeUndefined();
    });

    it('a flag value other than the literal "true" stays off (fail-safe)', async () => {
      process.env[FEATURE_COMMUNITY_ACKS_ENV] = 'TRUE';
      const res = await service.getOne(coach, MESSAGE_ID);
      expect(res.message.ack).toBeUndefined();
    });

    it('is read-only — never invokes a repo write/transition method', async () => {
      process.env[FEATURE_COMMUNITY_ACKS_ENV] = 'true';
      await service.getOne(coach, MESSAGE_ID);
      expect(repo.createCohortMessage).not.toHaveBeenCalled();
      expect(repo.markCohortClientMessagesReplied).not.toHaveBeenCalled();
      expect(repo.updateMessage).not.toHaveBeenCalled();
      expect(repo.softDeleteMessage).not.toHaveBeenCalled();
    });
  });

  // ── list ──────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('attaches the flat ack envelope to each row when the flag is on', async () => {
      process.env[FEATURE_COMMUNITY_ACKS_ENV] = 'true';
      repo.listCohortMessages.mockResolvedValueOnce([
        cohortMessage({ id: MESSAGE_ID }),
        cohortMessage({
          id: 'eeeeeeee-0000-0000-0000-000000000002',
          coach_seen_at: null,
          coach_acked_at: null,
          coach_replied_at: null,
        }),
      ]);
      const res = await service.list(coach, COHORT, {});
      expect(res.messages).toHaveLength(2);
      for (const msg of res.messages) {
        expect(msg.ack).toBeDefined();
        expect(Object.keys(msg.ack as object).sort()).toEqual(
          ['acked_at', 'replied_at', 'seen_at', 'sla_state'].sort(),
        );
      }
      // Second row is fully un-stamped → all-null timestamps.
      expect(res.messages[1].ack).toEqual({
        seen_at: null,
        acked_at: null,
        replied_at: null,
        sla_state: 'within',
      });
    });

    it('OMITS the ack key on every row when the flag is off (back-compat)', async () => {
      delete process.env[FEATURE_COMMUNITY_ACKS_ENV];
      const res = await service.list(coach, COHORT, {});
      for (const msg of res.messages) {
        expect('ack' in (msg as object)).toBe(false);
        expect(msg.ack).toBeUndefined();
      }
    });

    it('is read-only — never invokes a repo write/transition method', async () => {
      process.env[FEATURE_COMMUNITY_ACKS_ENV] = 'true';
      await service.list(coach, COHORT, {});
      expect(repo.createCohortMessage).not.toHaveBeenCalled();
      expect(repo.markCohortClientMessagesReplied).not.toHaveBeenCalled();
      expect(repo.updateMessage).not.toHaveBeenCalled();
      expect(repo.softDeleteMessage).not.toHaveBeenCalled();
    });
  });
});
