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
// The cache is intentionally simple (a Map) — this surface is per-coach and
// low-cardinality, and a process restart is a safe cache miss (recompute), so
// over-engineering a distributed cache here would be phantom complexity.

export const TRIAGE_CACHE_TTL_MS = 5 * 60 * 1000;

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
    return entry.value;
  }

  /** Write-through after a successful generation. */
  set(coachId: string, freshnessKey: string, value: TriageResponse): void {
    this.store.set(coachId, {
      value,
      freshnessKey,
      expiresAt: this.now() + TRIAGE_CACHE_TTL_MS,
    });
  }

  /** Explicit invalidation hook (e.g. on a new message broadcast, or tests). */
  invalidate(coachId: string): void {
    this.store.delete(coachId);
  }
}
