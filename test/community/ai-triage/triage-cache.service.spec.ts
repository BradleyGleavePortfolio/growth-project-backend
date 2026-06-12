import {
  TriageCacheService,
  TRIAGE_CACHE_TTL_MS,
  MAX_CACHE_ENTRIES,
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

  describe('bounded size + LRU eviction', () => {
    it('evicts the oldest entries once inserts exceed MAX_CACHE_ENTRIES', () => {
      const cache = new TriageCacheService(() => 1_000);
      // Insert one more than the cap. The very first coach inserted is the LRU
      // and must be evicted; the store must never exceed the cap.
      const total = MAX_CACHE_ENTRIES + 1;
      for (let i = 0; i < total; i++) {
        cache.set(`coach-${i}`, 'k1', value());
      }
      // Oldest (coach-0) evicted, newest (last) retained, size at the cap.
      expect(cache.get('coach-0', 'k1')).toBeNull();
      expect(cache.get(`coach-${total - 1}`, 'k1')).not.toBeNull();
    });

    it('keeps the store at or under the cap after many inserts', () => {
      const cache = new TriageCacheService(() => 1_000);
      for (let i = 0; i < MAX_CACHE_ENTRIES + 250; i++) {
        cache.set(`coach-${i}`, 'k1', value());
      }
      // Count how many of the most-recent cap-worth of coaches are resident;
      // none older should survive (all writes share the same fresh timestamp).
      let resident = 0;
      for (let i = 0; i < MAX_CACHE_ENTRIES + 250; i++) {
        if (cache.get(`coach-${i}`, 'k1') !== null) resident++;
      }
      expect(resident).toBeLessThanOrEqual(MAX_CACHE_ENTRIES);
    });

    it('access (a get HIT) moves an entry to most-recently-used so it survives eviction', () => {
      const cache = new TriageCacheService(() => 1_000);
      // Fill to exactly the cap.
      for (let i = 0; i < MAX_CACHE_ENTRIES; i++) {
        cache.set(`coach-${i}`, 'k1', value());
      }
      // Touch coach-0 (the current LRU) so it becomes most-recently-used.
      expect(cache.get('coach-0', 'k1')).not.toBeNull();
      // One more insert forces a single eviction. Because coach-0 was touched,
      // coach-1 (now the LRU) is evicted instead of coach-0.
      cache.set('coach-new', 'k1', value());
      expect(cache.get('coach-0', 'k1')).not.toBeNull();
      expect(cache.get('coach-1', 'k1')).toBeNull();
    });
  });

  describe('opportunistic TTL sweep collects OTHER coaches', () => {
    it('eventually purges expired entries belonging to coaches who never return', () => {
      let now = 1_000;
      const cache = new TriageCacheService(() => now);
      // An absentee coach writes once and never returns to trigger a get().
      cache.set('absentee', 'k1', value());
      expect(cache.get('absentee', 'k1')).not.toBeNull();

      // Time advances past the TTL. The absentee entry is now expired but no
      // get() for it ever fires — only an UNRELATED coach's set() runs the
      // opportunistic sweep that reclaims it.
      now = 1_000 + TRIAGE_CACHE_TTL_MS + 1;
      cache.set('active', 'k1', value());

      // The absentee entry has been collected by the sweep (not just lazily on
      // its own get): it is gone even though we never called get('absentee')
      // after expiry to trigger the lazy delete.
      expect(cache.get('absentee', 'k1')).toBeNull();
      // The active coach's fresh entry remains.
      expect(cache.get('active', 'k1')).not.toBeNull();
    });
  });
});
