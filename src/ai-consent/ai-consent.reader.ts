/**
 * R2a — the narrow read interface every AI path uses to check the DATA
 * SUBJECT's box-2 grant (D2 contract: "Any server path that sends a client's
 * data to Anthropic must require that client's box-2 grant").
 *
 * Contract for callers (R2b and any later AI path):
 *   - Pass the id of the client whose data is about to be sent, never the
 *     caller's id when the caller is a coach.
 *   - Call it immediately before EVERY provider request (first attempt,
 *     retries, repair passes). Results are never cached here.
 *   - `false` means do not send. It is returned for: no decision on record,
 *     latest decision is a withdraw, a grant of an older copy version or sha256,
 *     ledger flag off, or a read failure (fail closed).
 *
 * Inject with `@Inject(CLIENT_AI_CONSENT_READER)`; AiConsentModule exports it.
 */
export const CLIENT_AI_CONSENT_READER = Symbol('CLIENT_AI_CONSENT_READER');

export interface ClientAiConsentReader {
  /** True only for a live grant of the CURRENT copy (version + sha256). Never throws. */
  hasClientAiConsent(userId: string): Promise<boolean>;
  /**
   * Batch form: the subset of `userIds` holding a live grant of the current
   * copy. At most AI_CONSENT_BATCH_MAX ids per call (RangeError above that).
   * Never throws for read failures (returns an empty set).
   */
  clientsWithAiConsent(userIds: readonly string[]): Promise<ReadonlySet<string>>;
}
