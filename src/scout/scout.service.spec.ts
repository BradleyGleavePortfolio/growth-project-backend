import 'reflect-metadata';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { ScoutService, SCOUT_PROGRESS_FLUSH_MS } from './scout.service';
import { ScoutCompleteDto, ScoutProgressDto } from './scout.dto';

// ── Typed test doubles ────────────────────────────────────────────────────────
// Built with Object.create(<Class>.prototype) + Object.assign so each double is
// structurally the real service without a forbidden escape-hatch cast (mirrors
// src/feature-flags/__tests__/feature-flags.controller.spec.ts).

interface PrismaDoubles {
  upsert: jest.Mock;
  create: jest.Mock;
}

function makePrisma(doubles: PrismaDoubles): PrismaService {
  return Object.assign(Object.create(PrismaService.prototype) as PrismaService, {
    scoutProgressSnapshot: { upsert: doubles.upsert },
    scoutImportCompletion: { create: doubles.create },
  });
}

function makeNotifications(pushToUser: jest.Mock): NotificationsService {
  return Object.assign(Object.create(NotificationsService.prototype) as NotificationsService, {
    pushToUser,
  });
}

function makeAnalytics(capture: jest.Mock): AnalyticsService {
  return Object.assign(Object.create(AnalyticsService.prototype) as AnalyticsService, { capture });
}

function p2002(): PrismaClientKnownRequestError {
  return new PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.0.0',
  });
}

const PROGRESS: ScoutProgressDto = {
  intent_id: 'intent-1',
  progress: [
    { entity_type: 'clients', count_committed: 3, total_estimated: 10 },
    { entity_type: 'workouts', count_committed: 0, total_estimated: 40 },
  ],
};

const COMPLETE_OK: ScoutCompleteDto = {
  intent_id: 'intent-1',
  terminal_status: 'success',
  final_counts: { clients: 10, workouts: 40 },
};

describe('ScoutService', () => {
  let upsert: jest.Mock;
  let create: jest.Mock;
  let pushToUser: jest.Mock;
  let capture: jest.Mock;
  let prisma: PrismaService;
  let notifications: NotificationsService;
  let analytics: AnalyticsService;
  let service: ScoutService;

  beforeEach(() => {
    upsert = jest.fn().mockResolvedValue({});
    create = jest.fn().mockResolvedValue({});
    pushToUser = jest.fn().mockResolvedValue({ delivered: true, code: 'delivered' });
    capture = jest.fn();
    prisma = makePrisma({ upsert, create });
    notifications = makeNotifications(pushToUser);
    analytics = makeAnalytics(capture);
    service = new ScoutService(prisma, notifications, analytics);
  });

  describe('recordProgress (hot path)', () => {
    it('does not write to the DB synchronously', () => {
      service.recordProgress('coach-1', PROGRESS);
      expect(upsert).not.toHaveBeenCalled();
    });

    it('persists the recorded snapshot on the next flush', async () => {
      service.recordProgress('coach-1', PROGRESS);
      await service.flush();
      expect(upsert).toHaveBeenCalledTimes(1);
    });

    it('keys the upsert by (coach_id, intent_id)', async () => {
      service.recordProgress('coach-1', PROGRESS);
      await service.flush();
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            coach_id_intent_id: { coach_id: 'coach-1', intent_id: 'intent-1' },
          },
        }),
      );
    });

    it('normalises the snapshot to the persisted entity shape', async () => {
      service.recordProgress('coach-1', PROGRESS);
      await service.flush();
      const arg = upsert.mock.calls[0][0];
      expect(arg.create.snapshot).toEqual({
        intent_id: 'intent-1',
        progress: [
          { entity_type: 'clients', count_committed: 3, total_estimated: 10 },
          { entity_type: 'workouts', count_committed: 0, total_estimated: 40 },
        ],
      });
    });

    it('writes the same snapshot on the create and update branch of the upsert', async () => {
      service.recordProgress('coach-1', PROGRESS);
      await service.flush();
      const arg = upsert.mock.calls[0][0];
      expect(arg.update.snapshot).toEqual(arg.create.snapshot);
    });

    it('defaults last_error to null when lastError is absent', async () => {
      service.recordProgress('coach-1', PROGRESS);
      await service.flush();
      const arg = upsert.mock.calls[0][0];
      expect(arg.create.last_error).toBeNull();
      expect(arg.update.last_error).toBeNull();
    });

    it('propagates lastError onto last_error when present', async () => {
      service.recordProgress('coach-1', {
        ...PROGRESS,
        lastError: 'rate limited by source platform',
      });
      await service.flush();
      const arg = upsert.mock.calls[0][0];
      expect(arg.create.last_error).toBe('rate limited by source platform');
    });

    it('coalesces repeated snapshots for one import into a single upsert', async () => {
      service.recordProgress('coach-1', PROGRESS);
      service.recordProgress('coach-1', {
        ...PROGRESS,
        progress: [{ entity_type: 'clients', count_committed: 7, total_estimated: 10 }],
      });
      await service.flush();
      expect(upsert).toHaveBeenCalledTimes(1);
    });

    it('keeps only the latest snapshot when coalescing', async () => {
      service.recordProgress('coach-1', PROGRESS);
      service.recordProgress('coach-1', {
        intent_id: 'intent-1',
        progress: [{ entity_type: 'clients', count_committed: 7, total_estimated: 10 }],
      });
      await service.flush();
      const arg = upsert.mock.calls[0][0];
      expect(arg.create.snapshot.progress).toEqual([
        { entity_type: 'clients', count_committed: 7, total_estimated: 10 },
      ]);
    });

    it('separates snapshots for different imports of the same coach', async () => {
      service.recordProgress('coach-1', PROGRESS);
      service.recordProgress('coach-1', { ...PROGRESS, intent_id: 'intent-2' });
      await service.flush();
      expect(upsert).toHaveBeenCalledTimes(2);
    });

    it('separates snapshots for the same intent across different coaches', async () => {
      service.recordProgress('coach-1', PROGRESS);
      service.recordProgress('coach-2', PROGRESS);
      await service.flush();
      expect(upsert).toHaveBeenCalledTimes(2);
    });
  });

  describe('flush', () => {
    it('is a no-op when the cache is empty', async () => {
      await service.flush();
      expect(upsert).not.toHaveBeenCalled();
    });

    it('drains the cache so a second flush writes nothing', async () => {
      service.recordProgress('coach-1', PROGRESS);
      await service.flush();
      upsert.mockClear();
      await service.flush();
      expect(upsert).not.toHaveBeenCalled();
    });

    it('re-queues a snapshot when its upsert fails so progress is not lost', async () => {
      upsert.mockRejectedValueOnce(new Error('db down'));
      service.recordProgress('coach-1', PROGRESS);
      await service.flush();
      expect(upsert).toHaveBeenCalledTimes(1);

      upsert.mockResolvedValue({});
      await service.flush();
      expect(upsert).toHaveBeenCalledTimes(2);
    });

    it('does not re-queue a failed snapshot if a fresher one arrived mid-flush', async () => {
      upsert.mockImplementationOnce(async () => {
        // A newer snapshot lands for the same import while the flush is in
        // flight — it must win over the one being re-queued.
        service.recordProgress('coach-1', {
          intent_id: 'intent-1',
          progress: [{ entity_type: 'clients', count_committed: 9, total_estimated: 10 }],
        });
        throw new Error('db blip');
      });
      service.recordProgress('coach-1', PROGRESS);
      await service.flush();

      upsert.mockResolvedValue({});
      await service.flush();
      const lastArg = upsert.mock.calls[upsert.mock.calls.length - 1][0];
      expect(lastArg.create.snapshot.progress).toEqual([
        { entity_type: 'clients', count_committed: 9, total_estimated: 10 },
      ]);
    });

    it('continues flushing remaining imports after one fails', async () => {
      upsert.mockRejectedValueOnce(new Error('db blip'));
      service.recordProgress('coach-1', PROGRESS);
      service.recordProgress('coach-2', PROGRESS);
      await service.flush();
      expect(upsert).toHaveBeenCalledTimes(2);
    });
  });

  describe('flushTick / lifecycle', () => {
    it('flushTick drains the cache', async () => {
      service.recordProgress('coach-1', PROGRESS);
      await service.flushTick();
      expect(upsert).toHaveBeenCalledTimes(1);
    });

    it('onModuleDestroy flushes anything still cached', async () => {
      service.recordProgress('coach-1', PROGRESS);
      await service.onModuleDestroy();
      expect(upsert).toHaveBeenCalledTimes(1);
    });

    it('exposes a positive flush interval constant', () => {
      expect(SCOUT_PROGRESS_FLUSH_MS).toBeGreaterThan(0);
    });
  });

  describe('complete (cold path)', () => {
    it('inserts a completion row on the first call', async () => {
      await service.complete('coach-1', COMPLETE_OK);
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('persists coach_id, intent_id, terminal_status and final_counts', async () => {
      await service.complete('coach-1', COMPLETE_OK);
      expect(create).toHaveBeenCalledWith({
        data: {
          coach_id: 'coach-1',
          intent_id: 'intent-1',
          terminal_status: 'success',
          final_counts: { clients: 10, workouts: 40 },
          error_summary: undefined,
        },
      });
    });

    it('returns an acknowledgement carrying the intent_id', async () => {
      const res = await service.complete('coach-1', COMPLETE_OK);
      expect(res).toEqual({ acknowledged: true, intent_id: 'intent-1' });
    });

    it('flushes pending progress before settling', async () => {
      service.recordProgress('coach-1', PROGRESS);
      await service.complete('coach-1', COMPLETE_OK);
      expect(upsert).toHaveBeenCalledTimes(1);
    });

    it('fires the mobile push on the first completion', async () => {
      await service.complete('coach-1', COMPLETE_OK);
      expect(pushToUser).toHaveBeenCalledTimes(1);
      expect(pushToUser).toHaveBeenCalledWith(
        'coach-1',
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          kind: 'import.complete',
          intent_id: 'intent-1',
          terminal_status: 'success',
        }),
      );
    });

    it('emits the scout.ingest.completed analytics event on the first completion', async () => {
      await service.complete('coach-1', COMPLETE_OK);
      expect(capture).toHaveBeenCalledWith('coach-1', Events.SCOUT_INGEST_COMPLETED, {
        intent_id: 'intent-1',
        terminal_status: 'success',
      });
    });

    it('uses a success-flavoured push title/body for a successful import', async () => {
      await service.complete('coach-1', COMPLETE_OK);
      const [, title, body] = pushToUser.mock.calls[0];
      expect(title).toMatch(/complete/i);
      expect(body).toMatch(/finished importing/i);
    });

    it('uses a degraded push title/body for a partial import', async () => {
      await service.complete('coach-1', {
        intent_id: 'intent-1',
        terminal_status: 'partial',
        error_summary: 'library skipped',
      });
      const [, title, body] = pushToUser.mock.calls[0];
      expect(title).toMatch(/issues/i);
      expect(body).toMatch(/some items/i);
    });

    it('uses a degraded push for a failed import', async () => {
      await service.complete('coach-1', {
        intent_id: 'intent-1',
        terminal_status: 'failed',
        error_summary: 'auth expired mid-crawl',
      });
      const [, title] = pushToUser.mock.calls[0];
      expect(title).toMatch(/issues/i);
    });
  });

  describe('complete idempotency', () => {
    it('treats a duplicate (P2002) as a no-op and does not re-notify', async () => {
      create.mockRejectedValueOnce(p2002());
      const res = await service.complete('coach-1', COMPLETE_OK);
      expect(res).toEqual({ acknowledged: true, intent_id: 'intent-1' });
      expect(pushToUser).not.toHaveBeenCalled();
    });

    it('does not re-emit analytics on a duplicate completion', async () => {
      create.mockRejectedValueOnce(p2002());
      await service.complete('coach-1', COMPLETE_OK);
      expect(capture).not.toHaveBeenCalled();
    });

    it('notifies exactly once across a first call and a retry', async () => {
      await service.complete('coach-1', COMPLETE_OK);
      create.mockRejectedValueOnce(p2002());
      await service.complete('coach-1', COMPLETE_OK);
      expect(pushToUser).toHaveBeenCalledTimes(1);
      expect(capture).toHaveBeenCalledTimes(1);
    });

    it('rethrows a non-P2002 Prisma error', async () => {
      const other = new PrismaClientKnownRequestError('connection reset', {
        code: 'P1001',
        clientVersion: '6.0.0',
      });
      create.mockRejectedValueOnce(other);
      await expect(service.complete('coach-1', COMPLETE_OK)).rejects.toBe(other);
      expect(pushToUser).not.toHaveBeenCalled();
    });

    it('rethrows a generic (non-Prisma) error', async () => {
      const boom = new Error('unexpected');
      create.mockRejectedValueOnce(boom);
      await expect(service.complete('coach-1', COMPLETE_OK)).rejects.toBe(boom);
    });
  });

  describe('complete resilience', () => {
    it('still acknowledges when the push transport fails', async () => {
      pushToUser.mockRejectedValueOnce(new Error('expo down'));
      const res = await service.complete('coach-1', COMPLETE_OK);
      expect(res).toEqual({ acknowledged: true, intent_id: 'intent-1' });
    });

    it('still emits analytics when the push transport fails', async () => {
      pushToUser.mockRejectedValueOnce(new Error('expo down'));
      await service.complete('coach-1', COMPLETE_OK);
      expect(capture).toHaveBeenCalledTimes(1);
    });

    it('omits final_counts cleanly when the extension did not send any', async () => {
      await service.complete('coach-1', {
        intent_id: 'intent-9',
        terminal_status: 'success',
      });
      expect(create).toHaveBeenCalledWith({
        data: {
          coach_id: 'coach-1',
          intent_id: 'intent-9',
          terminal_status: 'success',
          final_counts: undefined,
          error_summary: undefined,
        },
      });
    });
  });
});
