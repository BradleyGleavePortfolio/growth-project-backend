/**
 * Typed persist handoff (S8-C, grant amendment 2026-09-25). A family's `persist`
 * may return the accepted legacy shape (`string | null`, ledger `target_kind`
 * stays NULL) or one of these typed outcomes, which the engine writes into the
 * SAME ledger transaction and the SAME precedence update as the status:
 *  - `ok: true`  → status `reconstructed`, `target_id` + closed `target_kind`
 *  - `ok: false` → status `skipped` with the exact unresolved reason: a
 *    database-determined native outcome (parent pending, target removed,
 *    identity conflict) the pure map step cannot know. Nothing native is
 *    written in that transaction, so replay re-evaluates the row and converges.
 * Historical NULL kinds are never reinterpreted: a legacy result writes no kind.
 */

/** Closed S8-B `ScoutReconstructionLedger.target_kind` set (database CHECK). */
export const LEDGER_TARGET_KIND = {
  person: 'person',
  scout_entity: 'scout_entity',
  workout_program: 'workout_program',
  workout_plan: 'workout_plan',
} as const;
export type LedgerTargetKind = (typeof LEDGER_TARGET_KIND)[keyof typeof LEDGER_TARGET_KIND];

export type PersistOutcome =
  | {
      readonly ok: true;
      readonly targetId: string;
      readonly targetKind: LedgerTargetKind;
      /** Nested children recorded `unresolved` in provenance for this target (0 when none). */
      readonly unresolvedChildren: number;
    }
  | { readonly ok: false; readonly reason: string };

/** What a family's `persist` may resolve to: the legacy id (or null) or a typed outcome. */
export type PersistResult = string | null | PersistOutcome;

export function isPersistOutcome(result: PersistResult): result is PersistOutcome {
  return result !== null && typeof result === 'object' && 'ok' in result;
}
