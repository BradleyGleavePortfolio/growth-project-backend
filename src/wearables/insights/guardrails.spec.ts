import {
  applyGuardrails,
  calibrateConfidence,
  redactProviderTokens,
  MEDICALIZE_BLOCK_RULES,
} from './guardrails';

// PR-HK-4 guardrail contract tests. The no-medicalize block-list and the
// confidence-calibration boundaries are anchored here so the auditor can
// reproduce each rejection and each boundary independently.

describe('applyGuardrails — no-medicalize block-list', () => {
  // Each blocked term in a representative sentence. One assertion per
  // spec term so a regression on any single word is isolated.
  const BLOCKED_SENTENCES: { term: string; text: string; expectLabel: string }[] = [
    { term: 'apnea', text: 'This pattern looks like sleep apnea to me.', expectLabel: 'medicalize:apnea' },
    { term: 'arrhythmia', text: 'The heart rate suggests an arrhythmia.', expectLabel: 'medicalize:arrhythmia' },
    { term: 'insomnia', text: 'Your client clearly has insomnia.', expectLabel: 'medicalize:insomnia' },
    { term: 'depression', text: 'These trends point to depression.', expectLabel: 'medicalize:depression' },
    { term: 'disorder', text: 'This is a metabolic disorder.', expectLabel: 'medicalize:disorder' },
    { term: 'diagnose', text: 'I would diagnose this as overtraining.', expectLabel: 'medicalize:diagnos*' },
    { term: 'diagnosis', text: 'My diagnosis is poor recovery.', expectLabel: 'medicalize:diagnos*' },
    { term: 'treat', text: 'We should treat the low HRV directly.', expectLabel: 'medicalize:treat*' },
    { term: 'treatment', text: 'A treatment plan is needed here.', expectLabel: 'medicalize:treat*' },
    { term: 'cure', text: 'This will cure the fatigue.', expectLabel: 'medicalize:cure' },
    { term: 'anxiety disorder', text: 'Signs of an anxiety disorder.', expectLabel: 'medicalize:disorder' },
    { term: 'sleep disorder', text: 'A sleep disorder is likely.', expectLabel: 'medicalize:disorder' },
  ];

  it.each(BLOCKED_SENTENCES)(
    'rejects medicalizing term "$term"',
    ({ text }) => {
      const res = applyGuardrails(text);
      expect(res.rejected).toBe(true);
      expect(res.reason).toMatch(/^medicalize:/);
      // The original text is returned unchanged on rejection.
      expect(res.text).toBe(text);
    },
  );

  it('matches the first blocking rule label for "diagnose"', () => {
    expect(applyGuardrails('I will diagnose this.').reason).toBe('medicalize:diagnos*');
  });

  it('passes clean coaching copy unchanged', () => {
    const clean =
      'Your recovery has trended down this week; prioritise an earlier bedtime tonight.';
    const res = applyGuardrails(clean);
    expect(res.rejected).toBe(false);
    expect(res.reason).toBeUndefined();
    expect(res.text).toBe(clean);
  });

  it('does not false-positive on embedded substrings (word boundary)', () => {
    // The stem rules are word-boundaried (\b), so "treat" inside "retreat"
    // and "cure" inside "secure" do NOT trip — only standalone clinical
    // terms are blocked. This pins the boundary behaviour so a future
    // looser regex can't silently start rejecting benign coaching copy.
    expect(applyGuardrails('a great retreat in the mountains').rejected).toBe(false);
    expect(applyGuardrails('your sleep felt secure and steady').rejected).toBe(false);
  });

  it('treats empty / non-string input as a clean pass', () => {
    expect(applyGuardrails('').rejected).toBe(false);
    // @ts-expect-error — defensive runtime guard for non-string input
    expect(applyGuardrails(undefined).rejected).toBe(false);
  });

  it('exposes the full block-rule set for audit', () => {
    const labels = MEDICALIZE_BLOCK_RULES.map((r) => r.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        'apnea',
        'arrhythmia',
        'insomnia',
        'depression',
        'disorder',
        'diagnos*',
        'treat*',
        'cure',
        'anxiety disorder',
        'sleep disorder',
      ]),
    );
  });
});

describe('calibrateConfidence — boundary exactness', () => {
  it('maps below 0.6 to i_think', () => {
    expect(calibrateConfidence(0)).toBe('i_think');
    expect(calibrateConfidence(0.59)).toBe('i_think');
    expect(calibrateConfidence(0.5999)).toBe('i_think');
  });

  it('maps [0.6, 0.8) to fairly_sure', () => {
    expect(calibrateConfidence(0.6)).toBe('fairly_sure');
    expect(calibrateConfidence(0.7)).toBe('fairly_sure');
    expect(calibrateConfidence(0.79)).toBe('fairly_sure');
  });

  it('maps [0.8, 0.9) to confident', () => {
    expect(calibrateConfidence(0.8)).toBe('confident');
    expect(calibrateConfidence(0.85)).toBe('confident');
    expect(calibrateConfidence(0.89)).toBe('confident');
  });

  it('maps [0.9, 1.0) to certain', () => {
    expect(calibrateConfidence(0.9)).toBe('certain');
    expect(calibrateConfidence(0.95)).toBe('certain');
    expect(calibrateConfidence(0.999)).toBe('certain');
  });

  it('maps exactly 1.0 to verified', () => {
    expect(calibrateConfidence(1.0)).toBe('verified');
  });

  it('clamps out-of-range and non-finite inputs', () => {
    expect(calibrateConfidence(1.4)).toBe('verified');
    expect(calibrateConfidence(-1)).toBe('i_think');
    expect(calibrateConfidence(NaN)).toBe('i_think');
  });
});

describe('redactProviderTokens', () => {
  it('redacts a bearer header value', () => {
    const out = redactProviderTokens('Authorization: Bearer abc123def456ghi');
    expect(out).not.toContain('abc123def456ghi');
    expect(out.toLowerCase()).toContain('bearer [redacted]');
  });

  it('redacts access_token assignments', () => {
    const out = redactProviderTokens('access_token=eyJhbGexamplevalue123');
    expect(out).not.toContain('eyJhbGexamplevalue123');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts JWT-shaped opaque tokens', () => {
    const jwt =
      'header12345678901234567890123456.payload8chars.signature8';
    const out = redactProviderTokens(`token is ${jwt}`);
    expect(out).toContain('[REDACTED_TOKEN]');
    expect(out).not.toContain(jwt);
  });

  it('leaves clean prose untouched', () => {
    const clean = 'Your HRV averaged 42ms over the last week.';
    expect(redactProviderTokens(clean)).toBe(clean);
  });
});
