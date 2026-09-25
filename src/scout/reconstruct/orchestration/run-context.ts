import { Prisma } from '@prisma/client';

/**
 * S8-G — the run context a reconstruction pass carries into every per-row
 * transaction (docs/decisions/2026-09-24-s7l-run-lifecycle.md §3.1, §8).
 *
 * `legacy`: the coach-JWT `POST /api/scout/reconstruct` route on a settled
 * intent. No gate, no epoch — the statement sequence of every row transaction
 * is byte-identical to the pre-S8-G engine.
 *
 * `server`: the pass `onTransferSettled` runs over an open server run in phase
 * `reconciling`. `gate` is S7-L's `assertRunOpen` bound to this run: an UPDATE
 * that is itself the row lock and returns the run's `execution_epoch` (or null
 * when the run is fenced, terminal, past its deadline or absent). The engine
 * calls it as the FIRST statement of every per-row transaction and compares the
 * returned epoch with `epoch`, the value the settle observed at claim commit —
 * the per-row CAS. Any mismatch closes the pass at that row.
 */
export type GateFn = (tx: Prisma.TransactionClient) => Promise<number | null>;

export interface ServerRunContext {
  readonly mode: 'server';
  readonly epoch: number;
  readonly gate: GateFn;
}

export interface LegacyRunContext {
  readonly mode: 'legacy';
}

export type RunContext = LegacyRunContext | ServerRunContext;

/** The coach-JWT route's context: no gate, no epoch (pre-S8-G statement sequence). */
export const LEGACY_RUN: LegacyRunContext = { mode: 'legacy' };

/**
 * Thrown out of a per-row transaction when the §3.1 gate returned zero rows or an
 * epoch other than the one the pass was started under. The transaction rolls
 * back with nothing written; the pass stops at that row and hands over to the
 * arbiter path. It is never converted into a fabricated `failed` ledger outcome
 * and never retried (it is not a contention error).
 */
export class RunPassStopped extends Error {
  constructor() {
    super('scout run pass stopped: gate closed');
    this.name = 'RunPassStopped';
  }
}

/** Why one planned (platform, token) source stopped early, or null when it ran to the end. */
export type FamilyStop = 'gate_closed' | 'over_ceiling' | 'provenance_conflict';

/** The pass's account of one staged (platform, token) source; counts are read back from the ledger. */
export interface FamilyPassResult {
  /** The staged step token (`entity_type` of the staged rows). */
  readonly token: string;
  readonly source_platform: string;
  /** The canonical family the token resolved to, or null for an unmapped token. */
  readonly family: string | null;
  readonly staged: number;
  readonly reconstructed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly stopped: FamilyStop | null;
}

/** The whole pass. `stopped: 'gate_closed'` means the run was fenced/expired mid-pass. */
export interface RunPassResult {
  readonly families: readonly FamilyPassResult[];
  /** Distinct staged tokens no registered source spec maps to a registered family. */
  readonly unmapped_families: readonly string[];
  readonly stopped: 'gate_closed' | null;
}
