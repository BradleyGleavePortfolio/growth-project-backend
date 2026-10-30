// STORE-E4 (agent 185; owner #184-E5 / #184-E6 op 1, PERM-W1 / PERM-W2): the one-box "Before we
// start" screen. consult-consent-v19 (coached) and consult-consent-v18-coach-free keep paragraphs
// 1-3 of v11 / v12-coach-free, then the PERM-W1 box and the PERM-W2 footer: no paragraph 4, no
// box 2. Mobile (src/lib/consultation/copy.ts) pins the same sha256s. Older versions stay accepted.
// The plan renewal offers yes written by the same save is covered in test/onboarding.service.spec.ts.
import { createHash } from 'node:crypto';
import {
  CONSULT_CONSENT_COPIES,
  CONSULT_CONSENT_COPY_V11,
  CONSULT_CONSENT_COPY_V12_COACH_FREE,
  CONSULT_CONSENT_COPY_V18_COACH_FREE,
  CONSULT_CONSENT_COPY_V19,
  CONSULT_CONSENT_PLAN_OFFER_VERSIONS,
  CONSULT_CONSENT_V18_COACH_FREE,
  CONSULT_CONSENT_V18_COACH_FREE_TEXT_SHA256,
  CONSULT_CONSENT_V19,
  CONSULT_CONSENT_V19_TEXT_SHA256,
  consultConsentScreenText,
} from '../src/onboarding/consult-consent-copy';
import {
  DEFAULT_CONSULT_CONSENT_COPY_VERSIONS,
  acceptedConsentVersions,
  currentConsentVersionOf,
} from '../src/onboarding/consultation-answers';

const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

// The owner's words, copied exactly (PERM-W1, PERM-W2; owner 10-29 ~19:07 PDT).
const PERM_W1 =
  'I agree to the Terms of Service, Privacy Policy, Consumer Health Data Privacy Policy, community guidelines and training waiver. TGP Fitness and my coach may collect and use what I share, including health data I connect, to coach me. Photos I post in Community are checked for safety by OpenAI. TGP Fitness may send me plan renewal offers, which I can turn off in Settings.';
const PERM_W2 = "Nothing is sent until you continue. Roman's AI is a separate choice the first time you open Roman.";

// Mobile pins (src/lib/consultation/copy.ts, STORE-E4): CONSENT_COPY_SHA256_V19 / _V18_COACH_FREE.
const MOBILE_V19_SHA256 = '0959f38db47448d99d943c995b0a857454d181f3ec803e96967882b3d575ccea';
const MOBILE_V18_COACH_FREE_SHA256 = '9350dfbed5f332e0e99ea4e554731d0e8876ea5581873d6c984be3d23a149e99';

describe('STORE-E4: the one-box "Before we start" versions', () => {
  it('v19 is paragraphs 1-3 of v11, the PERM-W1 box and the PERM-W2 footer, with no box 2', () => {
    expect(CONSULT_CONSENT_COPY_V19.title).toBe('Before we start');
    expect(CONSULT_CONSENT_COPY_V19.paragraphs).toEqual(CONSULT_CONSENT_COPY_V11.paragraphs);
    expect(CONSULT_CONSENT_COPY_V19.paragraphs).toHaveLength(3);
    expect(CONSULT_CONSENT_COPY_V19.box1Label).toBe(PERM_W1);
    expect(CONSULT_CONSENT_COPY_V19.footer).toBe(PERM_W2);
    expect(CONSULT_CONSENT_COPY_V19.aiParagraph).toBeUndefined();
    expect(CONSULT_CONSENT_COPY_V19.box2Label).toBeUndefined();
    expect(CONSULT_CONSENT_COPY_V19.romanIntro).toBeUndefined();
  });

  it('v18-coach-free is the coach-free paragraphs 1-3, PERM-W1 with " and my coach" removed, and PERM-W2', () => {
    const c = CONSULT_CONSENT_COPY_V18_COACH_FREE;
    expect(c.title).toBe('Before we start');
    expect(c.paragraphs).toEqual(CONSULT_CONSENT_COPY_V12_COACH_FREE.paragraphs);
    expect(c.box1Label).toBe(PERM_W1.replace(' and my coach', ''));
    expect(c.box1Label).not.toContain('my coach');
    expect(c.footer).toBe(PERM_W2);
    expect(c.aiParagraph).toBeUndefined();
    expect(c.box2Label).toBeUndefined();
    expect(c.romanIntro).toBeUndefined();
  });

  it('each full screen text hashes to its pin, and each pin equals the mobile pin', () => {
    expect(sha(consultConsentScreenText(CONSULT_CONSENT_COPY_V19))).toBe(CONSULT_CONSENT_V19_TEXT_SHA256);
    expect(CONSULT_CONSENT_V19_TEXT_SHA256).toBe(MOBILE_V19_SHA256);
    expect(sha(consultConsentScreenText(CONSULT_CONSENT_COPY_V18_COACH_FREE))).toBe(
      CONSULT_CONSENT_V18_COACH_FREE_TEXT_SHA256,
    );
    expect(CONSULT_CONSENT_V18_COACH_FREE_TEXT_SHA256).toBe(MOBILE_V18_COACH_FREE_SHA256);
    expect(consultConsentScreenText(CONSULT_CONSENT_COPY_V19)).toBe(
      ['Before we start', ...CONSULT_CONSENT_COPY_V11.paragraphs, PERM_W1, PERM_W2].join('\n\n'),
    );
    expect(CONSULT_CONSENT_COPIES[CONSULT_CONSENT_V19].text_sha256).toBe(MOBILE_V19_SHA256);
    expect(CONSULT_CONSENT_COPIES[CONSULT_CONSENT_V18_COACH_FREE].text_sha256).toBe(MOBILE_V18_COACH_FREE_SHA256);
  });

  it('the policy-facing text never calls the box "consent" (RCW 19.373.010(6)(b)(i))', () => {
    for (const c of [CONSULT_CONSENT_COPY_V19, CONSULT_CONSENT_COPY_V18_COACH_FREE]) {
      expect(consultConsentScreenText(c)).not.toMatch(/consent/i);
    }
  });

  it('are accepted by default after every older version, which all stay accepted', () => {
    const accepted = acceptedConsentVersions({});
    expect(accepted.slice(-2)).toEqual([CONSULT_CONSENT_V19, CONSULT_CONSENT_V18_COACH_FREE]);
    expect(accepted).toEqual(DEFAULT_CONSULT_CONSENT_COPY_VERSIONS);
    expect(accepted).toEqual(Object.keys(CONSULT_CONSENT_COPIES));
  });

  it('each counts only with its own digest', () => {
    const p0 = (copy_version: string, text_sha256: string) => ({
      agreed: true,
      copy_version,
      agreed_at: '2026-10-30T08:00:00.000Z',
      text_sha256,
    });
    expect(currentConsentVersionOf(p0(CONSULT_CONSENT_V19, MOBILE_V19_SHA256), {})).toBe(CONSULT_CONSENT_V19);
    expect(currentConsentVersionOf(p0(CONSULT_CONSENT_V18_COACH_FREE, MOBILE_V18_COACH_FREE_SHA256), {})).toBe(
      CONSULT_CONSENT_V18_COACH_FREE,
    );
    expect(currentConsentVersionOf(p0(CONSULT_CONSENT_V19, MOBILE_V18_COACH_FREE_SHA256), {})).toBeNull();
    expect(
      currentConsentVersionOf(p0(CONSULT_CONSENT_V19, CONSULT_CONSENT_COPIES['consult-consent-v18'].text_sha256), {}),
    ).toBeNull();
    expect(currentConsentVersionOf({ ...p0(CONSULT_CONSENT_V19, MOBILE_V19_SHA256), agreed: false }, {})).toBeNull();
  });

  it('only the two one-box versions carry the plan renewal offers yes', () => {
    expect([...CONSULT_CONSENT_PLAN_OFFER_VERSIONS].sort()).toEqual(
      [CONSULT_CONSENT_V18_COACH_FREE, CONSULT_CONSENT_V19].sort(),
    );
    for (const [version, { copy }] of Object.entries(CONSULT_CONSENT_COPIES)) {
      expect(CONSULT_CONSENT_PLAN_OFFER_VERSIONS.has(version)).toBe(copy.box1Label.includes('plan renewal offers'));
    }
  });
});
