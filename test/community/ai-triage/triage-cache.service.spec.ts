import {
  TriageCacheService,
  TRIAGE_CACHE_TTL_MS,
} from '../../../src/community/ai-triage/triage-cache.service';
import {
  emptyTriage,
  TriageResponse,
} from '../../../src/community/ai-triage/triage-output.schema';

// v2-4 — TriageCacheService unit tests. Deterministic clock injected so TTL +
// freshness behaviour is exact. The freshnessKey is the R69 invalidation
// mechanism (no Prisma table): a new unanswered message changes the key.

const COACH = 'c0000000-0000-4000-8000-000000000001';

function value(): TriageResponse {
  return emptyTriage(new Date('2026-06-10T12:00:00Z'));
}

describe('TriageCacheService', () => {
  describe('freshnessKey', () => {
    it('changes when the item count changes (a new message arrives)', () => {
      const newest = new Date('2026-06-10T12:00:00Z');
      const k1 = TriageCacheService.freshnessKey({ itemCount: 3, newestCreatedAt: newest });
      const k2 = TriageCacheService.freshnessKey({ itemCount: 4, newestCreatedAt: newest });
      expect(k1).not.toBe(k2);
    });

    it('changes when the newest timestamp changes (a newer message arrives)', () => {
      const a = TriageCacheService.freshnessKey({
        itemCount: 3,
        newestCreatedAt: new Date('2026-06-10T12:00:00Z'),
      });
      const b = TriageCacheService.freshnessKey({
        itemCount: 3,
        newestCreatedAt: new Date('2026-06-10T13:00:00Z'),
      });
      expect(a).not.toBe(b);
    });

    it('is stable for an identical candidate set', () => {
      const newest = new Date('2026-06-10T12:00:00Z');
      const a = TriageCacheService.freshnessKey({ itemCount: 2, newestCreatedAt: newest });
      const b = TriageCacheService.freshnessKey({ itemCount: 2, newestCreatedAt: newest });
      expect(a).toBe(b);
    });

    it('handles the empty (no items) case distinctly', () => {
      const empty = TriageCacheService.freshnessKey({ itemCount: 0, newestCreatedAt: null });
      const one = TriageCacheService.freshnessKey({
        itemCount: 1,
        newestCreatedAt: new Date('2026-06-10T12:00:00Z'),
      });
      expect(empty).not.toBe(one);
    });
  });

  describe('get/set with freshness + TTL', () => {
    it('returns the stored value on a matching freshnessKey within TTL', () => {
      let now = 1_000;
      const cache = new TriageCacheService(() => now);
      cache.set(COACH, 'k1', value());
      expect(cache.get(COACH, 'k1')).not.toBeNull();
    });

    it('misses when the freshnessKey differs (new message ⇒ recompute)', () => {
      const cache = new TriageCacheService(() => 1_000);
      cache.set(COACH, 'k1', value());
      expect(cache.get(COACH, 'k2')).toBeNull();
    });

    it('expires after the TTL elapses', () => {
      let now = 1_000;
      const cache = new TriageCacheService(() => now);
      cache.set(COACH, 'k1', value());
      now = 1_000 + TRIAGE_CACHE_TTL_MS + 1;
      expect(cache.get(COACH, 'k1')).toBeNull();
    });

    it('explicit invalidate(coachId) drops the entry', () => {
      const cache = new TriageCacheService(() => 1_000);
      cache.set(COACH, 'k1', value());
      cache.invalidate(COACH);
      expect(cache.get(COACH, 'k1')).toBeNull();
    });

    it('isolates entries per coach id', () => {
      const cache = new TriageCacheService(() => 1_000);
      cache.set(COACH, 'k1', value());
      expect(cache.get('other-coach', 'k1')).toBeNull();
    });
  });
});
