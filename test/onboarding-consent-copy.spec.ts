// #607 P0 consent copy truth: consult-consent-v3 is byte-identical to the
// screen mobile #310 shows, and only a P0 that proves that exact text counts.
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  CONSULT_CONSENT_COPIES,
  CONSULT_CONSENT_COPY_V3,
  CONSULT_CONSENT_V3,
  CONSULT_CONSENT_V4,
  CONSULT_CONSENT_V3_AI_SLICE_SHA256,
  CONSULT_CONSENT_V3_TEXT_SHA256,
  consultConsentAiSliceText,
  consultConsentScreenText,
  consultConsentTextSha256,
  unknownConsultConsentVersions,
} from '../src/onboarding/consult-consent-copy';
import {
  DEFAULT_CONSULT_CONSENT_COPY_VERSION,
  acceptedConsentVersions,
  currentConsentVersionOf,
  isCurrentConsentAnswer,
} from '../src/onboarding/consultation-answers';
import { ENV_RULES } from '../src/common/env-validation';

const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
const V3 = CONSULT_CONSENT_COPY_V3;

// Mobile #310 pins (src/lib/consultation/copy.ts at f85ffd36):
//   CONSENT_COPY_SHA256    = sha256(consentCopyText())
//   AI_CONSENT_COPY_SHA256 = sha256(aiConsentCopyText()) = ledger client-ai-v4 copy sha256
const MOBILE_CONSENT_COPY_SHA256 =
  '79ceeb6b8316ee9e3f583fe678e2463584c6dda4c93b5c95746dfe5c52ef31c9';
const MOBILE_AI_CONSENT_COPY_SHA256 =
  'fbf821401d4313c6a301a6cc08d3870bb117c293fbb970e321bf87f49abe34f4';

describe('consult-consent-v3 text parity with mobile #310', () => {
  it('the full screen text hashes to the pin, and the pin equals mobile CONSENT_COPY_SHA256', () => {
    const text = consultConsentScreenText(V3);
    expect(sha(text)).toBe(CONSULT_CONSENT_V3_TEXT_SHA256);
    expect(CONSULT_CONSENT_V3_TEXT_SHA256).toBe(MOBILE_CONSENT_COPY_SHA256);
    // Display order and separator: title, P1-P3, box 1, P4, box 2, footer, "\n\n".
    expect(text.split('\n\n')).toEqual([
      'Before we start',
      ...V3.paragraphs,
      V3.box1Label,
      V3.aiParagraph,
      V3.box2Label,
      V3.footer,
    ]);
    expect(Buffer.byteLength(text, 'utf8')).toBe(1613);
  });

  it('paragraph 4 + box 2 equal the client-ai-v4 ledger copy byte for byte (shared digest)', () => {
    expect(sha(consultConsentAiSliceText(V3))).toBe(CONSULT_CONSENT_V3_AI_SLICE_SHA256);
    expect(CONSULT_CONSENT_V3_AI_SLICE_SHA256).toBe(MOBILE_AI_CONSENT_COPY_SHA256);
  });

  it('states true AI chat retention and keeps the copy rules', () => {
    const text = consultConsentScreenText(V3);
    expect(V3.aiParagraph).toMatch(
      /Your conversations with Roman are private from your coach and are kept until you delete them or delete your account\.$/,
    );
    expect(text).not.toMatch(/180 days|days\b/);
    expect(text).not.toMatch(/!/);
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    // Straight apostrophes only (the digest is over these exact bytes).
    expect(text).not.toMatch(/[\u2018\u2019\u201C\u201D]/);
    expect(V3.box2Label.startsWith('Optional: ')).toBe(true);
  });

  it('the registry knows v3 and v4 only (no compat window for v2 or v1)', () => {
    expect(Object.keys(CONSULT_CONSENT_COPIES)).toEqual([CONSULT_CONSENT_V3, CONSULT_CONSENT_V4]);
    expect(consultConsentTextSha256('consult-consent-v3')).toBe(CONSULT_CONSENT_V3_TEXT_SHA256);
    expect(consultConsentTextSha256('consult-consent-v2')).toBeNull();
    expect(consultConsentTextSha256('consult-consent-v1')).toBeNull();
    expect(consultConsentTextSha256('constructor')).toBeNull();
    expect(consultConsentTextSha256('__proto__')).toBeNull();
    expect(DEFAULT_CONSULT_CONSENT_COPY_VERSION).toBe('consult-consent-v3');
  });
});

describe('accepted versions and the P0 truth rule', () => {
  const P0 = {
    agreed: true,
    copy_version: 'consult-consent-v3',
    agreed_at: '2026-10-02T08:00:00.000Z',
    text_sha256: MOBILE_CONSENT_COPY_SHA256,
  };

  it('acceptedConsentVersions: default v3 + v4; the override keeps only versions with known text', () => {
    const defaults = ['consult-consent-v3', 'consult-consent-v4'];
    expect(acceptedConsentVersions({})).toEqual(defaults);
    expect(acceptedConsentVersions({ CONSULT_CONSENT_COPY_VERSIONS: '' })).toEqual(defaults);
    expect(
      acceptedConsentVersions({ CONSULT_CONSENT_COPY_VERSIONS: 'consult-consent-v2' }),
    ).toEqual(defaults);
    expect(
      acceptedConsentVersions({
        CONSULT_CONSENT_COPY_VERSIONS:
          ' consult-consent-v9 , consult-consent-v3,consult-consent-v3',
      }),
    ).toEqual(['consult-consent-v3']);
  });

  it("only agreed + accepted version + that version's exact digest is current", () => {
    expect(currentConsentVersionOf(P0, {})).toBe('consult-consent-v3');
    expect(isCurrentConsentAnswer(P0, {})).toBe(true);
    // `version` is accepted as the copy-version key too.
    const { copy_version: _cv, ...viaVersion } = P0;
    expect(currentConsentVersionOf({ ...viaVersion, version: 'consult-consent-v3' }, {})).toBe(
      'consult-consent-v3',
    );
    const { text_sha256: _s, ...noDigest } = P0;
    for (const bad of [
      noDigest,
      { ...P0, text_sha256: MOBILE_AI_CONSENT_COPY_SHA256 },
      { ...P0, text_sha256: P0.text_sha256.toUpperCase() },
      { ...P0, agreed: false },
      { ...P0, agreed: 'true' },
      { ...P0, copy_version: 'consult-consent-v2' },
      { ...P0, copy_version: 'consult-consent-v4' },
      null,
      undefined,
      'yes',
      [P0],
    ]) {
      expect(currentConsentVersionOf(bad, {})).toBeNull();
      expect(isCurrentConsentAnswer(bad, {})).toBe(false);
    }
  });
});

describe('CONSULT_CONSENT_COPY_VERSIONS env rule (S-ENVTRUTH)', () => {
  const rule = ENV_RULES.find((r) => r.name === 'CONSULT_CONSENT_COPY_VERSIONS');

  it('is registered as optional with its real default and no boot validator', () => {
    expect(rule).toBeDefined();
    expect(rule?.tier).toBe('optional');
    expect(rule?.default).toMatch(/consult-consent-v3/);
    expect(rule?.validate).toBeUndefined();
  });

  it('names every listed version the server has no consent text for, and warns once per value', () => {
    expect(unknownConsultConsentVersions('consult-consent-v3')).toEqual([]);
    expect(unknownConsultConsentVersions('consult-consent-v2, consult-consent-v3,x')).toEqual([
      'consult-consent-v2',
      'x',
    ]);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const env = { CONSULT_CONSENT_COPY_VERSIONS: 'consult-consent-v3, consult-consent-v8' };
      expect(acceptedConsentVersions(env)).toEqual(['consult-consent-v3']);
      expect(acceptedConsentVersions(env)).toEqual(['consult-consent-v3']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/consult-consent-v8/);
    } finally {
      warn.mockRestore();
    }
  });
});
