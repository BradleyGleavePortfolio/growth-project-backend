/**
 * FIX684 (Sol B1 on growth-project-mobile#684): every consent record names the
 * exact screen the client was shown, and its version and digest rebuild every
 * word on it, in both memory states.
 *
 * ROWS is every P0 screen the app shows today: with a coach and with no coach
 * (W-CONSENT: the Roman choice under "Before you join a coach"), memory off and
 * on; with no coach also while FEATURE_ROMAN_CRISIS_ALERT is on (the crisis
 * twins, paragraph 4 = client-ai-v8 / v9; the coached crisis screens are rows
 * of consent-crisis-sentence.spec.ts), and each again with TGP Fitness as the name (W-BRAND-AGREEMENT;
 * the first six stay for builds that still show them). Each row builds the shown screen from its parts
 * in display order
 * (paragraph 4 and box 2 from the AI consent ledger, the heading and lead word
 * for word) and proves: it hashes to the version's pin (the app pins the same
 * value), the registry holds exactly that text, the verifier accepts the record
 * only with that digest, and paragraph 4 + box 2 equal the ledger copy box 2
 * grants. Older versions stay accepted with their digests unchanged.
 */
import { createHash } from 'node:crypto';
import {
  CLIENT_AI_CONSENT_ACCEPTED,
  CLIENT_AI_CONSENT_BOX_LABEL,
  CLIENT_AI_CONSENT_V6_PARAGRAPH,
  CLIENT_AI_CONSENT_V7_PARAGRAPH,
  CLIENT_AI_CONSENT_V8_PARAGRAPH,
  CLIENT_AI_CONSENT_V9_PARAGRAPH,
  CLIENT_AI_CONSENT_V10_PARAGRAPH,
  CLIENT_AI_CONSENT_V11_PARAGRAPH,
  CLIENT_AI_CONSENT_V12_PARAGRAPH,
  CLIENT_AI_CONSENT_V13_PARAGRAPH,
} from '../../src/ai-consent/ai-consent.constants';
import {
  CONSULT_CONSENT_COPIES,
  CONSULT_CONSENT_COPY_V5,
  CONSULT_CONSENT_COPY_V7_COACH_FREE,
  consultConsentAiSliceText,
  consultConsentScreenText,
} from '../../src/onboarding/consult-consent-copy';
import {
  acceptedConsentVersions,
  currentConsentVersionOf,
} from '../../src/onboarding/consultation-answers';

const sha = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');
const p0 = (copy_version: string, text_sha256: string) => ({
  agreed: true,
  copy_version,
  agreed_at: '2026-10-15T08:00:00.000Z',
  text_sha256,
});

const HEADING = 'Before you join a coach';
const LEAD =
  'Roman works with a coach, so he is not available until you join one. If you allow this now, Roman is ready on the day you join and you will not be asked again.';
const C = CONSULT_CONSENT_COPY_V5;
const F = CONSULT_CONSENT_COPY_V7_COACH_FREE;
const coached = (p4: string): string[] => [
  C.title,
  ...C.paragraphs,
  C.box1Label,
  p4,
  CLIENT_AI_CONSENT_BOX_LABEL,
  C.footer,
];
const noCoach = (p4: string): string[] => [
  F.title,
  ...F.paragraphs,
  F.box1Label,
  HEADING,
  LEAD,
  p4,
  CLIENT_AI_CONSENT_BOX_LABEL,
  'Nothing is sent until you continue.',
];
/** W34-W38: the same parts with TGP Fitness as the name (paragraph 1, paragraph 3, box 1). */
const tgp = (parts: string[]): string[] => parts.map((p) => p.replace('The Growth Project', 'TGP Fitness'));

// [screen, P0 version recorded, shown parts in display order, pin (= app pin), AI copy box 2 grants]
const ROWS: Array<[string, string, string[], string, string]> = [
  [
    'coached, memory off',
    'consult-consent-v7',
    coached(CLIENT_AI_CONSENT_V6_PARAGRAPH),
    '7711079209acecedfb50c31787787124af843f076154e9bfbd1e33550e861e09',
    'client-ai-v6',
  ],
  [
    'coached, memory on',
    'consult-consent-v8',
    coached(CLIENT_AI_CONSENT_V7_PARAGRAPH),
    'b98e160e884aecdca059b90f7a88803ba84eeac79b692e83eba9f734f93274b2',
    'client-ai-v7',
  ],
  [
    'no coach, memory off',
    'consult-consent-v8-coach-free',
    noCoach(CLIENT_AI_CONSENT_V6_PARAGRAPH),
    '5369ee9c57412dd2233850a7cae2043a32645431ee3b3484a14c19b8c503c633',
    'client-ai-v6',
  ],
  [
    'no coach, memory on',
    'consult-consent-v9-coach-free',
    noCoach(CLIENT_AI_CONSENT_V7_PARAGRAPH),
    '4a1e19730f3fab3b8a6a8119f5425cd3c0f6ed2f502d229d25dbb7fe5df35771',
    'client-ai-v7',
  ],
  [
    'no coach, memory off, crisis switch on',
    'consult-consent-v10-coach-free',
    noCoach(CLIENT_AI_CONSENT_V8_PARAGRAPH),
    'b79c1f039e2832560593390b7b66a91f61b2e7be5eb55ef3509ecd7a100d7c4c',
    'client-ai-v8',
  ],
  [
    'no coach, memory on, crisis switch on',
    'consult-consent-v11-coach-free',
    noCoach(CLIENT_AI_CONSENT_V9_PARAGRAPH),
    '3528b10d50d8e7bb67a3065b86ba2b5cf33f3891b8194be413c78f2519e3257f',
    'client-ai-v9',
  ],
  [
    'coached, memory off, TGP Fitness',
    'consult-consent-v11',
    tgp(coached(CLIENT_AI_CONSENT_V6_PARAGRAPH)),
    '4b1686a8e835297d0e6bbd91dce988b4b5b9046eb9d70aebbda9e1d36c70f926',
    'client-ai-v6',
  ],
  [
    'coached, memory on, TGP Fitness',
    'consult-consent-v12',
    tgp(coached(CLIENT_AI_CONSENT_V7_PARAGRAPH)),
    '8989ac25a1d87a5d6c2f355b74e1a260fb3b35231bf571a371440229d4c9f6a9',
    'client-ai-v7',
  ],
  [
    'no coach, memory off, TGP Fitness',
    'consult-consent-v12-coach-free',
    tgp(noCoach(CLIENT_AI_CONSENT_V6_PARAGRAPH)),
    'a655bb7c794629a25fc27246dace79078a516a8ef45c357751bc2d2271ba0d64',
    'client-ai-v6',
  ],
  [
    'no coach, memory on, TGP Fitness',
    'consult-consent-v13-coach-free',
    tgp(noCoach(CLIENT_AI_CONSENT_V7_PARAGRAPH)),
    '336fcf0271843d9b9bfca35ce321480aba4925196f935b1e0ac51e260cba468b',
    'client-ai-v7',
  ],
  [
    'no coach, memory off, crisis switch on, TGP Fitness',
    'consult-consent-v14-coach-free',
    tgp(noCoach(CLIENT_AI_CONSENT_V8_PARAGRAPH)),
    '5cb2ef1651f012bfb7a7c1569d06ecdfd43f1c33d00208d23bdf286353dfbf56',
    'client-ai-v8',
  ],
  [
    'no coach, memory on, crisis switch on, TGP Fitness',
    'consult-consent-v15-coach-free',
    tgp(noCoach(CLIENT_AI_CONSENT_V9_PARAGRAPH)),
    'b7eb74293aac4d20c6d19ea2b7a97bec035467f8f8897a5d8e393fd7140e6864',
    'client-ai-v9',
  ],
  // Owner #162-6: paragraph 4 names the Health-page notes (?variant=health_notes, memory on).
  [
    'coached, memory on, Health notes, TGP Fitness',
    'consult-consent-v15',
    tgp(coached(CLIENT_AI_CONSENT_V10_PARAGRAPH)),
    '2472c790626ed1ca2d6d7aaa87a39cf3dc0b51371bf94d6ad1679106f34cf0c3',
    'client-ai-v10',
  ],
  [
    'coached, memory on, crisis switch on, Health notes, TGP Fitness',
    'consult-consent-v16',
    tgp(coached(CLIENT_AI_CONSENT_V11_PARAGRAPH)),
    '6c03faf6263e93a90f67eb56e748611a29c6cab7fc2af044f3922f61aff16d0c',
    'client-ai-v11',
  ],
  [
    'no coach, memory on, Health notes, TGP Fitness',
    'consult-consent-v16-coach-free',
    tgp(noCoach(CLIENT_AI_CONSENT_V10_PARAGRAPH)),
    '839832214a19353323a18f8e64443bba6db7172f3982c413a65281a72a441c54',
    'client-ai-v10',
  ],
  [
    'no coach, memory on, crisis switch on, Health notes, TGP Fitness',
    'consult-consent-v17-coach-free',
    tgp(noCoach(CLIENT_AI_CONSENT_V11_PARAGRAPH)),
    '4030570aae763dd4b4ca578b0472298070e8ce0eea60cc18a123d952fc767ba1',
    'client-ai-v11',
  ],
  // Memory off (coached only: a client with no coach gets no Health notes).
  [
    'coached, memory off, Health notes, TGP Fitness',
    'consult-consent-v17',
    tgp(coached(CLIENT_AI_CONSENT_V12_PARAGRAPH)),
    'ea511e82574f9ec446105028cf3547b66a5916523bd2329f60e4d9f5ce996b99',
    'client-ai-v12',
  ],
  [
    'coached, memory off, crisis switch on, Health notes, TGP Fitness',
    'consult-consent-v18',
    tgp(coached(CLIENT_AI_CONSENT_V13_PARAGRAPH)),
    '9ce19233f793ba3d4f82a5240481b4810da0a2f5dadf5b9c7a98936a14794e72',
    'client-ai-v13',
  ],
];

// Every older version, as it was (#CRISIS-OLD-CONSENT op 1: nobody is asked again).
const OLDER: Record<string, string> = {
  'consult-consent-v3': '79ceeb6b8316ee9e3f583fe678e2463584c6dda4c93b5c95746dfe5c52ef31c9',
  'consult-consent-v4': '74d0a48ad2b0a50f6f8e699fe6d131f0262f35ce1fff6248c9770d9267a5fb1a',
  'consult-consent-v5': '926b4ec8abe6d003798b44d720f625aa69871f59b4963cc5ec39f8599c2255fa',
  'consult-consent-v6': '6b15d88b6bf9b77f11c526f073936264c6253fbc54474a7cdd8c55b564f5e9ee',
  'consult-consent-v5-coach-free': 'c56fc409ca188fdcd8a7f52209d72299e3bf19ea68bff0e01b35b1f3295826b5',
  'consult-consent-v6-coach-free': 'a1769134cf30a3208ef56a8906603d942fb2ca058db9c33c69f4ff14f223ee00',
  'consult-consent-v7-coach-free': '82dddf635ee262e30e8a69e7a4a39be3e1255470d70b12e42a757f7578ee95a3',
};

describe('FIX684: each P0 record rebuilds the screen shown (coached, no coach, each memory state)', () => {
  it.each(ROWS)('%s records %s', (_screen, version, parts, pin, aiVersion) => {
    const shown = parts.join('\n\n');
    expect(sha(shown)).toBe(pin);
    expect(consultConsentScreenText(CONSULT_CONSENT_COPIES[version].copy)).toBe(shown);
    expect(CONSULT_CONSENT_COPIES[version].text_sha256).toBe(pin);
    expect(acceptedConsentVersions({})).toContain(version);
    expect(currentConsentVersionOf(p0(version, pin), {})).toBe(version);
    for (const [, other, , otherPin] of ROWS) {
      if (other !== version) expect(currentConsentVersionOf(p0(version, otherPin), {})).toBeNull();
    }
    // Paragraph 4 + box 2 are, byte for byte, the ledger copy that box 2 grants.
    expect(sha(consultConsentAiSliceText(CONSULT_CONSENT_COPIES[version].copy))).toBe(
      CLIENT_AI_CONSENT_ACCEPTED[aiVersion].copy_sha256,
    );
  });

  it('the list is complete: every registered no-coach screen with the Roman choice is a row', () => {
    const withRoman = Object.entries(CONSULT_CONSENT_COPIES)
      .filter(([, e]) => e.copy.romanIntro !== undefined)
      .map(([v]) => v);
    expect(withRoman.sort()).toEqual([
      'consult-consent-v10-coach-free',
      'consult-consent-v11-coach-free',
      'consult-consent-v12-coach-free',
      'consult-consent-v13-coach-free',
      'consult-consent-v14-coach-free',
      'consult-consent-v15-coach-free',
      'consult-consent-v16-coach-free',
      'consult-consent-v17-coach-free',
      'consult-consent-v8-coach-free',
      'consult-consent-v9-coach-free',
    ]);
    for (const v of withRoman) expect(ROWS.map(([, rv]) => rv)).toContain(v);
  });

  it('older versions stay accepted, each with its digest unchanged', () => {
    for (const [version, pin] of Object.entries(OLDER)) {
      expect(CONSULT_CONSENT_COPIES[version].text_sha256).toBe(pin);
      expect(sha(consultConsentScreenText(CONSULT_CONSENT_COPIES[version].copy))).toBe(pin);
      expect(currentConsentVersionOf(p0(version, pin), {})).toBe(version);
    }
    expect(F.romanIntro).toBeUndefined();
  });
});
