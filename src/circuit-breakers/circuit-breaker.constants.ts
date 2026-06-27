// H6 — per-client circuit-breaker config (D-H6-2 LOCKED 2026-06-26).
//
// These thresholds are deliberately NOT uniform: SendGrid, Stripe, and Mux
// have nothing in common operationally, so each gets a fuse rated for its
// own load (the household-fuse-ratings metaphor from D-H6-2). Opossum is the
// maintained Node descendant of Netflix Hystrix.
//
// This file is the single source of truth for breaker tuning. The factory
// (circuit-breaker.factory.ts) reads from it; nothing else should hard-code
// timeouts or thresholds.
//
//   timeout                  — ms before a call is considered failed/slow.
//   errorThresholdPercentage — % of failures in the rolling window that
//                              trips the breaker open.
//   resetTimeout             — ms the breaker stays open before half-open.

export const BREAKER_CONFIG = {
  // Payment-grade tolerance — Stripe p99 latency is high and a tripped
  // payment path is worse than a slow one.
  stripe: { timeout: 15_000, errorThresholdPercentage: 50, resetTimeout: 30_000 },
  // Video upload latency expectations.
  mux: { timeout: 10_000, errorThresholdPercentage: 50, resetTimeout: 30_000 },
  // Transactional email — fail fast, low tolerance.
  sendgrid: { timeout: 5_000, errorThresholdPercentage: 30, resetTimeout: 30_000 },
  // All other PII clients (Anthropic, OpenAI, Twilio, ...).
  default: { timeout: 8_000, errorThresholdPercentage: 50, resetTimeout: 30_000 },
} as const;

export type BreakerClientName = keyof typeof BREAKER_CONFIG;

export interface BreakerOptions {
  timeout: number;
  errorThresholdPercentage: number;
  resetTimeout: number;
}

// Resolve the config for a client name, falling back to `default` for any
// client without a bespoke entry. Lower-cased so call sites can pass
// 'Stripe' / 'stripe' interchangeably.
export function resolveBreakerConfig(clientName: string): BreakerOptions {
  const key = clientName.toLowerCase() as BreakerClientName;
  return BREAKER_CONFIG[key] ?? BREAKER_CONFIG.default;
}
