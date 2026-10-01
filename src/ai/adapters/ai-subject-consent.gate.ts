import { ForbiddenException, Logger } from '@nestjs/common';

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
  /**
   * Batch form for multi-subject prompts (e.g. community triage): returns the
   * subset of `subjectUserIds` that hold a live grant for the CURRENT version.
   * One query; never throws for a missing grant (absence = excluded).
   */
  consentedSubjects(subjectUserIds: readonly string[]): Promise<Set<string>>;
}

/** Structured 403 code a coach surface receives when the CLIENT has not agreed. */
export const AI_ERROR_CLIENT_CONSENT_REQUIRED = 'CLIENT_AI_CONSENT_REQUIRED';
/** Structured 403 code when a client-subject request reaches an adapter with no gate bound. */
export const AI_ERROR_CONSENT_GATE_UNAVAILABLE = 'AI_CONSENT_GATE_UNAVAILABLE';

/** True for the structured 403s this module raises (callers must rethrow, never degrade). */
export function isSubjectConsentRefusal(err: unknown): boolean {
  if (!(err instanceof ForbiddenException)) return false;
  const body = err.getResponse();
  if (typeof body !== 'object' || body === null) return false;
  const code = (body as { code?: unknown }).code;
  return code === AI_ERROR_CLIENT_CONSENT_REQUIRED || code === AI_ERROR_CONSENT_GATE_UNAVAILABLE;
}

const gateLogger = new Logger('AiSubjectConsentGate');

/**
 * The single enforcement helper every AI provider boundary calls before it
 * sends a named client's data upstream (AnthropicAdapter, AiGatewayService,
 * ChurnInterventionService, AiService.chat). Fails closed:
 *   - no gate bound            → 403 AI_CONSENT_GATE_UNAVAILABLE
 *   - subject has no live grant for the current version → 403 CLIENT_AI_CONSENT_REQUIRED
 * Any non-403 error from the gate (e.g. database down) propagates unchanged,
 * which also stops the provider call.
 */
export async function assertSubjectAiConsent(
  gate: AiSubjectConsentGate | null | undefined,
  subjectUserId: string,
  capability: string,
): Promise<void> {
  const subject = subjectUserId?.trim();
  if (!subject) {
    // A blank subject on a path that requires one is a programming error;
    // refuse rather than send.
    throw new ForbiddenException({
      code: AI_ERROR_CONSENT_GATE_UNAVAILABLE,
      message: 'AI processing of client data is unavailable: no data subject was named.',
    });
  }
  if (!gate) {
    gateLogger.error(
      `refusing client-subject AI request: no ${AI_SUBJECT_CONSENT_GATE} bound (capability=${capability})`,
    );
    throw new ForbiddenException({
      code: AI_ERROR_CONSENT_GATE_UNAVAILABLE,
      message: 'AI processing of client data is unavailable: the consent check is not configured.',
    });
  }
  try {
    await gate.assertAiConsent(subject);
  } catch (err) {
    if (err instanceof ForbiddenException) {
      throw new ForbiddenException({
        code: AI_ERROR_CLIENT_CONSENT_REQUIRED,
        message:
          'This client has not agreed to AI processing of their data (or their agreement is out of date). They can accept it in the app.',
      });
    }
    throw err;
  }
}

/**
 * Batch filter for multi-subject prompts. Fails closed: with no gate bound
 * NOBODY is consented (empty set), so no subject's data is sent.
 */
export async function consentedAiSubjects(
  gate: AiSubjectConsentGate | null | undefined,
  subjectUserIds: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(subjectUserIds.filter((id) => typeof id === 'string' && id.trim()))];
  if (unique.length === 0 || !gate) return new Set();
  return gate.consentedSubjects(unique);
}
