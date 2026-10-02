/**
 * R2b fix round (B-626-1) — the 503 `ai_egress_blocked` refusal says what
 * happened and the working next step (owner rule 13:34: every user-facing
 * failure names an action). It points to support with the request
 * reference, and never asks the person to change consent, because this
 * refusal is a server defect, not their choice. The Roman SSE path is pinned
 * in test/roman/roman-streaming.spec.ts (error event carries the requestId).
 */
import {
  AI_EGRESS_POLICY_CODE,
  AI_EGRESS_POLICY_MESSAGE,
  AiEgressPolicyException,
} from '../../src/ai-egress/ai-consent-required.exception';
import { SUPPORT_EMAIL } from '../../src/public-pages/trust-pages.html';

describe('ai_egress_blocked copy (B-626-1)', () => {
  it('is a 503 with the stable code and a message naming the support path and the reference', () => {
    const err = new AiEgressPolicyException();
    expect(err.getStatus()).toBe(503);
    expect(err.getResponse()).toEqual({
      code: AI_EGRESS_POLICY_CODE,
      message: AI_EGRESS_POLICY_MESSAGE,
    });
    expect(AI_EGRESS_POLICY_CODE).toBe('ai_egress_blocked');
    expect(AI_EGRESS_POLICY_MESSAGE).toBe(
      `AI help is turned off for this request because of a problem on our side. Your account and privacy settings are fine. Contact support at ${SUPPORT_EMAIL} and include the reference shown with this message so we can fix it.`,
    );
  });

  it('never asks for consent, and follows the copy rules (no exclamation marks)', () => {
    expect(AI_EGRESS_POLICY_MESSAGE).not.toMatch(/Settings|allow AI|turn it on/);
    expect(AI_EGRESS_POLICY_MESSAGE).not.toContain('!');
  });
});
