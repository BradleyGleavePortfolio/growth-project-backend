/**
 * v2-2 AckService unit tests.
 *
 * Pins the state-machine contract with repo / access / analytics fully mocked
 * (no DB, no Nest container):
 *  - happy-path transitions write the right column and emit telemetry;
 *  - idempotency: re-stamping an already-set state is a no-op (no write, no
 *    telemetry) and returns the existing timestamp;
 *  - illegal transitions (seen/acked after replied) raise 409;
 *  - authorization: foreign coach → 403, missing/deleted message → 404,
 *    platform owner bypass;
 *  - read-side state derivation + SLA envelope.
 */
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { CommunityMessage, User } from '@prisma/client';
import { ACK_TRANSITION_EVENT, AckService } from './ack.service';

const WORKSPACE = '22222222-2222-2222-2222-222222222222';
const MSG_ID = 'eeeeeeee-0000-0000-0000-000000000001';

const coach = {
  id: 'cccccccc-0000-0000-0000-00000000000a',
  role: 'coach',
} as unknown as User;
const owner = {
  id: 'ffffffff-0000-0000-0000-00000000000f',
  role: 'owner',
} as unknown as User;
const foreignCoach = {
  id: 'aaaaaaaa-0000-0000-0000-00000000000c',
  role: 'coach',
} as unknown as User;

function msg(overrides: Partial<CommunityMessage> = {}): CommunityMessage {
  const at = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: MSG_ID,
    created_at: at,
    updated_at: at,
    workspace_id: WORKSPACE,
    cohort_id: '11111111-1111-1111-1111-111111111111',
    scope: 'cohort',
    sender_id: 'dddddddd-0000-0000-0000-00000000000b',
    kind: 'text',
    body: 'hello coach',
    coach_seen_at: null,
    coach_acked_at: null,
    coach_replied_at: null,
    deleted_at: null,
    plan_context_type: null,
    plan_context_payload: null,
    ...overrides,
  } as unknown as CommunityMessage;
}

describe('AckService', () => {
  let repo: { findById: jest.Mock; stampAck: jest.Mock };
  let access: { isWorkspaceCoach: jest.Mock };
  let analytics: { capture: jest.Mock };
  let service: AckService;

  beforeEach(() => {
    repo = {
      findById: jest.fn(),
      stampAck: jest.fn(),
    };
    access = { isWorkspaceCoach: jest.fn(async () => true) };
    analytics = { capture: jest.fn() };
    service = new AckService(
      repo as never,
      access as never,
      analytics as never,
    );
  });

  describe('authorization', () => {
    it('404 when the message does not exist', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(
        service.applyTransition(coach, MSG_ID, 'seen'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.stampAck).not.toHaveBeenCalled();
    });

    it('404 when the message is soft-deleted', async () => {
      repo.findById.mockResolvedValue(msg({ deleted_at: new Date() }));
      await expect(
        service.applyTransition(coach, MSG_ID, 'seen'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('403 when a coach does not own the message workspace', async () => {
      repo.findById.mockResolvedValue(msg());
      access.isWorkspaceCoach.mockResolvedValue(false);
      await expect(
        service.applyTransition(foreignCoach, MSG_ID, 'seen'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.stampAck).not.toHaveBeenCalled();
    });

    it('platform owner bypasses the workspace-coach check', async () => {
      repo.findById.mockResolvedValue(msg());
      repo.stampAck.mockImplementation(async (m, col, at) =>
        msg({ [col]: at }),
      );
      const res = await service.applyTransition(owner, MSG_ID, 'seen');
      expect(access.isWorkspaceCoach).not.toHaveBeenCalled();
      expect(res.ack.state).toBe('seen');
    });
  });

  describe('happy-path transitions', () => {
    it('marks seen — stamps coach_seen_at and emits telemetry', async () => {
      repo.findById.mockResolvedValue(msg());
      repo.stampAck.mockImplementation(async (m, col, at) =>
        msg({ [col]: at }),
      );
      const res = await service.applyTransition(coach, MSG_ID, 'seen');
      expect(repo.stampAck).toHaveBeenCalledWith(
        expect.anything(),
        'coach_seen_at',
        expect.any(Date),
      );
      expect(res.ack.state).toBe('seen');
      expect(res.ack.seen_at).not.toBeNull();
      expect(analytics.capture).toHaveBeenCalledWith(
        coach.id,
        ACK_TRANSITION_EVENT,
        expect.objectContaining({
          message_id: MSG_ID,
          from_state: 'none',
          to_state: 'seen',
          sla_state: expect.any(String),
        }),
      );
    });

    it('marks acked from seen', async () => {
      repo.findById.mockResolvedValue(msg({ coach_seen_at: new Date() }));
      repo.stampAck.mockImplementation(async (m, col, at) =>
        msg({ coach_seen_at: m.coach_seen_at, [col]: at }),
      );
      const res = await service.applyTransition(coach, MSG_ID, 'acked');
      expect(repo.stampAck).toHaveBeenCalledWith(
        expect.anything(),
        'coach_acked_at',
        expect.any(Date),
      );
      expect(res.ack.state).toBe('acked');
    });

    it('marks replied (terminal)', async () => {
      repo.findById.mockResolvedValue(
        msg({ coach_seen_at: new Date(), coach_acked_at: new Date() }),
      );
      repo.stampAck.mockImplementation(async (m, col, at) =>
        msg({
          coach_seen_at: m.coach_seen_at,
          coach_acked_at: m.coach_acked_at,
          [col]: at,
        }),
      );
      const res = await service.applyTransition(coach, MSG_ID, 'replied');
      expect(res.ack.state).toBe('replied');
      expect(res.ack.replied_at).not.toBeNull();
    });
  });

  describe('idempotency', () => {
    it('marking acked twice is a no-op and returns the existing acked_at', async () => {
      const acked = new Date('2026-01-01T05:00:00.000Z');
      repo.findById.mockResolvedValue(msg({ coach_acked_at: acked }));
      const res = await service.applyTransition(coach, MSG_ID, 'acked');
      expect(repo.stampAck).not.toHaveBeenCalled();
      expect(analytics.capture).not.toHaveBeenCalled();
      expect(res.ack.acked_at).toBe(acked.toISOString());
      expect(res.ack.state).toBe('acked');
    });

    it('marking seen when already seen is a no-op', async () => {
      repo.findById.mockResolvedValue(msg({ coach_seen_at: new Date() }));
      await service.applyTransition(coach, MSG_ID, 'seen');
      expect(repo.stampAck).not.toHaveBeenCalled();
      expect(analytics.capture).not.toHaveBeenCalled();
    });
  });

  describe('illegal transitions (monotonicity)', () => {
    it('409 marking seen after replied (cannot un-reply)', async () => {
      repo.findById.mockResolvedValue(msg({ coach_replied_at: new Date() }));
      await expect(
        service.applyTransition(coach, MSG_ID, 'seen'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.stampAck).not.toHaveBeenCalled();
    });

    it('409 marking acked after replied', async () => {
      repo.findById.mockResolvedValue(msg({ coach_replied_at: new Date() }));
      await expect(
        service.applyTransition(coach, MSG_ID, 'acked'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('does not emit telemetry on an illegal transition', async () => {
      repo.findById.mockResolvedValue(msg({ coach_replied_at: new Date() }));
      await expect(
        service.applyTransition(coach, MSG_ID, 'seen'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(analytics.capture).not.toHaveBeenCalled();
    });
  });

  describe('buildAckEnvelope (read side)', () => {
    it('derives none for an un-stamped message', () => {
      const env = service.buildAckEnvelope(msg());
      expect(env.state).toBe('none');
      expect(env.seen_at).toBeNull();
      expect(env.sla.sla_state).toMatch(/within|warning|breached/);
    });

    it('derives the highest reached state', () => {
      const env = service.buildAckEnvelope(
        msg({
          coach_seen_at: new Date(),
          coach_acked_at: new Date(),
          coach_replied_at: new Date(),
        }),
      );
      expect(env.state).toBe('replied');
    });
  });
});
