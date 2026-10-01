// Test doubles for the data-subject AI consent gate (AI_SUBJECT_CONSENT_GATE).
//
// Every AI provider boundary now fails closed without a gate. Suites that
// exercise provider behaviour (not consent) model a client who HOLDS a live,
// current-version grant by passing ALLOW_ALL_CONSENT_GATE; the refusal paths
// are covered in test/ai/ai-consent-boundaries.spec.ts.
import { ForbiddenException } from '@nestjs/common';
import type { AiSubjectConsentGate } from '../../src/ai/adapters/ai-subject-consent.gate';

export function consentGateFor(consented: Iterable<string>): AiSubjectConsentGate & {
  assertAiConsent: jest.Mock;
  consentedSubjects: jest.Mock;
} {
  const allowed = new Set(consented);
  return {
    assertAiConsent: jest.fn(async (id: string) => {
      if (!allowed.has(id)) {
        throw new ForbiddenException({ code: 'ROMAN_CONSENT_REQUIRED', reason: 'not_granted' });
      }
    }),
    consentedSubjects: jest.fn(
      async (ids: readonly string[]) => new Set(ids.filter((id) => allowed.has(id))),
    ),
  };
}

/** Every subject consented. */
export const ALLOW_ALL_CONSENT_GATE: AiSubjectConsentGate = {
  assertAiConsent: async () => undefined,
  consentedSubjects: async (ids: readonly string[]) => new Set(ids),
};
