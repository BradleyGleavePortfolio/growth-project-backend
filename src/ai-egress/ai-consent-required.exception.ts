/**
 * R2b — refusal returned when a client's data would reach an AI provider
 * without that client's live box-2 grant.
 *
 * Owner rule (10-01 13:34): no generic or vague error messages. The body
 * carries a stable machine code the apps switch on, plus a calm message that
 * says what is needed. The global HttpExceptionFilter keeps `code` and
 * `message` on the wire. 403: the request is understood and refused until the
 * client allows AI help in Settings > Privacy.
 *
 * The message never names the client, never says whether other clients
 * allowed AI help, and is only reached after the caller's access to the
 * client was established (no consent-state oracle across tenants).
 */
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { SUPPORT_EMAIL } from '../public-pages/trust-pages.html';
import type { AiConsentAudience } from './ai-egress.types';

/** Stable machine code (apps map it to the "Settings > Privacy" action). */
export const AI_CONSENT_REQUIRED_CODE = 'ai_consent_required';

export const AI_CONSENT_REQUIRED_COACH_MESSAGE =
  "This client hasn't allowed AI help yet. They can turn it on in their app under Settings > Privacy.";

export const AI_CONSENT_REQUIRED_CLIENT_MESSAGE =
  "You haven't allowed AI help yet. You can turn it on in Settings > Privacy.";

export class AiConsentRequiredException extends ForbiddenException {
  readonly audience: AiConsentAudience;

  constructor(audience: AiConsentAudience) {
    super({
      code: AI_CONSENT_REQUIRED_CODE,
      message:
        audience === 'client'
          ? AI_CONSENT_REQUIRED_CLIENT_MESSAGE
          : AI_CONSENT_REQUIRED_COACH_MESSAGE,
    });
    this.audience = audience;
  }
}

/**
 * A call site asked to send client data somewhere the consent copy does not
 * cover (a processor other than Anthropic) or declared a client subject with
 * no client id. This is a server defect, never a client choice, so it is a
 * 503 with its own code and the request is not sent.
 */
export const AI_EGRESS_POLICY_CODE = 'ai_egress_blocked';
// B-626-1 — says what happened and the working next step (support, with the
// reference shown alongside this message: `requestId` on the HTTP error
// envelope and the X-Request-ID header; on Roman's SSE stream the error frame
// stays exactly `{ code, message }` and the reference is the X-Request-ID
// header, B-626-2). It never asks the person to change their consent,
// because this refusal is a server defect, not their choice.
export const AI_EGRESS_POLICY_MESSAGE = `AI help is turned off for this request because of a problem on our side. Your account and privacy settings are fine. Contact support at ${SUPPORT_EMAIL} and include the reference shown with this message so we can fix it.`;

export class AiEgressPolicyException extends ServiceUnavailableException {
  constructor() {
    super({ code: AI_EGRESS_POLICY_CODE, message: AI_EGRESS_POLICY_MESSAGE });
  }
}

/** True for either refusal; callers that degrade on provider errors must rethrow these. */
export function isAiEgressRefusal(
  err: unknown,
): err is AiConsentRequiredException | AiEgressPolicyException {
  return err instanceof AiConsentRequiredException || err instanceof AiEgressPolicyException;
}
