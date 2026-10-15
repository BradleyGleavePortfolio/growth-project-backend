import { WearableMetricBucket } from '@prisma/client';
import {
  InsightCacheService,
  INSIGHT_WINDOW_DAYS,
  INSIGHT_TTL_MS,
} from './insight-cache.service';
import type { PrismaService } from '../../prisma.service';
import { CoachInsight } from './insight-output.schema';

// PR-HK-4 insight-cache contract tests. The prisma row is held in a tiny
// in-memory store keyed by the compound-unique selector so get-after-set
// and invalidate-then-get behave like the real upsert/delete.

interface Row {
  user_id: string;
  side: string;
  bucket: WearableMetricBucket;
  window_days: number;
  payload: unknown;
  model_used: string;
  prompt_version: string;
  generated_at: Date;
  expires_at: Date;
}

function keyOf(uid: string, side: string, bucket: string, win: number): string {
  return `${uid}|${side}|${bucket}|${win}`;
}

function makePrismaMock() {
  const store = new Map<string, Row>();
  const selKey = (where: any) => {
    const k = where.WearableInsight_subject_side_bucket_window_key;
    return keyOf(k.user_id, k.side, k.bucket, k.window_days);
  };
  return {
    store,
    wearableInsightCache: {
      findUnique: jest.fn(async ({ where }: any) => store.get(selKey(where)) ?? null),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const k = selKey(where);
        const existing = store.get(k);
        if (existing) {
          store.set(k, { ...existing, ...update });
        } else {
          store.set(k, { ...create });
        }
        return store.get(k);
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        let count = 0;
        for (const [k, row] of store) {
          if (row.user_id === where.user_id) {
            store.delete(k);
            count++;
          }
        }
        return { count };
      }),
    },
  };
}

const USER = '11111111-1111-1111-1111-111111111111';
const COACH = '33333333-3333-3333-3333-333333333333';
const NEW_COACH = '44444444-4444-4444-4444-444444444444';
const META = { modelUsed: 'stub', promptVersion: 'coach-sr-v1' };
const BUCKET = WearableMetricBucket.SLEEP_RECOVERY;

function coachPayload(): CoachInsight {
  return {
    observation: 'HRV trending down over the last week.',
    hypothesis: 'Likely accumulated training load with short sleep.',
    suggested_action: 'Suggest an earlier bedtime and a lighter session.',
    suggested_message_draft: 'Your recovery looks a little low this week. Lets pull tonights session back and aim for an earlier night.',
    confidence_level: 'fairly_sure',
    source_metrics: ['HRV_MS', 'SLEEP_TOTAL_MIN'],
  };
}

describe('InsightCacheService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let svc: InsightCacheService;

  beforeEach(() => {
    prisma = makePrismaMock();
    svc = new InsightCacheService(prisma as unknown as PrismaService);
  });

  it('get returns null on a cold cache', async () => {
    expect(await svc.get('coach', USER, BUCKET, COACH)).toBeNull();
  });

  it('get-after-set returns the stored payload', async () => {
    const payload = coachPayload();
    await svc.set('coach', USER, BUCKET, payload, META, COACH);
    const got = await svc.get('coach', USER, BUCKET, COACH);
    expect(got).toEqual(payload);
  });

  it('stamps a 6h expiry and the fixed window on set', async () => {
    const before = Date.now();
    await svc.set('coach', USER, BUCKET, coachPayload(), META, COACH);
    const row = [...prisma.store.values()][0];
    expect(row.window_days).toBe(INSIGHT_WINDOW_DAYS);
    const ttl = row.expires_at.getTime() - row.generated_at.getTime();
    expect(ttl).toBe(INSIGHT_TTL_MS);
    expect(row.expires_at.getTime()).toBeGreaterThanOrEqual(before + INSIGHT_TTL_MS - 50);
  });

  it('get returns null once the row has expired (TTL elapsed)', async () => {
    await svc.set('coach', USER, BUCKET, coachPayload(), META, COACH);
    // Force expiry into the past.
    const row = [...prisma.store.values()][0];
    row.expires_at = new Date(Date.now() - 1000);
    expect(await svc.get('coach', USER, BUCKET, COACH)).toBeNull();
  });

  it('getEvenIfStale returns an expired payload (timeout fallback path)', async () => {
    await svc.set('coach', USER, BUCKET, coachPayload(), META, COACH);
    const row = [...prisma.store.values()][0];
    row.expires_at = new Date(Date.now() - 1000);
    expect(await svc.get('coach', USER, BUCKET, COACH)).toBeNull();
    const stale = await svc.getEvenIfStale('coach', USER, BUCKET, COACH);
    expect(stale).toEqual(coachPayload());
  });

  it('invalidate makes a subsequent get return null', async () => {
    await svc.set('coach', USER, BUCKET, coachPayload(), META, COACH);
    expect(await svc.get('coach', USER, BUCKET, COACH)).not.toBeNull();
    await svc.invalidate(USER);
    expect(await svc.get('coach', USER, BUCKET, COACH)).toBeNull();
    expect(await svc.getEvenIfStale('coach', USER, BUCKET, COACH)).toBeNull();
  });

  it('coach and client sides are isolated by the side discriminator', async () => {
    await svc.set('coach', USER, BUCKET, coachPayload(), META, COACH);
    // A client-side get must NOT see the coach-side row.
    expect(await svc.get('client', USER, BUCKET)).toBeNull();
    expect(prisma.store.size).toBe(1);
  });

  // Owner 4 (A1H): a coach-side row is keyed by coach and client, so an
  // insight cached for the old coach is never served to the new coach after a
  // move, fresh or stale. The new coach gets a miss and their own row.
  describe('coach-side rows are keyed by coach and client', () => {
    it('stores the coach side under the coach it was made for', async () => {
      await svc.set('coach', USER, BUCKET, coachPayload(), META, COACH);
      const row = [...prisma.store.values()][0];
      expect(row.user_id).toBe(USER);
      expect(row.side).toBe(`coach:${COACH}`);
    });

    it('another coach gets a miss for the old coach row, fresh or stale', async () => {
      await svc.set('coach', USER, BUCKET, coachPayload(), META, COACH);
      expect(await svc.get('coach', USER, BUCKET, NEW_COACH)).toBeNull();
      expect(await svc.getEvenIfStale('coach', USER, BUCKET, NEW_COACH)).toBeNull();
      const row = [...prisma.store.values()][0];
      row.expires_at = new Date(Date.now() - 1000);
      expect(await svc.getEvenIfStale('coach', USER, BUCKET, NEW_COACH)).toBeNull();
    });

    it('a row stored before the coach key (side coach) is never served', async () => {
      prisma.store.set(keyOf(USER, 'coach', BUCKET, INSIGHT_WINDOW_DAYS), {
        user_id: USER,
        side: 'coach',
        bucket: BUCKET,
        window_days: INSIGHT_WINDOW_DAYS,
        payload: coachPayload(),
        model_used: 'stub',
        prompt_version: 'coach-sr-v1',
        generated_at: new Date(),
        expires_at: new Date(Date.now() + INSIGHT_TTL_MS),
      });
      for (const coach of [COACH, NEW_COACH]) {
        expect(await svc.get('coach', USER, BUCKET, coach)).toBeNull();
        expect(await svc.getEvenIfStale('coach', USER, BUCKET, coach)).toBeNull();
      }
    });

    it('the coach side refuses to read or write without a coach id', async () => {
      await expect(svc.get('coach', USER, BUCKET)).rejects.toThrow(/coach id/);
      await expect(svc.getEvenIfStale('coach', USER, BUCKET)).rejects.toThrow(/coach id/);
      await expect(svc.set('coach', USER, BUCKET, coachPayload(), META)).rejects.toThrow(
        /coach id/,
      );
      expect(prisma.wearableInsightCache.findUnique).not.toHaveBeenCalled();
      expect(prisma.wearableInsightCache.upsert).not.toHaveBeenCalled();
    });
  });
});
