import { Test, TestingModule } from '@nestjs/testing';
import {
  WearableProcessedEventPruneService,
  DEFAULT_WEARABLE_PROCESSED_EVENT_RETENTION_DAYS,
  resolveRetentionDays,
} from '../../../src/wearables/maintenance/wearable-processed-event-prune.service';
import { PrismaService } from '../../../src/prisma.service';

// WearableProcessedEvent retention-prune worker tests. The worker bounds the
// growth of the webhook-idempotency ledger by deleting rows whose processed_at
// is older than the configured retention window. These tests pin:
//
//   - Cutoff arithmetic: cutoff = now - retentionDays * 86_400_000 ms.
//   - The deleteMany call shape: where.processed_at.lt === cutoff.
//   - The return shape: { deleted, cutoff } where deleted echoes Prisma's count.
//   - Boundary windows: retention=0 prunes everything strictly before now;
//     retention=999999 pushes the cutoff far into the past so nothing matches.
//   - Env resolution: default 30, honors 0, falls back on blank/garbage/negative.
//
// The PrismaService dependency is supplied through Nest's DI container via
// Test.createTestingModule().overrideProvider(...).useValue(...). The override
// value is typed as `unknown` at the DI boundary, so a structural mock exposing
// only the surface the service touches (`wearableProcessedEvent.deleteMany`)
// satisfies the provider without any cast — the same idiom the rest of this
// repo's service specs use (see test/timeline.service.spec.ts,
// test/sub-coach-*.service.spec.ts).

const DAY_MS = 86_400_000;

interface PrunePrismaHarness {
  service: WearableProcessedEventPruneService;
  deleteMany: jest.Mock;
}

// Builds the service against an overridden PrismaService whose
// wearableProcessedEvent.deleteMany resolves to { count: 7 }. Returns the
// service plus the deleteMany mock so tests can assert call shape.
async function buildPrisma(): Promise<PrunePrismaHarness> {
  const deleteMany = jest.fn(async () => ({ count: 7 }));
  const module: TestingModule = await Test.createTestingModule({
    providers: [WearableProcessedEventPruneService, PrismaService],
  })
    .overrideProvider(PrismaService)
    .useValue({ wearableProcessedEvent: { deleteMany } })
    .compile();

  const service = module.get<WearableProcessedEventPruneService>(
    WearableProcessedEventPruneService,
  );
  return { service, deleteMany };
}

describe('WearableProcessedEventPruneService', () => {
  const ORIGINAL_ENV = process.env.WEARABLE_PROCESSED_EVENT_RETENTION_DAYS;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.WEARABLE_PROCESSED_EVENT_RETENTION_DAYS;
    } else {
      process.env.WEARABLE_PROCESSED_EVENT_RETENTION_DAYS = ORIGINAL_ENV;
    }
    jest.clearAllMocks();
  });

  describe('resolveRetentionDays', () => {
    it('defaults to 30 when unset', () => {
      expect(resolveRetentionDays({})).toBe(30);
      expect(DEFAULT_WEARABLE_PROCESSED_EVENT_RETENTION_DAYS).toBe(30);
    });

    it('honors an explicit numeric value, including 0', () => {
      expect(
        resolveRetentionDays({ WEARABLE_PROCESSED_EVENT_RETENTION_DAYS: '7' }),
      ).toBe(7);
      expect(
        resolveRetentionDays({ WEARABLE_PROCESSED_EVENT_RETENTION_DAYS: '0' }),
      ).toBe(0);
    });

    it('falls back to the default on blank, non-numeric, or negative input', () => {
      expect(
        resolveRetentionDays({ WEARABLE_PROCESSED_EVENT_RETENTION_DAYS: '' }),
      ).toBe(30);
      expect(
        resolveRetentionDays({
          WEARABLE_PROCESSED_EVENT_RETENTION_DAYS: 'abc',
        }),
      ).toBe(30);
      expect(
        resolveRetentionDays({ WEARABLE_PROCESSED_EVENT_RETENTION_DAYS: '-5' }),
      ).toBe(30);
    });
  });

  describe('prune', () => {
    it('computes cutoff = now - retentionDays days (default 30) and passes it to deleteMany', async () => {
      delete process.env.WEARABLE_PROCESSED_EVENT_RETENTION_DAYS;
      const { service, deleteMany } = await buildPrisma();

      const now = new Date('2026-01-31T04:00:00.000Z');
      const result = await service.prune(now);

      const expectedCutoff = new Date(now.getTime() - 30 * DAY_MS);
      expect(deleteMany).toHaveBeenCalledTimes(1);
      expect(deleteMany).toHaveBeenCalledWith({
        where: { processed_at: { lt: expectedCutoff } },
      });
      expect(result.cutoff.getTime()).toBe(expectedCutoff.getTime());
      expect(result.deleted).toBe(7);
    });

    it('honors a custom retention window from the environment', async () => {
      process.env.WEARABLE_PROCESSED_EVENT_RETENTION_DAYS = '14';
      const { service, deleteMany } = await buildPrisma();

      const now = new Date('2026-01-31T04:00:00.000Z');
      const { cutoff } = await service.prune(now);

      const expectedCutoff = new Date(now.getTime() - 14 * DAY_MS);
      expect(cutoff.getTime()).toBe(expectedCutoff.getTime());
      expect(deleteMany.mock.calls[0][0].where.processed_at.lt.getTime()).toBe(
        expectedCutoff.getTime(),
      );
    });

    it('retention=0 prunes everything strictly before now (cutoff === now)', async () => {
      process.env.WEARABLE_PROCESSED_EVENT_RETENTION_DAYS = '0';
      const { service, deleteMany } = await buildPrisma();

      const now = new Date('2026-01-31T04:00:00.000Z');
      const { cutoff } = await service.prune(now);

      expect(cutoff.getTime()).toBe(now.getTime());
      expect(deleteMany.mock.calls[0][0].where.processed_at.lt.getTime()).toBe(
        now.getTime(),
      );
    });

    it('retention=999999 pushes the cutoff far into the past so nothing is pruned', async () => {
      process.env.WEARABLE_PROCESSED_EVENT_RETENTION_DAYS = '999999';
      const { service, deleteMany } = await buildPrisma();

      const now = new Date('2026-01-31T04:00:00.000Z');
      const { cutoff } = await service.prune(now);

      const expectedCutoff = new Date(now.getTime() - 999999 * DAY_MS);
      expect(cutoff.getTime()).toBe(expectedCutoff.getTime());
      // Cutoff is far before any plausible processed_at, so the lt filter
      // matches nothing in practice — the call shape is still a single
      // deleteMany with the correct cutoff.
      expect(cutoff.getTime()).toBeLessThan(now.getTime());
      expect(deleteMany.mock.calls[0][0].where.processed_at.lt.getTime()).toBe(
        expectedCutoff.getTime(),
      );
    });
  });
});
