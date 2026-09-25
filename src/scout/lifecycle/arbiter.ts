import type { ScoutTerminalStatus } from '../scout.dto';
import type { FenceReason, RunReasonCode, ServerTerminalStatus } from './reason-codes';

// S7-L D-S7L-2 — the ONE arbiter that decides a server run's terminal. A pure function
// of the observed facts: no I/O, no clock, no exceptions. The caller (ScoutLifecycleService)
// writes the verdict exactly once under a CAS on the run row; this module never writes.
//
// `complete` is emitted ONLY from a reconciliation verdict (S9). S7-L never produces it: until
// a verdict exists the default is `partial / reconciliation_not_performed`.

/** Per-family ledger tally (N/Q1 invariant 6: staged === reconstructed + skipped + failed). */
export interface LedgerTally {
  reconstructed: number;
  skipped: number;
  failed: number;
}

/**
 * An S9 reconciliation verdict. S7-L defines the shape and consumes it at precedence step 3;
 * nothing in S7-L produces one (§8 seam). Its outcome is taken as the terminal verbatim.
 */
export interface ReconciliationVerdict {
  outcome: ServerTerminalStatus;
  reason_code: RunReasonCode | null;
}

export interface ArbiterInput {
  /** Fence reason when the run was fenced before settling; null when not fenced. */
  fence: FenceReason | null;
  /** The extension's stored `/complete` claim (`success|partial|failed`), or null when none. */
  claim: ScoutTerminalStatus | null;
  /** Staged rows per entity family (`ScoutIngestEntity` count per `entity_type`). */
  staged_by_family: Readonly<Record<string, number>>;
  /** Ledger tally per family; absent families have no ledger row yet. */
  ledger_by_family: Readonly<Record<string, LedgerTally>>;
  /** Staged families no built-in mapper handles (informational until S9 consumes them). */
  unmapped_families: readonly string[];
  /** The S9 verdict, or null until one exists. */
  reconciliation: ReconciliationVerdict | null;
}

export interface ArbiterVerdict {
  terminal_status: ServerTerminalStatus;
  reason_code: RunReasonCode | null;
}

/** Reason code written with each fence terminal (D-S7L-4 → D-S7L-5). */
export const FENCE_REASON_CODES: Readonly<Record<FenceReason, RunReasonCode>> = {
  cancelled: 'cancelled_by_coach',
  timed_out: 'deadline_exceeded',
  revoked: 'revoked',
};

/** Terminal written for each fence reason (§3: cancelled → cancelled, timed_out → timed_out, revoked → blocked). */
export const FENCE_TERMINALS: Readonly<Record<FenceReason, ServerTerminalStatus>> = {
  cancelled: 'cancelled',
  timed_out: 'timed_out',
  revoked: 'blocked',
};

export const totalStaged = (staged: Readonly<Record<string, number>>): number =>
  Object.values(staged).reduce((sum, n) => sum + n, 0);

/**
 * Precedence, first match wins (D-S7L-2):
 *  1. fence present → its fixed terminal and reason;
 *  2. claim `failed` with zero staged rows → `failed` / `transfer_failed`;
 *  3. reconciliation verdict present → its outcome and reason verbatim;
 *  4. otherwise `partial` / `reconciliation_not_performed`.
 */
export function arbitrate(input: ArbiterInput): ArbiterVerdict {
  if (input.fence !== null) {
    return {
      terminal_status: FENCE_TERMINALS[input.fence],
      reason_code: FENCE_REASON_CODES[input.fence],
    };
  }
  if (input.claim === 'failed' && totalStaged(input.staged_by_family) === 0) {
    return { terminal_status: 'failed', reason_code: 'transfer_failed' };
  }
  if (input.reconciliation !== null) {
    return {
      terminal_status: input.reconciliation.outcome,
      reason_code: input.reconciliation.reason_code,
    };
  }
  return { terminal_status: 'partial', reason_code: 'reconciliation_not_performed' };
}
