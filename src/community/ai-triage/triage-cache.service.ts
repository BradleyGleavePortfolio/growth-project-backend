import { Injectable } from '@nestjs/common';
import type { TriageResponse } from './triage-output.schema';

// v2-4 — in-process triage cache.
//
// R69 (ZERO Prisma schema diff): triage is DERIVED ON READ from existing
// CommunityMessage / CommunityPost rows, so there is no new table to persist a
// cache. We cache the computed triage IN-PROCESS keyed by the requesting coach
// id, with a TTL and — critically — a content `freshnessKey` (a cheap
// fingerprint of the candidate set: item count + newest item timestamp). A
// cache row is a HIT only when it is non-expired AND its freshnessKey matches
// the live one, so a NEW unanswered message (which changes the count and/or the
// newest timestamp) invalidates the cache automatically without any write path
// into the messages service. An explicit invalidate(coachId) is also exposed
// for the realtime/test hook.
//
// The cache is intentionally simple (an insertion-ordered Map) — this surface
// is per-coach and low-cardinality, and a process restart is a safe cache miss
// (recompute), so over-engineering a distributed cache here would be phantom
// complexity. It IS, however, explicitly bounded so a pathological tenant
// population can never grow it without limit:
//   - Size cap: at most MAX_CACHE_ENTRIES live coach entries. The Map preserves
//     insertion order, so the FIRST key is the least-recently-used; on a write
//     that would exceed the cap we evict from the head until we are back under.
//   - LRU touch: a get() HIT re-inserts the entry (delete + set) so it moves to
//     the tail, making it the most-recently-used and the last to be evicted.
//   - Opportunistic TTL sweep: every set() purges a bounded number of expired
//     entries from OTHER coaches (entries that would otherwise sit resident for
//     the process lifetime because their coach never returns to call get()).
//     The sweep is cost-capped at TTL_SWEEP_SCAN_LIMIT inspected entries so a
//     write stays O(1)-amortised even with a large store.

export const TRIAGE_CACHE_TTL_MS = 5 * 60 * 1000;

// Hard upper bound on resident coach entries. With one entry per coach this is
// generous; the cap exists to make the worst case (unbounded distinct coach
// ids over the process lifetime) provably bounded rather than load-bearing in
// normal operation.
export const MAX_CACHE_ENTRIES = 1000;

// How many entries a single set() will inspect for expiry during its
// opportunistic sweep. Caps the per-write cost of TTL collection.
export const TTL_SWEEP_SCAN_LIMIT = 64;

interface CacheEntry {
  value: TriageResponse;
  freshnessKey: string;
  expiresAt: number;
}

@Injectable()
export class TriageCacheService {
  private readonly store = new Map<string, CacheEntry>();

  // Time source is injectable for deterministic TTL tests; defaults to Date.now.
  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Build the freshness fingerprint for a candidate set. A change in the
   * number of unanswered items OR in the newest item's timestamp flips the key,
   * which is exactly the "invalidate on new message" trigger: a new unanswered
   * message bumps the count and (being newest) the max timestamp.
   */
  static freshnessKey(params: {
    itemCount: number;
    newestCreatedAt: Date | null;
  }): string {
    const ts = params.newestCreatedAt
      ? params.newestCreatedAt.getTime()
      : 'none';
    return `${params.itemCount}:${ts}`;
  }

  /**
   * Return the cached triage for a coach IFF it is non-expired and its stored
   * freshnessKey matches the live one. Any mismatch (new message, expiry,
   * absent row) is a miss → null → the service recomputes.
   */
  get(coachId: string, freshnessKey: string): TriageResponse | null {
    const entry = this.store.get(coachId);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(coachId);
      return null;
    }
    if (entry.freshnessKey !== freshnessKey) return null;
    // LRU touch: re-insert so this entry moves to the tail (most-recently-used)
    // and is therefore the last candidate for size-based eviction.
    this.store.delete(coachId);
    this.store.set(coachId, entry);
    return entry.value;
  }

  /** Write-through after a successful generation. */
  set(coachId: string, freshnessKey: string, value: TriageResponse): void {
    // Opportunistic TTL sweep BEFORE inserting: reclaim expired entries from
    // coaches who never returned to trigger their own lazy get()-time delete.
    this.sweepExpired();

    // Re-insert at the tail (delete first so an existing key is treated as a
    // fresh write and moves to the most-recently-used position).
    this.store.delete(coachId);
    this.store.set(coachId, {
      value,
      freshnessKey,
      expiresAt: this.now() + TRIAGE_CACHE_TTL_MS,
    });

    // Size cap: evict least-recently-used (head of the insertion-ordered Map)
    // until we are back within MAX_CACHE_ENTRIES.
    while (this.store.size > MAX_CACHE_ENTRIES) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  /**
   * Purge expired entries, inspecting at most TTL_SWEEP_SCAN_LIMIT of the
   * oldest entries. Bounding the scan keeps a single set() amortised-cheap even
   * when the store is large; the size cap is the backstop that guarantees the
   * store can never grow without limit regardless of expiry timing.
   */
  private sweepExpired(): void {
    const now = this.now();
    let scanned = 0;
    for (const [key, entry] of this.store) {
      if (scanned >= TTL_SWEEP_SCAN_LIMIT) break;
      scanned++;
      if (entry.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }

  /** Explicit invalidation hook (e.g. on a new message broadcast, or tests). */
  invalidate(coachId: string): void {
    this.store.delete(coachId);
  }
}
