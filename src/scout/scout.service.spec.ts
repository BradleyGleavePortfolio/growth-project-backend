import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { ScoutService, SCOUT_PROGRESS_FLUSH_MS } from './scout.service';
import { ScoutCompleteDto, ScoutProgressDto } from './scout.dto';
import { ScoutLifecycleService } from './lifecycle/lifecycle.service';
import { reconcile } from './reconciliation/reconcile';
import type { FamilyFacts, ReconciliationFacts } from './reconciliation/types';

// ── Typed test doubles ────────────────────────────────────────────────────────
// Built with Object.create(<Class>.prototype) + Object.assign so each double is
// structurally the real service without a forbidden escape-hatch cast (mirrors
// src/feature-flags/__tests__/feature-flags.controller.spec.ts).

interface PrismaDoubles {
  upsert: jest.Mock;
  create: jest.Mock;
  importUpsert: jest.Mock;
  importFindUnique: jest.Mock;
  ingestGroupBy: jest.Mock;
  snapshotFindFirst: jest.Mock;
}

function makePrisma(doubles: PrismaDoubles): PrismaService {
  return Object.assign(Object.create(PrismaService.prototype) as PrismaService, {
    scoutProgressSnapshot: { upsert: doubles.upsert, findFirst: doubles.snapshotFindFirst },
    scoutImportCompletion: { create: doubles.create },
    scoutImport: { upsert: doubles.importUpsert, findUnique: doubles.importFindUnique },
    scoutIngestEntity: { groupBy: doubles.ingestGroupBy },
    // S7-L: the read projects `families[]` from the reconstruction ledger for
    // legacy and server rows alike; legacy fixtures have no ledger rows.
    scoutReconstructionLedger: { groupBy: jest.fn().mockResolvedValue([]) },
    // Batch $transaction([...]) resolves iff every op resolves; a rejected op
    // (e.g. the ledger's P2002) rejects the whole transaction, mirroring the
    // real client's all-or-nothing settle so the state upsert never lands alone.
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
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
  deviceId: 'device-a',
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
  let importUpsert: jest.Mock;
  let importFindUnique: jest.Mock;
  let ingestGroupBy: jest.Mock;
  let snapshotFindFirst: jest.Mock;
  let pushToUser: jest.Mock;
  let capture: jest.Mock;
  let prisma: PrismaService;
  let notifications: NotificationsService;
  let analytics: AnalyticsService;
  let service: ScoutService;

  beforeEach(() => {
    upsert = jest.fn().mockResolvedValue({});
    create = jest.fn().mockResolvedValue({});
    importUpsert = jest.fn().mockResolvedValue({});
    importFindUnique = jest.fn().mockResolvedValue(null);
    ingestGroupBy = jest.fn().mockResolvedValue([]);
    snapshotFindFirst = jest.fn().mockResolvedValue(null);
    pushToUser = jest.fn().mockResolvedValue({ delivered: true, code: 'delivered' });
    capture = jest.fn();
    prisma = makePrisma({
      upsert,
      create,
      importUpsert,
      importFindUnique,
      ingestGroupBy,
      snapshotFindFirst,
    });
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

    it('keys the upsert by (coach_id, intent_id, device_id)', async () => {
      service.recordProgress('coach-1', PROGRESS);
      await service.flush();
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            coach_id_intent_id_device_id: {
              coach_id: 'coach-1',
              intent_id: 'intent-1',
              device_id: 'device-a',
            },
          },
        }),
      );
    });

    it('keeps two independent rows when one import is mirrored from two devices', async () => {
      service.recordProgress('coach-1', PROGRESS);
      service.recordProgress('coach-1', { ...PROGRESS, deviceId: 'device-b' });
      await service.flush();
      expect(upsert).toHaveBeenCalledTimes(2);
    });

    it('coalesces two snapshots from the same device into one upsert', async () => {
      service.recordProgress('coach-1', PROGRESS);
      service.recordProgress('coach-1', {
        ...PROGRESS,
        progress: [{ entity_type: 'clients', count_committed: 8, total_estimated: 10 }],
      });
      await service.flush();
      expect(upsert).toHaveBeenCalledTimes(1);
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
        deviceId: 'device-a',
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
          deviceId: 'device-a',
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

    it('flips the parent import state to the terminal_status (R-STATE-1)', async () => {
      await service.complete('coach-1', COMPLETE_OK);
      expect(importUpsert).toHaveBeenCalledTimes(1);
      const arg = importUpsert.mock.calls[0][0];
      expect(arg.where).toEqual({
        coach_id_intent_id: { coach_id: 'coach-1', intent_id: 'intent-1' },
      });
      expect(arg.create.state).toBe('success');
      expect(arg.create.terminal_status).toBe('success');
      expect(arg.update.state).toBe('success');
      expect(arg.update.terminal_status).toBe('success');
    });

    it('owns the state flip and the ledger insert in a single transaction', async () => {
      await service.complete('coach-1', COMPLETE_OK);
      const tx = (prisma.$transaction as jest.Mock).mock.calls[0][0];
      expect(Array.isArray(tx)).toBe(true);
      expect(tx).toHaveLength(2);
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

    it('describes successful transport as staging rather than verified migration', async () => {
      await service.complete('coach-1', COMPLETE_OK);
      const [, title, body] = pushToUser.mock.calls[0];
      expect(title).toBe('Import transfer staged');
      expect(body).toBe(
        'Records were staged in TGP. Migration is not verified. Check the importer status.',
      );
      expect(title).not.toMatch(/complete/i);
    });

    it('uses a degraded push title/body for a partial import', async () => {
      await service.complete('coach-1', {
        intent_id: 'intent-1',
        terminal_status: 'partial',
        error_summary: 'library skipped',
      });
      const [, title, body] = pushToUser.mock.calls[0];
      expect(title).toBe('Import transfer needs attention');
      expect(body).toContain('Some records may be staged.');
      expect(body).toContain('Migration is not complete.');
      expect(body).toContain('before retrying');
    });

    it('uses a degraded push for a failed import', async () => {
      await service.complete('coach-1', {
        intent_id: 'intent-1',
        terminal_status: 'failed',
        error_summary: 'auth expired mid-crawl',
      });
      const [, title, body] = pushToUser.mock.calls[0];
      expect(title).toBe('Import transfer needs attention');
      expect(body).toContain('Some records may be staged.');
      expect(body).toContain('Migration is not complete.');
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

    it('never flips the parent state outside the ledger transaction on a duplicate', async () => {
      create.mockRejectedValueOnce(p2002());
      await service.complete('coach-1', COMPLETE_OK);
      // The state upsert only ever runs as an op inside the same $transaction as
      // the ledger insert — never on its own — so when the ledger's P2002 rolls
      // the transaction back the state is not re-flipped. Assert it was only
      // submitted as part of a batch transaction, never as a standalone commit.
      const tx = prisma.$transaction as jest.Mock;
      expect(tx).toHaveBeenCalledTimes(1);
      expect(tx.mock.calls[0][0]).toHaveLength(2);
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

  describe('complete pre-settle flush is best-effort (P3: no settle-wedge)', () => {
    it('still settles and notifies when the pre-settle snapshot flush fails', async () => {
      // A poison/unpersistable snapshot must NOT block completion: settle owns the
      // terminal state and counts come from ScoutIngestEntity, not the snapshot.
      upsert.mockRejectedValue(new Error('poison payload'));
      service.recordProgress('coach-1', PROGRESS);

      const res = await service.complete('coach-1', COMPLETE_OK);

      expect(res).toEqual({ acknowledged: true, intent_id: 'intent-1' });
      expect(create).toHaveBeenCalledTimes(1);
      expect(importUpsert).toHaveBeenCalledTimes(1);
      expect(pushToUser).toHaveBeenCalledTimes(1);
    });

    it('leaves the failed snapshot pending and retryable after settling', async () => {
      upsert.mockRejectedValueOnce(new Error('db blip'));
      service.recordProgress('coach-1', PROGRESS);
      await service.complete('coach-1', COMPLETE_OK);
      expect(upsert).toHaveBeenCalledTimes(1); // attempted once during settle, failed

      upsert.mockResolvedValue({});
      await service.flush();
      expect(upsert).toHaveBeenCalledTimes(2); // retried on a later drain and persisted
    });

    it('read still fails closed (5xx, not 404) while the bad snapshot remains pending', async () => {
      upsert.mockRejectedValue(new Error('poison payload'));
      service.recordProgress('coach-1', PROGRESS);
      await service.complete('coach-1', COMPLETE_OK); // settles despite the flush failure

      const err = await service
        .getImportStatus('coach-1', 'intent-1')
        .then(() => null)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(NotFoundException);
    });

    it('does not flush an unrelated tenant/run when settling', async () => {
      service.recordProgress('coach-2', { ...PROGRESS, intent_id: 'intent-2' });
      await service.complete('coach-1', COMPLETE_OK);
      expect(upsert).not.toHaveBeenCalled();
    });

    it('does not raise an unhandled rejection when the pre-settle flush fails', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (e: unknown): void => {
        unhandled.push(e);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        upsert.mockRejectedValue(new Error('poison payload'));
        service.recordProgress('coach-1', PROGRESS);
        await service.complete('coach-1', COMPLETE_OK);
        await new Promise((r) => setImmediate(r));
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
      expect(unhandled).toEqual([]);
    });
  });

  describe('getImportStatus (read surface)', () => {
    const STARTED = new Date('2026-07-09T10:00:00.000Z');
    const DONE = new Date('2026-07-09T10:30:00.000Z');
    const SEEN = new Date('2026-07-09T10:05:00.000Z');

    const importRow = (terminal_status: string | null, completed_at: Date | null = DONE) => ({
      started_at: STARTED,
      completed_at,
      terminal_status,
    });
    // Mirrors the real groupBy return once `_min: { created_at }` is requested;
    // the earliest _min.created_at across families is the canonical first commit
    // (clients @ STARTED here, before workouts @ DONE).
    const groups = () => [
      { entity_type: 'workouts', _count: { _all: 4 }, _min: { created_at: DONE } },
      { entity_type: 'clients', _count: { _all: 12 }, _min: { created_at: STARTED } },
    ];

    it('throws 404 when no evidence of the intent exists anywhere', async () => {
      await expect(service.getImportStatus('coach-1', 'ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('does not emit analytics for an unknown intent', async () => {
      await expect(service.getImportStatus('coach-1', 'ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(capture).not.toHaveBeenCalled();
    });

    it('drains in-flight progress before reading so a just-accepted run is not falsely 404d', async () => {
      // A snapshot the extension has already POSTed but that has not yet hit its
      // flush tick lives only in the in-process cache. The read must persist it
      // first (the same drain complete() runs) so a genuinely running import is
      // recognised instead of 404'd on the accepted-but-unflushed window.
      service.recordProgress('coach-1', PROGRESS);
      // Model the drain landing the row so the subsequent snapshot read sees it.
      upsert.mockImplementation(async () => {
        snapshotFindFirst.mockResolvedValue({ updated_at: SEEN });
        return {};
      });
      const res = await service.getImportStatus('coach-1', 'intent-1');
      expect(upsert).toHaveBeenCalledTimes(1);
      expect(res.status).toBe('running');
    });

    it('reports running when committed entities exist but no terminal row does', async () => {
      ingestGroupBy.mockResolvedValue(groups());
      const res = await service.getImportStatus('coach-1', 'intent-1');
      expect(res.status).toBe('running');
      expect(res.completed_at).toBeNull();
    });

    it('never exposes completed_at while running, even if the row carries a stray one', async () => {
      // An in-progress lifecycle row (terminal_status null) must project running
      // and suppress completed_at regardless of any value the row happens to hold.
      importFindUnique.mockResolvedValue(importRow(null, DONE));
      ingestGroupBy.mockResolvedValue(groups());
      const res = await service.getImportStatus('coach-1', 'intent-1');
      expect(res.status).toBe('running');
      expect(res.completed_at).toBeNull();
    });

    it('reports running from a progress snapshot alone (no entities, no settle)', async () => {
      snapshotFindFirst.mockResolvedValue({ updated_at: SEEN });
      const res = await service.getImportStatus('coach-1', 'intent-1');
      expect(res.status).toBe('running');
      expect(res.started_at).toBe(SEEN.toISOString());
    });

    it('reflects a settled success verbatim, preferring its started_at over the snapshot', async () => {
      importFindUnique.mockResolvedValue(importRow('success'));
      snapshotFindFirst.mockResolvedValue({ updated_at: SEEN });
      const res = await service.getImportStatus('coach-1', 'intent-1');
      expect(res.status).toBe('success');
      expect(res.started_at).toBe(STARTED.toISOString());
      expect(res.completed_at).toBe(DONE.toISOString());
    });

    it.each(['partial', 'failed'] as const)('reflects a settled %s verbatim', async (s) => {
      importFindUnique.mockResolvedValue(importRow(s));
      expect((await service.getImportStatus('coach-1', 'intent-1')).status).toBe(s);
    });

    it('fails closed to failed (not running) on an unrecognised stored terminal_status', async () => {
      importFindUnique.mockResolvedValue(importRow('exploded'));
      const res = await service.getImportStatus('coach-1', 'intent-1');
      // A settled-but-corrupt row must never be reported as still running.
      expect(res.status).toBe('failed');
      // It is genuinely settled, so completed_at reflects the real settle time.
      expect(res.completed_at).toBe(DONE.toISOString());
    });

    it('emits an observable RED corruption signal (no offending value) when failing closed', async () => {
      importFindUnique.mockResolvedValue(importRow('exploded'));
      await service.getImportStatus('coach-1', 'intent-1');
      expect(capture).toHaveBeenCalledWith('coach-1', Events.SCOUT_IMPORT_STATUS_INVALID, {
        intent_id: 'intent-1',
      });
      const invalidCall = capture.mock.calls.find(
        (c) => c[1] === Events.SCOUT_IMPORT_STATUS_INVALID,
      );
      // Only intent_id — never the corrupt status string, tokens, or PII.
      expect(Object.keys(invalidCall![2])).toEqual(['intent_id']);
    });

    it('does not raise the corruption signal for a recognised terminal state', async () => {
      importFindUnique.mockResolvedValue(importRow('partial'));
      await service.getImportStatus('coach-1', 'intent-1');
      expect(capture).not.toHaveBeenCalledWith(
        'coach-1',
        Events.SCOUT_IMPORT_STATUS_INVALID,
        expect.anything(),
      );
    });

    it('derives started_at from the earliest committed entity (stable first observation)', async () => {
      ingestGroupBy.mockResolvedValue(groups());
      const res = await service.getImportStatus('coach-1', 'intent-1');
      // Earliest _min.created_at across families (STARTED < DONE), NOT the
      // latest snapshot and NOT the settle-time import row.
      expect(res.started_at).toBe(STARTED.toISOString());
    });

    it('prefers the first committed entity over the import row start on a settled run', async () => {
      const laterStart = new Date('2026-07-09T11:00:00.000Z');
      importFindUnique.mockResolvedValue({
        started_at: laterStart,
        completed_at: DONE,
        terminal_status: 'success',
      });
      ingestGroupBy.mockResolvedValue(groups());
      const res = await service.getImportStatus('coach-1', 'intent-1');
      // The committed-entity timestamp (STARTED) is earlier and canonical, so it
      // wins over the import row's created-at-settle started_at.
      expect(res.started_at).toBe(STARTED.toISOString());
    });

    it('exposes committed counts (proof), sorted, and never an estimate field', async () => {
      ingestGroupBy.mockResolvedValue(groups());
      const res = await service.getImportStatus('coach-1', 'intent-1');
      expect(res.entity_counts).toEqual([
        { entity_type: 'clients', committed: 12 },
        { entity_type: 'workouts', committed: 4 },
      ]);
      const keys = new Set(res.entity_counts.flatMap((c) => Object.keys(c)));
      expect(keys).toEqual(new Set(['entity_type', 'committed']));
    });

    it('scopes every read by the caller coach id (IDOR / tenant ownership)', async () => {
      ingestGroupBy.mockResolvedValue(groups());
      await service.getImportStatus('coach-9', 'intent-1');
      expect(importFindUnique.mock.calls[0][0].where).toEqual({
        coach_id_intent_id: { coach_id: 'coach-9', intent_id: 'intent-1' },
      });
      expect(ingestGroupBy.mock.calls[0][0].where).toEqual({
        coach_id: 'coach-9',
        intent_id: 'intent-1',
      });
      expect(snapshotFindFirst.mock.calls[0][0].where).toEqual({
        coach_id: 'coach-9',
        intent_id: 'intent-1',
      });
    });

    it('emits a RED-signal event carrying only intent_id + status (no PII)', async () => {
      importFindUnique.mockResolvedValue(importRow('success'));
      await service.getImportStatus('coach-1', 'intent-1');
      expect(capture).toHaveBeenCalledWith('coach-1', Events.SCOUT_IMPORT_STATUS_READ, {
        intent_id: 'intent-1',
        status: 'success',
      });
      expect(Object.keys(capture.mock.calls[0][2]).sort()).toEqual(['intent_id', 'status']);
    });

    it('returns only the declared safe shape — no tokens, payloads, or free-text error', async () => {
      importFindUnique.mockResolvedValue(importRow('failed'));
      ingestGroupBy.mockResolvedValue(groups());
      const res = await service.getImportStatus('coach-1', 'intent-1');
      expect(Object.keys(res).sort()).toEqual([
        'accepted_start_at',
        'claimed_status',
        'completed_at',
        'deadline_at',
        'entity_counts',
        'execution_epoch',
        'families',
        'intent_id',
        'last_observed_at',
        'mode',
        'phase',
        'reason_code',
        'started_at',
        'status',
      ]);
      // S7-L §7: a legacy row projects the additive fields as the legacy constants.
      expect(res).toMatchObject({
        mode: 'legacy',
        phase: null,
        accepted_start_at: null,
        deadline_at: null,
        last_observed_at: null,
        execution_epoch: 1,
        claimed_status: 'failed',
        reason_code: null,
      });
      expect(res.families).toEqual([
        {
          family: 'clients',
          observed_unique: null,
          staged_unique: 12,
          created_native: null,
          already_present_verified: null,
          rejected: null,
          unresolved: null,
          ledger: { reconstructed: 0, skipped: 0, failed: 0 },
        },
        {
          family: 'workouts',
          observed_unique: null,
          staged_unique: 4,
          created_native: null,
          already_present_verified: null,
          rejected: null,
          unresolved: null,
          ledger: { reconstructed: 0, skipped: 0, failed: 0 },
        },
      ]);
    });
  });

  describe('getImportStatus — S9-C reconciliation report composition (D-S9-5, R13, R15)', () => {
    const SERVER_INTENT = '3f2b9c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
    const STARTED = new Date('2026-09-25T10:00:00.000Z');
    const DONE = new Date('2026-09-25T10:30:00.000Z');
    const serverRow = (terminal_status: string | null, reason_code: string | null) => ({
      mode: 'server',
      import_intent_id: SERVER_INTENT,
      phase: 'reconciling',
      accepted_start_at: STARTED,
      deadline_at: new Date(STARTED.getTime() + 300_000),
      last_observed_at: STARTED,
      execution_epoch: 1,
      fenced_at: null,
      fence_reason: null,
      reason_code,
      terminal_status,
      completed_at: terminal_status ? DONE : null,
      started_at: STARTED,
    });
    const family = (
      name: string,
      token: string,
      n: number,
      over: Partial<FamilyFacts> = {},
    ): FamilyFacts => ({
      family: name,
      mapped: true,
      resolution_reason: null,
      client_owned: false,
      ceiling_exceeded: false,
      identities: Array.from({ length: n }, (_, i) => ({
        token,
        identity: `p\u001f${token}-${i}`,
        ledger:
          i % 2 === 0
            ? {
                status: 'reconstructed' as const,
                target_kind: 'workout_plan' as const,
                provenance: {
                  outcome: 'created' as const,
                  native: 'present_owned' as const,
                  reason: null,
                  unresolved_children: {},
                },
              }
            : { status: 'skipped' as const, reason: 'unresolved:missing_required_field:name' },
        client_linked: false,
      })),
      ledger_without_staged: 0,
      qualifiers: [],
      ...over,
    });
    const factsOf = (families: FamilyFacts[]): ReconciliationFacts => ({
      claim: 'success',
      families,
      relationships: [],
      spec_families: families.filter((f) => f.mapped).map((f) => f.family),
      ledger_without_staged: 0,
      coverage: null,
    });

    /**
     * A lifecycle double: the real static projections, the instance reads stubbed. `readReport`
     * is the seam under test — the service must call it with the run row and hand the report to
     * `projectFamilies` (R15), and never call it for a legacy row (R13).
     */
    const lifecycleDouble = (
      row: ReturnType<typeof serverRow> | null,
      report: unknown,
      ledger: Record<string, { reconstructed: number; skipped: number; failed: number }> = {
        routines: { reconstructed: 1, skipped: 1, failed: 0 },
      },
    ) => {
      const readReport = jest.fn().mockResolvedValue(report);
      const lifecycle = Object.assign(
        Object.create(ScoutLifecycleService.prototype) as ScoutLifecycleService,
        {
          resolve: jest
            .fn()
            .mockResolvedValue(
              row ? { mode: 'server', intent: { id: SERVER_INTENT } } : { mode: 'legacy' },
            ),
          readRun: jest.fn().mockResolvedValue(row),
          enforceDeadline: jest.fn().mockResolvedValue(row),
          readClaim: jest.fn().mockResolvedValue('success'),
          readLedger: jest.fn().mockResolvedValue(ledger),
          readReport,
        },
      );
      return { lifecycle, readReport };
    };

    it('R15: a settled server run with a live S9 code carries the recomputed report in families[]', async () => {
      const row = serverRow('partial', 'unresolved_identities');
      const facts = factsOf([family('workouts', 'routines', 2)]);
      const report = reconcile(facts).report;
      const { lifecycle, readReport } = lifecycleDouble(row, report);
      importFindUnique.mockResolvedValue(row);
      ingestGroupBy.mockResolvedValue([
        { entity_type: 'routines', _count: { _all: 2 }, _min: { created_at: STARTED } },
      ]);
      const svc = new ScoutService(prisma, notifications, analytics, lifecycle);
      const res = await svc.getImportStatus('coach-1', SERVER_INTENT);
      expect(readReport).toHaveBeenCalledTimes(1);
      expect(readReport).toHaveBeenCalledWith('coach-1', SERVER_INTENT, row);
      expect(res).toMatchObject({
        status: 'partial',
        mode: 'server',
        reason_code: 'unresolved_identities',
        claimed_status: 'success',
      });
      expect(res.families).toEqual(
        ScoutLifecycleService.projectFamilies(
          [{ entity_type: 'routines', _count: { _all: 2 } }],
          { routines: { reconstructed: 1, skipped: 1, failed: 0 } },
          report,
        ),
      );
      expect(res.families[0]).toMatchObject({
        family: 'routines',
        canonical_family: 'workouts',
        staged_unique: 2,
        native_present_verified: 1,
        unresolved: 1,
        rejected: 0,
        created_native: null,
        already_present_verified: null,
        observed_unique: null,
        completeness_basis: 'none',
        relationship_closure: 'not_applicable',
        reasons: [{ code: 'unresolved:missing_required_field:name', count: 1 }],
        qualifiers: [],
      });
      // The top-level key set is unchanged: the S9 fields live inside families[] only.
      expect(Object.keys(res).sort()).toEqual([
        'accepted_start_at',
        'claimed_status',
        'completed_at',
        'deadline_at',
        'entity_counts',
        'execution_epoch',
        'families',
        'intent_id',
        'last_observed_at',
        'mode',
        'phase',
        'reason_code',
        'started_at',
        'status',
      ]);
    });

    it('R15: when the lifecycle reports no applicable report (open run / pre-S9 terminal) the entries keep the S7-L shape', async () => {
      for (const row of [
        serverRow(null, null),
        serverRow('partial', 'reconciliation_not_performed'),
      ]) {
        const { lifecycle, readReport } = lifecycleDouble(row, null);
        importFindUnique.mockResolvedValue(row);
        ingestGroupBy.mockResolvedValue([
          { entity_type: 'routines', _count: { _all: 2 }, _min: { created_at: STARTED } },
        ]);
        const svc = new ScoutService(prisma, notifications, analytics, lifecycle);
        const res = await svc.getImportStatus('coach-1', SERVER_INTENT);
        expect(readReport).toHaveBeenCalledWith('coach-1', SERVER_INTENT, row);
        expect(res.families).toEqual([
          {
            family: 'routines',
            observed_unique: null,
            staged_unique: 2,
            created_native: null,
            already_present_verified: null,
            rejected: null,
            unresolved: null,
            ledger: { reconstructed: 1, skipped: 1, failed: 0 },
          },
        ]);
      }
    });

    it('R13: a legacy row never asks for a report and its families[] are byte-identical to S7-L', async () => {
      const { lifecycle, readReport } = lifecycleDouble(null, null);
      importFindUnique.mockResolvedValue({
        started_at: STARTED,
        completed_at: DONE,
        terminal_status: 'success',
      });
      ingestGroupBy.mockResolvedValue([
        { entity_type: 'routines', _count: { _all: 2 }, _min: { created_at: STARTED } },
      ]);
      const svc = new ScoutService(prisma, notifications, analytics, lifecycle);
      const res = await svc.getImportStatus('coach-1', 'intent-1');
      expect(readReport).not.toHaveBeenCalled();
      expect(res.mode).toBe('legacy');
      expect(res.families).toEqual([
        {
          family: 'routines',
          observed_unique: null,
          staged_unique: 2,
          created_native: null,
          already_present_verified: null,
          rejected: null,
          unresolved: null,
          ledger: { reconstructed: 1, skipped: 1, failed: 0 },
        },
      ]);
    });

    it('R15 / E2 bound: a 32-family status body with full histograms and 128-character tokens stays within 64 KiB', async () => {
      const row = serverRow('partial', 'unresolved_family');
      const tokens = Array.from(
        { length: 32 },
        (_, i) => `${String(i).padStart(3, '0')}-${'t'.repeat(124)}`,
      );
      // Every family carries its own token, a mixed identity set and the widest v1 histogram the
      // classifier can emit for a mapped family (bucket j, skipped-with-qualifier, failed, evidence,
      // missing provenance, conflicts) plus the qualifier.
      const wide = (name: string, token: string): FamilyFacts => {
        const base = family(name, token, 6, { qualifiers: ['roster_bridge_pending'] });
        const reasons = [
          'unresolved:missing_required_field:name',
          'unresolved:invalid_value:duration_estimate_minutes',
          'unresolved:enum_unmapped:type',
          'unresolved:prescription_not_integral:reps',
          'unresolved:relationship_pending:programs',
          'unresolved:relationship_missing:programs',
          'unresolved:native_uniqueness:WorkoutPlan',
          'unresolved:no_native_client_principal',
          'unresolved:source_archived',
          'unresolved:identity_conflict',
          'unresolved:native_target_removed',
          'unresolved:exercise_reference',
        ];
        return {
          ...base,
          identities: [
            ...base.identities,
            ...reasons.map((reason, i) => ({
              token,
              identity: `p\u001f${token}-r${i}`,
              ledger: { status: 'skipped' as const, reason },
              client_linked: false,
            })),
            {
              token,
              identity: `p\u001f${token}-f`,
              ledger: { status: 'failed' as const },
              client_linked: false,
            },
          ],
        };
      };
      const facts = factsOf(tokens.map((token, i) => wide(`family_${i}`, token)));
      const report = reconcile(facts).report;
      // The ledger is keyed by the SAME 32 tokens: the S7-L projection lists every ledger-only
      // token as its own entry (ledger_without_staged), so a stray key would add a 33rd row.
      const { lifecycle } = lifecycleDouble(
        row,
        report,
        Object.fromEntries(tokens.map((t) => [t, { reconstructed: 3, skipped: 15, failed: 1 }])),
      );
      importFindUnique.mockResolvedValue(row);
      ingestGroupBy.mockResolvedValue(
        tokens.map((token) => ({
          entity_type: token,
          _count: { _all: 19 },
          _min: { created_at: STARTED },
        })),
      );
      const svc = new ScoutService(prisma, notifications, analytics, lifecycle);
      const res = await svc.getImportStatus('coach-1', SERVER_INTENT);
      expect(res.families).toHaveLength(32);
      for (const entry of res.families) {
        expect(entry.reasons?.length).toBeGreaterThanOrEqual(13);
        expect(entry.qualifiers).toEqual(['roster_bridge_pending']);
      }
      const bytes = Buffer.byteLength(JSON.stringify(res), 'utf8');
      expect(bytes).toBeLessThanOrEqual(64 * 1024);
    });
  });

  describe('getImportStatus concurrency + tenant isolation (key-scoped flush)', () => {
    // Deferred so two reads can be launched while a requested-key write is in
    // flight; resolve() lets the pending upsert(s) complete.
    function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    it('does not touch an unrelated tenant/run backlog on a read (no global drain)', async () => {
      // coach-2/intent-2 progress is cached but must NOT be persisted by a read
      // of coach-1/intent-1 — the read drains only its own run's key(s).
      service.recordProgress('coach-2', { ...PROGRESS, intent_id: 'intent-2' });

      await expect(service.getImportStatus('coach-1', 'intent-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(upsert).not.toHaveBeenCalled();

      // The unrelated backlog survives and drains normally on the next tick.
      await service.flush();
      expect(upsert).toHaveBeenCalledTimes(1);
      expect(upsert.mock.calls[0][0].where.coach_id_intent_id_device_id).toEqual({
        coach_id: 'coach-2',
        intent_id: 'intent-2',
        device_id: 'device-a',
      });
    });

    it('coalesces two concurrent reads onto one in-flight write (no double write, no false 404)', async () => {
      service.recordProgress('coach-1', PROGRESS);
      const gate = deferred<Record<string, never>>();
      let calls = 0;
      upsert.mockImplementation(async () => {
        calls += 1;
        await gate.promise;
        // The just-persisted snapshot becomes readable, so both reads see running.
        snapshotFindFirst.mockResolvedValue({ updated_at: new Date('2026-07-09T10:05:00.000Z') });
        return {};
      });

      const first = service.getImportStatus('coach-1', 'intent-1');
      const second = service.getImportStatus('coach-1', 'intent-1');
      gate.resolve({} as Record<string, never>);
      const [a, b] = await Promise.all([first, second]);

      expect(calls).toBe(1); // single-flight: exactly one upsert for the key
      expect(a.status).toBe('running');
      expect(b.status).toBe('running');
    });

    it('fails closed (propagates, not a 404) when the requested-key persist fails', async () => {
      service.recordProgress('coach-1', PROGRESS);
      upsert.mockRejectedValueOnce(new Error('db down'));

      const err = await service
        .getImportStatus('coach-1', 'intent-1')
        .then(() => null)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(NotFoundException);
      expect((err as Error).message).toBe('db down');
      // The main projection reads never ran — we failed before them.
      expect(importFindUnique).not.toHaveBeenCalled();
    });

    it('recovers on retry after a requested-key persist failure (snapshot stays pending)', async () => {
      service.recordProgress('coach-1', PROGRESS);
      upsert.mockRejectedValueOnce(new Error('db blip'));

      await expect(service.getImportStatus('coach-1', 'intent-1')).rejects.toThrow('db blip');

      // Second read: the write now succeeds and lands a snapshot → running.
      upsert.mockImplementation(async () => {
        snapshotFindFirst.mockResolvedValue({ updated_at: new Date('2026-07-09T10:05:00.000Z') });
        return {};
      });
      const res = await service.getImportStatus('coach-1', 'intent-1');
      expect(upsert).toHaveBeenCalledTimes(2);
      expect(res.status).toBe('running');
    });

    it('drops the run from the pending index once its key persists (no repeat write)', async () => {
      service.recordProgress('coach-1', PROGRESS);
      snapshotFindFirst.mockResolvedValue({ updated_at: new Date('2026-07-09T10:05:00.000Z') });
      await service.getImportStatus('coach-1', 'intent-1');
      expect(upsert).toHaveBeenCalledTimes(1);

      // A second read finds nothing pending for the run → no further write.
      await service.getImportStatus('coach-1', 'intent-1');
      expect(upsert).toHaveBeenCalledTimes(1);
    });
  });
});
