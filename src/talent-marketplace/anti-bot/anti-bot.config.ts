/**
 * TM-6 — env-tunable limits for the in-house anti-bot gate. Clamp-on-read
 * idiom (mirrors throttler.config.ts) so a misconfigured env cannot open a
 * flood window or lock every applicant out. RATE → deny, VELOCITY → challenge,
 * plus identity/device fan-out heuristics from the PII-governed signal store.
 */

function readIntEnv(name: string, defaultVal: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return defaultVal;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return defaultVal;
  return Math.min(Math.max(n, min), max);
}

export const ANTI_BOT_LIMITS = {
  /** Hard per-IP ceiling per surface in the window → deny. */
  ipLimit: readIntEnv('TM_ANTIBOT_IP_LIMIT', 8, 1, 1_000),
  /** Shared window for the rate + velocity counters (seconds). */
  ipWindowSec: readIntEnv('TM_ANTIBOT_IP_WINDOW_SEC', 600, 30, 86_400),
  /** Softer per-identity velocity ceiling in the same window → challenge. */
  identityLimit: readIntEnv('TM_ANTIBOT_IDENTITY_LIMIT', 4, 1, 1_000),
  /** Distinct identities one device may touch before later ones are challenged. */
  deviceIdentityFanout: readIntEnv('TM_ANTIBOT_DEVICE_FANOUT', 3, 1, 1_000),
  /** Distinct IPs one identity may apply from before it is challenged. */
  identityIpFanout: readIntEnv('TM_ANTIBOT_IDENTITY_IP_FANOUT', 5, 1, 1_000),
  /** Retention window for persisted heuristic/abuse signals (days). */
  signalTtlDays: readIntEnv('TM_ANTIBOT_SIGNAL_TTL_DAYS', 30, 1, 365),
} as const;
