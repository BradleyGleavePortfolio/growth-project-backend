import { createHash } from 'crypto';
import { WearableMetricType, WearableProvider } from '@prisma/client';

/**
 * PR-HK-0 — deterministic dedup key for {@link WearableSample}.
 *
 * Contract (UNIFIED_BUILD_PLAN §0; Agent 2 §2.5):
 *
 *   dedup_key = sha256( user_id | provider | metric | start_iso | end_iso )
 *
 * where the segments are joined by the ASCII pipe `|` and the timestamps are
 * rendered as their UTC ISO-8601 instant (`Date.prototype.toISOString()`).
 *
 * Why this exact shape:
 *  - Re-ingesting the same provider record (webhook redelivery, backfill
 *    overlap) produces an identical key → the upsert is idempotent
 *    (50-Failures #28/#29 replay/concurrency).
 *  - The provider is part of the key, so two providers reporting the SAME
 *    metric for the SAME window yield DISTINCT keys → distinct rows.
 *    Cross-provider overlap is resolved at READ time (IngestionService
 *    .resolveBest), never by a write-time overwrite. Provenance is preserved
 *    (50-Failures #45 — never destroy source data).
 *
 * Determinism guarantees:
 *  - Timestamps are normalized to UTC ISO via toISOString(), so the same
 *    physical instant always hashes identically regardless of the source_tz
 *    a provider reported it in (the IANA tz is stored separately on the row
 *    for bucketing; it is NOT part of the identity key).
 *  - Enum values are stable string constants from the Prisma client.
 */
export interface DedupKeyInput {
  userId: string;
  provider: WearableProvider;
  metric: WearableMetricType;
  /** Observation window start. */
  startAt: Date;
  /** Observation window end (== startAt for instantaneous samples). */
  endAt: Date;
}

/** Field separator. Pipe is illegal in UUIDs, enums, and ISO instants. */
const SEP = '|';

/**
 * Compute the deterministic sha256 hex dedup key for a normalized sample.
 *
 * @throws {RangeError} if either timestamp is an invalid Date — a bad
 *   timestamp must fail loud here rather than silently hash to a garbage
 *   key that would corrupt dedup (50-Failures #8 / #36 no silent swallow).
 */
export function computeDedupKey(input: DedupKeyInput): string {
  const startIso = toIsoStrict(input.startAt, 'startAt');
  const endIso = toIsoStrict(input.endAt, 'endAt');

  const canonical = [
    input.userId,
    input.provider,
    input.metric,
    startIso,
    endIso,
  ].join(SEP);

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function toIsoStrict(value: Date, field: string): string {
  const time = value instanceof Date ? value.getTime() : NaN;
  if (Number.isNaN(time)) {
    throw new RangeError(
      `computeDedupKey: ${field} is not a valid Date (received: ${String(value)})`,
    );
  }
  return value.toISOString();
}
