import type { SlaSnapshotDto, SlaState } from './ack.dto';

/**
 * v2-2 SLA helper — a pure, side-effect-free projection of "how late is the
 * coach on this message" derived at read time from the message receipt
 * timestamp and two configured thresholds.
 *
 * Thresholds are env-configurable (defaults: 24h soft, 48h hard per the
 * execution plan). `within` < soft <= `warning` < hard <= `breached`. The
 * boundaries are inclusive at the upper edge so a message exactly at the soft
 * target is already `warning` (we surface the risk early, never late).
 */

export const DEFAULT_SLA_SOFT_MS = 24 * 60 * 60 * 1000; // 24h
export const DEFAULT_SLA_HARD_MS = 48 * 60 * 60 * 1000; // 48h

const SOFT_ENV = 'COMMUNITY_ACK_SLA_SOFT_MS';
const HARD_ENV = 'COMMUNITY_ACK_SLA_HARD_MS';

export interface SlaThresholds {
  softMs: number;
  hardMs: number;
}

/**
 * Resolve the configured SLA thresholds from the environment, falling back to
 * the 24h/48h defaults. A non-positive, non-finite, or non-numeric override is
 * ignored (falls back to the default) so a fat-fingered env value can never
 * produce a zero/negative window that would classify everything as breached.
 * If a provided hard target is not strictly greater than the soft target, the
 * hard default is used relative to the (validated) soft target to preserve the
 * `soft < hard` invariant the classifier depends on.
 */
export function resolveSlaThresholds(
  env: NodeJS.ProcessEnv = process.env,
): SlaThresholds {
  const softMs = parsePositiveInt(env[SOFT_ENV]) ?? DEFAULT_SLA_SOFT_MS;
  const hardCandidate = parsePositiveInt(env[HARD_ENV]) ?? DEFAULT_SLA_HARD_MS;
  const hardMs = hardCandidate > softMs ? hardCandidate : softMs * 2;
  return { softMs, hardMs };
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Classify elapsed time into an SLA state. Clamps negative elapsed (a future
 * receipt timestamp from clock skew) to 0 so it reads as `within` rather than
 * underflowing. Upper boundaries inclusive: elapsed === soft → `warning`,
 * elapsed === hard → `breached`.
 */
export function classifySla(
  elapsedMs: number,
  thresholds: SlaThresholds,
): SlaState {
  const elapsed = elapsedMs < 0 ? 0 : elapsedMs;
  if (elapsed >= thresholds.hardMs) return 'breached';
  if (elapsed >= thresholds.softMs) return 'warning';
  return 'within';
}

/**
 * Build the full SLA snapshot for a message received at `receivedAt`, evaluated
 * at `now` against the resolved thresholds.
 */
export function buildSlaSnapshot(params: {
  receivedAt: Date;
  now?: Date;
  thresholds?: SlaThresholds;
}): SlaSnapshotDto {
  const now = params.now ?? new Date();
  const thresholds = params.thresholds ?? resolveSlaThresholds();
  const rawElapsed = now.getTime() - params.receivedAt.getTime();
  const elapsedMs = rawElapsed < 0 ? 0 : rawElapsed;
  return {
    sla_state: classifySla(elapsedMs, thresholds),
    elapsed_ms: elapsedMs,
    soft_target_ms: thresholds.softMs,
    hard_target_ms: thresholds.hardMs,
  };
}
