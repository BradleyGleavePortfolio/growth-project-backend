/**
 * Process-local invalidation hook for the Roman client-context memo
 * (PLAN_roman_intelligence §2.5).
 *
 * Write paths that already bust the AI Guide cache
 * (`ClientAIContextService.invalidateForUser`: food log, workout, weight,
 * fasting, check-in, coach message) fan out here, and the paths the plan adds
 * (macro-target writes, profile updates) call `romanContextInvalidate`
 * directly. It is a plain module — no Nest DI — so no module needs to import
 * RomanModule (AiModule already imports RomanModule for the consent guard;
 * a reverse import would be a cycle).
 *
 * Fly runs several machines, so this is per machine by design; the 15 s memo
 * TTL bounds staleness on the others.
 */

type Listener = (userId: string) => void;
const listeners = new Set<Listener>();

export function onRomanContextInvalidate(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function romanContextInvalidate(userId: string): void {
  for (const l of listeners) {
    try {
      l(userId);
    } catch {
      // A listener failure must never break a write path.
    }
  }
}

/** Test seam. */
export function _resetRomanContextListeners(): void {
  listeners.clear();
}
