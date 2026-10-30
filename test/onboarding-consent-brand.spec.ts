/**
 * W-BRAND-AGREEMENT (owner 2026-10-19 14:00 "all wording approved", 14:5x
 * "#W-BRAND-AGREEMENT - op 1"): the five agreement sentences W34-W38 name TGP
 * Fitness. Each screen the app shows today has a successor version whose text
 * is the old one with only those words changed. The server accepts the new
 * versions, still accepts v3 and every older version (the App Store build
 * sends v3 until build 10 is live), refuses an unknown version, and each
 * record keeps the version it was given (test/onboarding.service.spec.ts).
 */
import { createHash } from 'node:crypto';
import {
  CONSULT_CONSENT_COPIES,
  CONSULT_CONSENT_V3_TEXT_SHA256,
  consultConsentAiSliceText,
  consultConsentScreenText,
  consultConsentTextSha256,
} from '../src/onboarding/consult-consent-copy';
import {
  acceptedConsentVersions,
  currentConsentVersionOf,
} from '../src/onboarding/consultation-answers';

const sha = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');
const p0 = (copy_version: string, text_sha256: string) => ({
  agreed: true,
  copy_version,
  agreed_at: '2026-10-19T15:00:00.000Z',
  text_sha256,
});

// The approved "New" text, word for word (W-BRAND-approved.md rows W34-W38).
const W34 = 'TGP Fitness provides personal training and nutrition guidance only.';
const W35 =
  'To coach you, TGP Fitness and your coach collect and use what you share here: your profile, this consultation including the screening questions, your targets, food and workout logs, check-ins, any health, sleep or wearable data you choose to connect, your messages with your coach, and posts you write in the community.';
const W36 =
  'I agree to the training waiver, and to TGP Fitness and my coach collecting and using my information to coach me.';
const W37 =
  'To coach you, TGP Fitness collects and uses what you share here: your profile, this consultation including the screening questions, your targets, food and workout logs, check-ins, any health, sleep or wearable data you choose to connect, and posts you write in the community.';
const W38 =
  'I agree to the training waiver, and to TGP Fitness collecting and using my information to coach me.';
// The rest of paragraphs 1 and 3 is unchanged.
const P1 = `${W34} We do not diagnose, treat, or give medical advice. Nothing in this app replaces the advice of a physician or other qualified health provider.`;
const P3_REST = ' We use it only to provide your training. We never sell it.';

// [new version, the version it follows, pin (= the app's pin)]
const SUCCESSORS: Array<[string, string, string]> = [
  ['consult-consent-v11', 'consult-consent-v7', '4b1686a8e835297d0e6bbd91dce988b4b5b9046eb9d70aebbda9e1d36c70f926'],
  ['consult-consent-v12', 'consult-consent-v8', '8989ac25a1d87a5d6c2f355b74e1a260fb3b35231bf571a371440229d4c9f6a9'],
  ['consult-consent-v13', 'consult-consent-v9', '2f22065286d2284cc70e38921da11fcafa8c11a03887025e8781347592a163d6'],
  ['consult-consent-v14', 'consult-consent-v10', '82f3993ef5ce2262d15afe64a45b8d5ad63ca1fa42cd3e172e597d4fe761ba81'],
  [
    'consult-consent-v12-coach-free',
    'consult-consent-v8-coach-free',
    'a655bb7c794629a25fc27246dace79078a516a8ef45c357751bc2d2271ba0d64',
  ],
  [
    'consult-consent-v13-coach-free',
    'consult-consent-v9-coach-free',
    '336fcf0271843d9b9bfca35ce321480aba4925196f935b1e0ac51e260cba468b',
  ],
  [
    'consult-consent-v14-coach-free',
    'consult-consent-v10-coach-free',
    '5cb2ef1651f012bfb7a7c1569d06ecdfd43f1c33d00208d23bdf286353dfbf56',
  ],
  [
    'consult-consent-v15-coach-free',
    'consult-consent-v11-coach-free',
    'b7eb74293aac4d20c6d19ea2b7a97bec035467f8f8897a5d8e393fd7140e6864',
  ],
];
// The versions they follow, as they were (nobody who agreed is asked again).
const BEFORE: Record<string, string> = {
  'consult-consent-v7': '7711079209acecedfb50c31787787124af843f076154e9bfbd1e33550e861e09',
  'consult-consent-v8': 'b98e160e884aecdca059b90f7a88803ba84eeac79b692e83eba9f734f93274b2',
  'consult-consent-v9': '1daf2cde65d223686b4bd60f786b85866f93714176dcc8781ff94b4c9f0e30bf',
  'consult-consent-v10': '5f36acf2704699f1e7faa68d7c65b8b8ed1f1988d197774a61914b97f22ff512',
  'consult-consent-v8-coach-free': '5369ee9c57412dd2233850a7cae2043a32645431ee3b3484a14c19b8c503c633',
  'consult-consent-v9-coach-free': '4a1e19730f3fab3b8a6a8119f5425cd3c0f6ed2f502d229d25dbb7fe5df35771',
  'consult-consent-v10-coach-free': 'b79c1f039e2832560593390b7b66a91f61b2e7be5eb55ef3509ecd7a100d7c4c',
  'consult-consent-v11-coach-free': '3528b10d50d8e7bb67a3065b86ba2b5cf33f3891b8194be413c78f2519e3257f',
};

describe('W-BRAND-AGREEMENT: the agreement names TGP Fitness (W34-W38)', () => {
  it.each(SUCCESSORS)('%s is %s with only W34-W38 changed, and is pinned', (version, before, pin) => {
    const now = CONSULT_CONSENT_COPIES[version].copy;
    const was = CONSULT_CONSENT_COPIES[before].copy;
    const noCoach = now.romanIntro !== undefined;
    expect(now.paragraphs[0]).toBe(P1);
    expect(now.paragraphs[2]).toBe(`${noCoach ? W37 : W35}${P3_REST}`);
    expect(now.box1Label).toBe(noCoach ? W38 : W36);
    // Every other word is the old screen's: only the name changes, in exactly three places.
    const oldText = consultConsentScreenText(was);
    const newText = consultConsentScreenText(now);
    expect(oldText.split('The Growth Project')).toHaveLength(4);
    expect(newText).toBe(oldText.split('The Growth Project').join('TGP Fitness'));
    expect(newText).not.toMatch(/Growth Project/);
    // Paragraph 4 + box 2 are the same ledger copy box 2 grants.
    expect(consultConsentAiSliceText(now)).toBe(consultConsentAiSliceText(was));
    // The pin recomputes, and each screen counts only with its own digest.
    expect(sha(newText)).toBe(pin);
    expect(CONSULT_CONSENT_COPIES[version].text_sha256).toBe(pin);
    expect(consultConsentTextSha256(version)).toBe(pin);
    expect(currentConsentVersionOf(p0(version, pin), {})).toBe(version);
    expect(currentConsentVersionOf(p0(version, BEFORE[before]), {})).toBeNull();
    expect(currentConsentVersionOf(p0(before, pin), {})).toBeNull();
    // The version it follows stays accepted, its text and digest unchanged.
    expect(sha(oldText)).toBe(BEFORE[before]);
    expect(CONSULT_CONSENT_COPIES[before].text_sha256).toBe(BEFORE[before]);
    expect(currentConsentVersionOf(p0(before, BEFORE[before]), {})).toBe(before);
  });

  it('accepts the new versions by default, after every older version', () => {
    // The last eight are the Health-notes versions (owner #162-6, consent-health-notes.spec.ts) and the
    // STORE-E4 one-box versions (onboarding-consent-one-box.spec.ts).
    const accepted = acceptedConsentVersions({});
    expect(accepted.slice(-16, -8)).toEqual(SUCCESSORS.map(([v]) => v));
    expect(accepted.slice(0, -16)).toEqual(
      Object.keys(CONSULT_CONSENT_COPIES)
        .slice(0, -8)
        .filter((v) => !SUCCESSORS.some(([n]) => n === v)),
    );
  });

  it('still accepts v3 (the App Store build sends it until build 10 is live)', () => {
    expect(acceptedConsentVersions({})).toContain('consult-consent-v3');
    expect(CONSULT_CONSENT_V3_TEXT_SHA256).toBe(
      '79ceeb6b8316ee9e3f583fe678e2463584c6dda4c93b5c95746dfe5c52ef31c9',
    );
    expect(currentConsentVersionOf(p0('consult-consent-v3', CONSULT_CONSENT_V3_TEXT_SHA256), {})).toBe(
      'consult-consent-v3',
    );
  });

  it('refuses a version the server has no text for, whatever digest it carries', () => {
    for (const version of [
      'consult-consent-v99',
      'consult-consent-v99-coach-free',
      'consult-consent-v11-tgp',
      'tgp-fitness-v1',
    ]) {
      expect(consultConsentTextSha256(version)).toBeNull();
      for (const [, , pin] of SUCCESSORS) {
        expect(currentConsentVersionOf(p0(version, pin), {})).toBeNull();
      }
    }
  });
});
