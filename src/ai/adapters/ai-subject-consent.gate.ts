/**
 * AiSubjectConsentGate — the DATA SUBJECT's permission check at a provider
 * boundary (Sol audit of #601, finding A2).
 *
 * Any code path that sends a CLIENT's data to a third-party model must check
 * that the CLIENT (not the coach, not the caller) holds a live AI processing
 * grant for the current consent version. The coach's own grant never
 * authorises processing of a client's data.
 *
 * `AnthropicAdapter` consults this gate before EVERY upstream request made
 * with `opts.clientId` set, including retries and the structured-JSON repair
 * pass, so a grant withdrawn between two attempts stops the second attempt.
 *
 * Fail closed: when a request names a client subject and no gate is bound,
 * the adapter refuses rather than sending.
 *
 * `RomanConsentService` is the production implementation (bound in
 * CoachAIModule via `useExisting`). The interface lives here so src/ai does
 * not import src/roman types.
 */

export const AI_SUBJECT_CONSENT_GATE = 'AI_SUBJECT_CONSENT_GATE';

export interface AiSubjectConsentGate {
  /** Throws a ForbiddenException unless the subject holds a live, current grant. */
  assertAiConsent(subjectUserId: string): Promise<void>;
}

/** Structured 403 code a coach surface receives when the CLIENT has not agreed. */
export const AI_ERROR_CLIENT_CONSENT_REQUIRED = 'CLIENT_AI_CONSENT_REQUIRED';
/** Structured 403 code when a client-subject request reaches an adapter with no gate bound. */
export const AI_ERROR_CONSENT_GATE_UNAVAILABLE = 'AI_CONSENT_GATE_UNAVAILABLE';
