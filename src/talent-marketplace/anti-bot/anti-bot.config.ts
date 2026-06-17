/**
 * TM-6 — env-tunable limits for the in-house anti-bot gate.
 *
 * Mirrors the clamp-on-read idiom in `throttler.config.ts`: every value is
 * read once at module load and clamped to a sane range so a misconfigured
 * env cannot open a flood window or lock every applicant out.
 *
 * Two windows per surface compose into the verdict:
 *  - RATE   : hard per-(IP,surface) ceiling in a short window  → `deny`.
 *  - VELOCITY: softer per-identity burst ceiling                → `challenge`.
 * Plus identity/device heuristics backed by the PII-governed signal store.
 */

function readIntEnv(
  name: string,
  defaultVal: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  if (!raw) return defaultVal;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return defaultVal;
  return Math.min(Math.max(n, min), max);
}

// Hard per-IP rate ceiling per surface, 10-minute window. Generous for a
// real applicant (nobody legitimately applies 8 times in 10 min from one
// IP) but biting for a scripted sweep.
const ANTI_BOT_IP_LIMIT = readIntEnv('TM_ANTIBOT_IP_LIMIT', 8, 1, 1_000);
const ANTI_BOT_IP_WINDOW_SEC = readIntEnv(
  'TM_ANTIBOT_IP_WINDOW_SEC',
  600,
  30,
  86_400,
);

// Softer per-identity velocity ceiling, same window. Crossing it is a
// `challenge`, not a `deny` — a determined real applicant editing/retrying
// gets a proof-of-work prompt rather than a wall.
const ANTI_BOT_IDENTITY_LIMIT = readIntEnv(
  'TM_ANTIBOT_IDENTITY_LIMIT',
  4,
  1,
  1_000,
);

// How many DISTINCT identities one device fingerprint may touch in the
// retention window before later identities are challenged as sock-puppets.
const ANTI_BOT_DEVICE_IDENTITY_FANOUT = readIntEnv(
  'TM_ANTIBOT_DEVICE_FANOUT',
  3,
  1,
  1_000,
);

// How many DISTINCT IPs one identity may apply from in the retention window
// before it is challenged (account-sharing / rotation heuristic).
const ANTI_BOT_IDENTITY_IP_FANOUT = readIntEnv(
  'TM_ANTIBOT_IDENTITY_IP_FANOUT',
  5,
  1,
  1_000,
);

// Retention for persisted heuristic/abuse signals. 30 days default — long
// enough to catch a slow sock-puppet campaign, short enough to bound the
// PII-governed store. A reaper (out of scope for TM-6) prunes past this.
const ANTI_BOT_SIGNAL_TTL_DAYS = readIntEnv(
  'TM_ANTIBOT_SIGNAL_TTL_DAYS',
  30,
  1,
  365,
);

export const ANTI_BOT_LIMITS = {
  ipLimit: ANTI_BOT_IP_LIMIT,
  ipWindowSec: ANTI_BOT_IP_WINDOW_SEC,
  identityLimit: ANTI_BOT_IDENTITY_LIMIT,
  deviceIdentityFanout: ANTI_BOT_DEVICE_IDENTITY_FANOUT,
  identityIpFanout: ANTI_BOT_IDENTITY_IP_FANOUT,
  signalTtlDays: ANTI_BOT_SIGNAL_TTL_DAYS,
} as const;
