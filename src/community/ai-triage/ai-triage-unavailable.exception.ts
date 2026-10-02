/**
 * C-626-4 — community AI triage could not be produced (the provider failed or
 * timed out, the output stayed invalid after one repair, or consent changed
 * twice before the send). Before this, those paths returned a typed EMPTY
 * triage, which the coach could not tell apart from "nothing needs
 * attention". Now the read answers 503 with a stable code, and the app shows
 * an explicit "triage unavailable" state with a retry. Nothing is cached, so
 * the retry runs the pipeline again.
 *
 * The message never names an author or says who allowed AI help.
 */
import { ServiceUnavailableException } from '@nestjs/common';

export const AI_TRIAGE_UNAVAILABLE_CODE = 'ai_triage_unavailable';

export const AI_TRIAGE_UNAVAILABLE_MESSAGE =
  'AI triage is not available right now. Your full community inbox is still below and nothing is hidden. Try again in a few minutes.';

export class AiTriageUnavailableException extends ServiceUnavailableException {
  constructor() {
    super({ code: AI_TRIAGE_UNAVAILABLE_CODE, message: AI_TRIAGE_UNAVAILABLE_MESSAGE });
  }
}
