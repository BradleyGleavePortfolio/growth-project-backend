/**
 * ROMANMARK-BE: the one rule behind the Roman mark under a coach message.
 *
 * A sent coach message carries CoachMessage.ai_draft_id (the mobile app draws
 * the small Roman face under it) only when that id names a Roman message draft
 * of the same coach and client and the server itself marked the draft's text
 * as Roman's (ROMAN_MESSAGE_SOURCE below, never taken from a caller).
 * MessagingService.sendAsCoach applies the rule for every path that can write
 * the column. Consent is decided when Roman writes the text, not at send
 * (#ROMANMARK-CONSENT-MARK op 1): Roman's text comes only from a model call
 * through AiEgressService, which reads the client's live grant first and
 * refuses after a withdrawal (S-06), so a draft written while the client
 * allowed AI help keeps the mark when it is sent after they turn it off.
 *
 * This file imports nothing, so MessagingService, the gateway and the wearable
 * approve route can all read it without an import cycle.
 */

/** Draft capabilities whose approved draft is sent as a coach message with its draft id. */
export const ROMAN_MESSAGE_CAPABILITIES: ReadonlySet<string> = new Set([
  'draft.coach_message',
  'draft.coach_wearable_message',
]);

/**
 * Provenance source the server adds to a Roman message draft when Roman wrote
 * its text: the model's own reply (the gateway) or Roman's stored suggestion
 * for that coach and client, which the coach may edit first (S-08).
 */
export const ROMAN_MESSAGE_SOURCE = 'roman_message_text';

/** True when the draft is a Roman message draft the server marked as Roman's text. */
export function isRomanMessageDraft(draft: { capability: string; provenance: unknown }): boolean {
  if (!ROMAN_MESSAGE_CAPABILITIES.has(draft.capability) || !Array.isArray(draft.provenance)) return false;
  return draft.provenance.some(
    (p: unknown) => typeof p === 'object' && p !== null && Reflect.get(p, 'source') === ROMAN_MESSAGE_SOURCE,
  );
}
