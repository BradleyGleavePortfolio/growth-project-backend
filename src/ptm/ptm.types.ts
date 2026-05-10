// Phase 1 PTM (Predictive Tracking Model) — shared types.
//
// Centralized so the heuristic engine (Phase 1B), the weighted engine
// (Phase 1D), the admin teaching surface (Phase 1C), and the signal-hook
// call sites all import the SAME enum strings. The Prisma client also
// re-exports these as Postgres enum values; the duplication here is
// intentional so a `import type` at the call site never pulls in the
// generated Prisma runtime.
//
// Doctrine: every constant below corresponds 1:1 to a Postgres enum
// value declared in prisma/schema.prisma. If you add a value here you
// MUST add a Prisma migration (and vice-versa). The doctrine-cleanup
// spec scans schema.prisma for forbidden tokens; a future PTM doctrine
// spec will scan ptm.types.ts ↔ schema.prisma alignment.

import type { Prisma } from '@prisma/client';

/** Discrete behavioral signals we observe per client. Keep in sync with
 * the `PtmSignalType` enum in prisma/schema.prisma. */
export type PtmSignalTypeT =
  | 'checkin_streak'
  | 'checkin_miss'
  | 'weight_logged'
  | 'weight_skipped'
  | 'message_sent'
  | 'message_received'
  | 'coach_note_received'
  | 'workout_logged'
  | 'workout_skipped'
  | 'meal_logged'
  | 'meal_skipped'
  | 'finance_eod'
  | 'finance_milestone'
  | 'app_open'
  | 'consistency_low'
  | 'streak_dropped';

/** Outcome labels — the teaching set for the weighted v2 engine. */
export type PtmOutcomeTypeT =
  | 'churned'
  | 'completed_90day'
  | 'upgraded'
  | 'referred'
  | 'milestone_hit'
  | 'dropped_off'
  | 'renewed';

/** Which engine produced a PtmPrediction row. */
export type PtmPredictionBasisT = 'heuristic_v1' | 'weighted_v2' | 'model_v3';

/** Input contract for PtmService.recordSignal. Fire-and-forget at the
 * call site — the service catches and logs every failure rather than
 * throwing, so a PTM outage cannot bubble into a user-facing 5xx. */
export interface RecordSignalInput {
  userId: string;
  signalType: PtmSignalTypeT;
  /** Numeric magnitude. Convention: 1 for boolean events, raw delta or
   * count for everything else. The heuristic engine reads this as Float. */
  value?: number;
  /** Small JSON blob for per-signal context (delta direction, source
   * module, etc.). NEVER include PII. */
  metadata?: Record<string, unknown>;
  /** Override the timestamp. Defaults to now(). Mostly used by tests. */
  recordedAt?: Date;
}

/** Result returned by the heuristic / weighted engines. APPEND-ONLY: the
 * service writes a fresh PtmPrediction row on every recompute rather
 * than updating in place, so an admin can see the score's drift over
 * time. */
export interface PtmScoreResult {
  riskScore: number; // [0.0, 1.0] — higher means more likely to churn / drop off
  successScore: number; // [0.0, 1.0] — higher means more likely to renew / hit goal
  basis: PtmPredictionBasisT;
  /** Per-factor breakdown the admin "why" drawer renders. Each factor
   * carries its own contribution to risk / success so the operator can
   * see the heuristic's reasoning without seeing the engine internals. */
  factors: PtmFactor[];
}

export interface PtmFactor {
  /** Stable identifier (e.g. `checkin_miss_3plus`). */
  key: string;
  /** Human-friendly label (e.g. "3+ missed check-ins in last 14 days"). */
  label: string;
  /** Sign-significant contribution. Positive = adds risk, negative =
   * protective (subtracts risk / adds success). Range [-0.30, +0.30]. */
  contribution: number;
  /** Optional raw observation (e.g. count of missed check-ins). */
  observed?: number;
}

/** Window definitions used across the heuristic engine. Centralized so the
 * weighted engine (1D) and admin reports (1C) read from the same constants. */
export const PTM_WINDOWS = {
  CHECKIN_MISS_DAYS: 14,
  WEIGHT_SKIP_DAYS: 14,
  WORKOUT_SKIP_DAYS: 10,
  MEAL_SKIP_DAYS: 7,
  COACH_NOTE_GAP_DAYS: 10,
  APP_OPEN_GAP_DAYS: 7,
  CONSISTENCY_WINDOW_DAYS: 30,
  RECENT_SIGNAL_WINDOW_DAYS: 30,
  /** Minimum number of labelled outcomes before the weighted v2 engine
   * activates. Below this threshold every recompute uses heuristic_v1. */
  WEIGHTED_ACTIVATION_OUTCOMES: 20,
} as const;

/** Score buckets for the risk board UI. Centralized so the mobile coach
 * screen, the admin widget, and the heuristic tests agree on the cutoffs. */
export const PTM_SCORE_BUCKETS = {
  GREEN_MAX: 0.3, // [0.0, 0.3]   = green
  AMBER_MAX: 0.6, // (0.3, 0.6]   = amber
  // anything > 0.6                 = red
} as const;

export type PtmRiskBucket = 'green' | 'amber' | 'red';
export const bucketize = (riskScore: number): PtmRiskBucket => {
  if (riskScore <= PTM_SCORE_BUCKETS.GREEN_MAX) return 'green';
  if (riskScore <= PTM_SCORE_BUCKETS.AMBER_MAX) return 'amber';
  return 'red';
};

// Re-export the Prisma type so call sites can keep a single import path.
export type { Prisma };
