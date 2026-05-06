// Phase 1D — internal types for the weighted v2 engine.
//
// These shapes are NOT part of the public PtmScoreResult contract; they
// live here so the service file stays focused on algorithm code and so
// the report endpoint can import the trained-weight row shape without
// pulling in the service class.

import type { PtmSignalTypeT, PtmOutcomeTypeT } from './ptm.types';

/** Cohort tag used while binning labelled outcomes for training. */
export type PtmCohort = 'success' | 'failure';

/** SUCCESS cohort: labels we want to reinforce. */
export const PTM_SUCCESS_OUTCOMES: readonly PtmOutcomeTypeT[] = [
  'completed_90day',
  'upgraded',
  'referred',
  'milestone_hit',
  'renewed',
] as const;

/** FAILURE cohort: labels we want the engine to flag as risk-correlated. */
export const PTM_FAILURE_OUTCOMES: readonly PtmOutcomeTypeT[] = [
  'churned',
  'dropped_off',
] as const;

/** Bin a raw outcome label into one of the two training cohorts.
 * Returns null for any future outcome that is not yet classified — the
 * trainer skips unclassified rows rather than guessing. */
export function cohortFor(outcome: PtmOutcomeTypeT): PtmCohort | null {
  if (PTM_SUCCESS_OUTCOMES.includes(outcome)) return 'success';
  if (PTM_FAILURE_OUTCOMES.includes(outcome)) return 'failure';
  return null;
}

/** Per-signal-type training summary. Persisted in the in-memory cache and
 * surfaced verbatim by the admin signal-weights report. */
export interface PtmTrainedWeight {
  signal_type: PtmSignalTypeT;
  /** Roughly [-1, +1]. Positive = correlated with FAILURE cohort (risk),
   * negative = correlated with SUCCESS cohort (protective). */
  weight: number;
  /** How many cohort rows contributed to this weight. The sum across
   * cohorts; the trainer carries this so an operator can spot a weight
   * computed from a thin slice. */
  training_count: number;
  /** Largest per-30-day-window observed count across the entire training
   * set for this signal_type. Used as the normalisation denominator at
   * score time so a runaway count does not dominate the contribution. */
  training_max: number;
  /** Average count-per-30-day-window in the SUCCESS cohort. */
  success_avg: number;
  /** Average count-per-30-day-window in the FAILURE cohort. */
  failure_avg: number;
}

/** Result of a training pass. Cached for one hour in memory. */
export interface PtmTrainingResult {
  /** Wall-clock time the weights were computed. */
  trained_at: Date;
  /** Total ClientOutcome rows considered (excluding skipped). */
  total_outcomes: number;
  /** Rows skipped because signal_snapshot was null (pre-1C labels). */
  skipped_no_snapshot: number;
  /** Rows skipped because outcome_type was unclassified. */
  skipped_unclassified: number;
  /** Per-cohort row counts. Both must be > 0 for the engine to activate. */
  success_count: number;
  failure_count: number;
  /** Trained weights keyed by signal_type. Empty if either cohort was 0. */
  weights: Map<PtmSignalTypeT, PtmTrainedWeight>;
}

/** The shape we expect signal_snapshot rows on ClientOutcome to take.
 * Phase 1C writes this at label time — a flat object whose keys are
 * PtmSignalType strings and whose values are the count observed in the
 * last 30 days before labelled_at. Anything else (legacy snapshots,
 * partial rows) is tolerated by reading defensively at runtime. */
export type PtmSignalSnapshot = Partial<Record<PtmSignalTypeT, number>>;
