/**
 * v2-2 AckService unit tests.
 *
 * Pins the state-machine contract with repo / access / analytics fully mocked
 * (no DB, no Nest container):
 *  - happy-path transitions write the right column and emit telemetry;
 *  - idempotency: re-stamping an already-set state is a no-op (no write, no
 *    telemetry) and returns the existing timestamp;
 *  - concurrency: the atomic conditional stamp advances at most once, so a
 *    race produces exactly one advance + one telemetry emission (R1);
 *  - illegal transitions (seen/acked after replied) raise 409;
 *  - authorization NON-LEAK (R1): missing/deleted/foreign messages ALL 404
 *    identically (no 403-vs-404 existence oracle), platform owner bypass;
 *  - eligibility (R1): only client (student) authored messages are ackable —
 *    coach/owner/system-authored messages 404 identically;
 *  - read-side state derivation + SLA envelope.
 *
 * Fakes come from the typed `ack.test-fixtures` builders (R0: no `as unknown
 * as`). The atomic `stampAck` now returns `{ advanced, message }`; the repo
 * mock honours the `{ [column]: null }` compare-and-set semantics.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { CommunityMessage, Role } from '@prisma/client';
import { ACK_TRANSITION_EVENT, AckService } from './ack.service';
import type { StampResult } from './ack.repository';
import {
  FIXTURE_IDS,
  coachUser,
  foreignCoachUser,
  message as msg,
  ownerUser,
} from './ack.test-fixtures';

const MSG_ID = FIXTURE_IDS.message;
const coach = coachUser();
const owner = ownerUser();
const foreignCoach = foreignCoachUser();

/**
 * A repo `stampAck` double that honours the atomic compare-and-set: it
 * advances (count===1) only when the target column is currently null on the
 * provided `current` row, otherwise it reports a zero-row no-op and returns
 * the current row unchanged.
 */
function stampAckFrom(
  current: CommunityMessage,
): (
  m: Pick<CommunityMessage, 'id' | 'created_at'>,
  col: 'coach_seen_at' | 'coach_acked_at' | 'coach_replied_at',
  at: Date,
) => Promise<StampResult> {
  return async (_m, col, at) => {
    if (current[col]) {
      return { advanced: false, message: current };
    }
    return { advanced: true, message: msg({ ...current, [col]: at }) };
  };
}

describe('AckService', () => {
  let repo: {
    findById: jest.Mock;
    findSenderRole: jest.Mock;
    stampAck: jest.Mock;
  };
  let access: { isWorkspaceCoach: jest.Mock };
  let analytics: { capture: jest.Mock };
  let service: AckService;

  beforeEach(() => {
    repo = {
      findById: jest.fn(),
      // Default: messages are client-authored (eligible) unless a test says
      // otherwise.
      findSenderRole: jest.fn(async (): Promise<Role> => 'student'),
      stampAck: jest.fn(),
    };
    access = { isWorkspaceCoach: jest.fn(async () => true) };
    analytics = { capture: jest.fn() };
    service = new AckService(repo as never, access as never, analytics as never);
  });

  describe('authorization (non-leak: no 403-vs-404 oracle)', () => {
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

    it('404 (NOT 403) when a coach does not own the message workspace', async () => {
      repo.findById.mockResolvedValue(msg());
      access.isWorkspaceCoach.mockResolvedValue(false);
      await expect(
        service.applyTransition(foreignCoach, MSG_ID, 'seen'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.stampAck).not.toHaveBeenCalled();
    });

    it('no existence oracle: an absent ID and a real foreign-workspace ID return identical 404s', async () => {
      // Absent message.
      repo.findById.mockResolvedValueOnce(null);
      const absent = await service
        .applyTransition(foreignCoach, MSG_ID, 'seen')
        .catch((e) => e);
      // Real message in a workspace this coach does not own.
      repo.findById.mockResolvedValueOnce(msg());
      access.isWorkspaceCoach.mockResolvedValue(false);
      const foreign = await service
        .applyTransition(foreignCoach, MSG_ID, 'seen')
        .catch((e) => e);

      expect(absent).toBeInstanceOf(NotFoundException);
      expect(foreign).toBeInstanceOf(NotFoundException);
      // Same status AND same body — a prober cannot distinguish the two.
      expect((absent as NotFoundException).getStatus()).toBe(
        (foreign as NotFoundException).getStatus(),
      );
      expect((absent as NotFoundException).getResponse()).toEqual(
        (foreign as NotFoundException).getResponse(),
      );
    });

    it('platform owner bypasses the workspace-coach check', async () => {
      const m = msg();
      repo.findById.mockResolvedValue(m);
      repo.stampAck.mockImplementation(stampAckFrom(m));
      const res = await service.applyTransition(owner, MSG_ID, 'seen');
      expect(access.isWorkspaceCoach).not.toHaveBeenCalled();
      expect(res.ack.state).toBe('seen');
    });
  });

  describe('eligibility (only client-authored messages are ackable)', () => {
    it('404 (non-leaking) when the message was authored by a coach', async () => {
      repo.findById.mockResolvedValue(msg());
      repo.findSenderRole.mockResolvedValue('coach');
      await expect(
        service.applyTransition(coach, MSG_ID, 'seen'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.stampAck).not.toHaveBeenCalled();
    });

    it('404 (non-leaking) when the message was authored by the platform owner/system', async () => {
      repo.findById.mockResolvedValue(msg());
      repo.findSenderRole.mockResolvedValue('owner');
      await expect(
        service.applyTransition(coach, MSG_ID, 'acked'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.stampAck).not.toHaveBeenCalled();
    });

    it('404 when the sender role cannot be resolved (fails safe)', async () => {
      repo.findById.mockResolvedValue(msg());
      repo.findSenderRole.mockResolvedValue(null);
      await expect(
        service.applyTransition(coach, MSG_ID, 'seen'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('ineligible coach-authored message 404s identically to an absent message (no oracle)', async () => {
      repo.findById.mockResolvedValueOnce(null);
      const absent = await service
        .applyTransition(coach, MSG_ID, 'seen')
        .catch((e) => e);
      repo.findById.mockResolvedValueOnce(msg());
      repo.findSenderRole.mockResolvedValue('coach');
      const ineligible = await service
        .applyTransition(coach, MSG_ID, 'seen')
        .catch((e) => e);
      expect((absent as NotFoundException).getResponse()).toEqual(
        (ineligible as NotFoundException).getResponse(),
      );
    });
  });

  describe('happy-path transitions', () => {
    it('marks seen — stamps coach_seen_at and emits telemetry', async () => {
      const m = msg();
      repo.findById.mockResolvedValue(m);
      repo.stampAck.mockImplementation(stampAckFrom(m));
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
      const m = msg({ coach_seen_at: new Date() });
      repo.findById.mockResolvedValue(m);
      repo.stampAck.mockImplementation(stampAckFrom(m));
      const res = await service.applyTransition(coach, MSG_ID, 'acked');
      expect(repo.stampAck).toHaveBeenCalledWith(
        expect.anything(),
        'coach_acked_at',
        expect.any(Date),
      );
      expect(res.ack.state).toBe('acked');
    });

    it('marks replied (terminal)', async () => {
      const m = msg({ coach_seen_at: new Date(), coach_acked_at: new Date() });
      repo.findById.mockResolvedValue(m);
      repo.stampAck.mockImplementation(stampAckFrom(m));
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

  describe('concurrency (atomic conditional stamp)', () => {
    it('two simultaneous callers → exactly one advance + one telemetry emission', async () => {
      // Both callers read the same un-stamped row (the stale pre-check passes
      // for both). The atomic stamp is the single source of truth: the first
      // updateMany matches one row (advanced), the second matches zero.
      const m = msg();
      repo.findById.mockResolvedValue(m);

      let stamped = false;
      repo.stampAck.mockImplementation(
        async (_m, col: 'coach_seen_at', at: Date): Promise<StampResult> => {
          if (stamped) {
            // Concurrent loser: zero rows matched `{ col: null }`; refetch
            // returns the already-stamped row.
            return { advanced: false, message: msg({ [col]: at }) };
          }
          stamped = true;
          return { advanced: true, message: msg({ [col]: at }) };
        },
      );

      const [a, b] = await Promise.all([
        service.applyTransition(coach, MSG_ID, 'seen'),
        service.applyTransition(coach, MSG_ID, 'seen'),
      ]);

      // Both callers get a coherent 'seen' envelope (idempotent for the loser).
      expect(a.ack.state).toBe('seen');
      expect(b.ack.state).toBe('seen');
      // The conditional write was attempted twice but advanced exactly once...
      expect(repo.stampAck).toHaveBeenCalledTimes(2);
      // ...and telemetry fired exactly once (no double-emit).
      expect(analytics.capture).toHaveBeenCalledTimes(1);
    });

    it('a zero-row stamp result is an idempotent no-op with no telemetry', async () => {
      const m = msg();
      repo.findById.mockResolvedValue(m);
      repo.stampAck.mockResolvedValue({
        advanced: false,
        message: msg({ coach_seen_at: new Date() }),
      });
      const res = await service.applyTransition(coach, MSG_ID, 'seen');
      expect(res.ack.state).toBe('seen');
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
