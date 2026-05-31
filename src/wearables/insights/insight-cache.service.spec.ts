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
    expect(await svc.get('coach', USER, BUCKET)).toBeNull();
  });

  it('get-after-set returns the stored payload', async () => {
    const payload = coachPayload();
    await svc.set('coach', USER, BUCKET, payload, {
      modelUsed: 'stub',
      promptVersion: 'coach-sr-v1',
    });
    const got = await svc.get('coach', USER, BUCKET);
    expect(got).toEqual(payload);
  });

  it('stamps a 6h expiry and the fixed window on set', async () => {
    const before = Date.now();
    await svc.set('coach', USER, BUCKET, coachPayload(), {
      modelUsed: 'stub',
      promptVersion: 'coach-sr-v1',
    });
    const row = [...prisma.store.values()][0];
    expect(row.window_days).toBe(INSIGHT_WINDOW_DAYS);
    const ttl = row.expires_at.getTime() - row.generated_at.getTime();
    expect(ttl).toBe(INSIGHT_TTL_MS);
    expect(row.expires_at.getTime()).toBeGreaterThanOrEqual(before + INSIGHT_TTL_MS - 50);
  });

  it('get returns null once the row has expired (TTL elapsed)', async () => {
    await svc.set('coach', USER, BUCKET, coachPayload(), {
      modelUsed: 'stub',
      promptVersion: 'coach-sr-v1',
    });
    // Force expiry into the past.
    const row = [...prisma.store.values()][0];
    row.expires_at = new Date(Date.now() - 1000);
    expect(await svc.get('coach', USER, BUCKET)).toBeNull();
  });

  it('getEvenIfStale returns an expired payload (timeout fallback path)', async () => {
    await svc.set('coach', USER, BUCKET, coachPayload(), {
      modelUsed: 'stub',
      promptVersion: 'coach-sr-v1',
    });
    const row = [...prisma.store.values()][0];
    row.expires_at = new Date(Date.now() - 1000);
    expect(await svc.get('coach', USER, BUCKET)).toBeNull();
    const stale = await svc.getEvenIfStale('coach', USER, BUCKET);
    expect(stale).toEqual(coachPayload());
  });

  it('invalidate makes a subsequent get return null', async () => {
    await svc.set('coach', USER, BUCKET, coachPayload(), {
      modelUsed: 'stub',
      promptVersion: 'coach-sr-v1',
    });
    expect(await svc.get('coach', USER, BUCKET)).not.toBeNull();
    await svc.invalidate(USER);
    expect(await svc.get('coach', USER, BUCKET)).toBeNull();
    expect(await svc.getEvenIfStale('coach', USER, BUCKET)).toBeNull();
  });

  it('coach and client sides are isolated by the side discriminator', async () => {
    await svc.set('coach', USER, BUCKET, coachPayload(), {
      modelUsed: 'stub',
      promptVersion: 'coach-sr-v1',
    });
    // A client-side get must NOT see the coach-side row.
    expect(await svc.get('client', USER, BUCKET)).toBeNull();
    expect(prisma.store.size).toBe(1);
  });
});
