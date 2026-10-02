import type { Prisma } from '@prisma/client';

/**
 * Completion effects that must happen exactly once (welcome-message
 * scheduling, reminder seeding, ...). Hooks run INSIDE the fenced completion
 * transaction of OnboardingService.complete: they see the transaction client,
 * and if the attempt is fenced off (lease expired and another worker won) or
 * anything fails, their writes roll back with the rest. Hooks must only write
 * through `tx` and must not perform external side effects directly; enqueue
 * a durable job row instead.
 */
export const ONBOARDING_COMPLETION_HOOKS = Symbol('ONBOARDING_COMPLETION_HOOKS');

export interface OnboardingCompletedEvent {
  client_id: string;
  coach_id: string;
  completed_at: Date;
  /** C1, YYYY-MM-DD. */
  first_session_date: string;
  /** S2 option value, or null. */
  preferred_training_time: string | null;
}

export interface OnboardingCompletionHook {
  onCompleted(tx: Prisma.TransactionClient, event: OnboardingCompletedEvent): Promise<void>;
}
