// PR AI-3 (fixes PRODUCT-1) — capability materialisation contract.
//
// Background: prior to this PR, `AiApprovalService.decide({decision:'approved'})`
// only flipped `AiActionDraft.status` to 'approved' and wrote an AuditLog. For
// capabilities like `draft.coach_message` that meant the coach saw a green
// check in the UI but no message was ever delivered to the client — a silent
// trust failure on a money/relationship path.
//
// The fix is a small registry pattern: every capability that should emit a
// downstream side-effect on approval registers a `CapabilityMaterializer`.
// `AiApprovalService.decide` resolves the materialiser for the draft's
// capability and invokes it BEFORE flipping status to 'approved'. If
// materialisation throws, the draft stays 'pending' so the coach can retry
// (and the underlying error is surfaced to the caller). Capabilities that
// materialise inline elsewhere (WORKOUT_PROGRAM / MEAL_PLAN through
// `coach-ai.service.ts:approveDraft`) can simply omit a registration; the
// registry will log a debug-level no-op for them.

import type { AiActionDraft } from '@prisma/client';

export interface MaterializeResult {
  /**
   * Logical status of the side-effect after materialisation.
   *
   * - `sent`: this call performed the side-effect (e.g. created a CoachMessage).
   * - `already_materialised`: a prior successful run had already produced the
   *   side-effect; this call was a no-op and `ref` MUST be non-null (it points
   *   at the original downstream row).
   * - `noop`: nothing to do for this capability.
   * - `racing`: a concurrent caller currently holds the materialisation claim
   *   but the downstream side-effect has not yet been observably committed
   *   (`materialised_ref` not set). The caller MUST NOT flip status — it
   *   should surface a conflict to the user so the operation can be retried
   *   after the winner's outcome is known.
   */
  status: 'sent' | 'noop' | 'already_materialised' | 'racing';
  /**
   * Provider-side identifier when the materialiser produced a downstream row
   * (e.g. CoachMessage.id). Persisted on AiActionDraft.materialised_ref so
   * support can trace approved-draft -> sent-message.
   */
  ref?: string | null;
}

/**
 * One implementation per capability that needs to emit a side-effect on
 * approval. Materialisers MUST be idempotent against `draft.id` — concurrent
 * approve calls or a retried approve must never produce two sends.
 */
export interface CapabilityMaterializer {
  /**
   * Capability string this materialiser handles (e.g. 'draft.coach_message').
   * The registry uses strict equality.
   */
  readonly capability: string;

  /**
   * Returns true when this materialiser claims responsibility for the given
   * capability string. Kept as a predicate (rather than relying on the
   * `capability` field alone) so future materialisers can claim wildcard or
   * prefix matches if needed (e.g. 'draft.*').
   */
  canHandle(capability: string): boolean;

  /**
   * Execute the side-effect. MUST throw on failure so the caller can keep
   * the draft in 'pending' status (rather than silently flipping to
   * 'approved' with no downstream effect — the very bug PRODUCT-1 was
   * filed against).
   *
   * Implementations MUST be idempotent on `draft.id`: a second call with
   * the same draft (e.g. retry after a transient failure, or concurrent
   * approvers racing) must NOT re-emit the side-effect. Return
   * `status='already_materialised'` to signal the no-op path.
   */
  materialize(draft: AiActionDraft): Promise<MaterializeResult>;
}
