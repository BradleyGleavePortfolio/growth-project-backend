// C05 — consultation answer validation, merge, completeness and profile mapping.
import {
  completedChapters,
  injuryFlag,
  macroRawFromAnswers,
  mergeAnswers,
  missingRequired,
  profileFieldsFromAnswers,
  screeningAnyYes,
  validateAnswerPatch,
  type Answers,
} from '../src/onboarding/consultation-answers';
import { computeMacros, resolveMacroInputs } from '../src/macros/macro-calculator';

const NOW = new Date('2026-10-01T12:00:00.000Z');

const COMPLETE: Answers = {
  G1: 'fat_loss',
  B1: 'female',
  B2: '1988-04-01',
  B3: { height_cm: 167.64, weight_lbs: 172, unit: 'imperial' },
  B4: 150,
  L1: 'moderate',
  T1: 'beginner',
  T3: 'no',
  S1: '3',
  S2: 'morning',
  S3: 'gym',
  N1: 'none',
  N2: ['nothing'],
  N3: '3',
  P0: { agreed: true, copy_version: 'consult-consent-v2', agreed_at: '2026-10-01T11:59:00.000Z' },
  P1: 'no',
  P2: 'no',
  P3: 'no',
  P4: 'no',
  P5: 'no',
  P6: 'no',
  P7: 'no',
  C1: '2026-10-05',
};

describe('validateAnswerPatch', () => {
  it('accepts the exact mobile save payload shape (PR mobile #310)', () => {
    const mobile = {
      ...COMPLETE,
      G2: ['energy', 'other'],
      G2_other: 'Keep up with my kids',
      T3: 'yes',
      T3_areas: ['knee', 'lower_back'],
      T3_note: 'Old ski injury',
      S3: 'home_some',
      S3b: ['dumbbells', 'resistance_bands'],
      N4: 'never',
      N5: ['time'],
      P2: 'yes',
      P2_note: 'Only on stairs',
      L2: '7_8',
      T2: ['weights'],
      T4: '30_45',
    };
    expect(validateAnswerPatch(mobile, NOW)).toEqual([]);
  });

  it('accepts a complete valid answer set', () => {
    expect(validateAnswerPatch(COMPLETE, NOW)).toEqual([]);
  });

  it('rejects unknown keys and bad values with per-key errors', () => {
    const errs = validateAnswerPatch(
      {
        Z9: 'x',
        G1: 'get_huge',
        B2: '2015-01-01',
        B3: { height_cm: 50, weight_lbs: 10 },
        S1: '7',
        N2: ['nothing', 'nuts'],
        P3: 'maybe',
      },
      NOW,
    );
    expect(errs.map((e) => e.key).sort()).toEqual(['B2', 'B3', 'G1', 'N2', 'P3', 'S1', 'Z9']);
  });

  it('requires exactly one weight unit and accepts kg', () => {
    expect(
      validateAnswerPatch({ B3: { height_cm: 170, weight_kg: 78, unit: 'metric' } }, NOW),
    ).toEqual([]);
    expect(
      validateAnswerPatch({ B3: { height_cm: 170, weight_lbs: 172, unit: 'stone' } }, NOW),
    ).toHaveLength(1);
    expect(validateAnswerPatch({ B4: 150 }, NOW)).toEqual([]);
    expect(validateAnswerPatch({ B4: { weight_lbs: 150 } }, NOW)).toHaveLength(1);
    expect(
      validateAnswerPatch({ B3: { height_cm: 170, weight_kg: 78, weight_lbs: 172 } }, NOW),
    ).toHaveLength(1);
  });

  it('P0 must be an explicit agreement with a version', () => {
    expect(validateAnswerPatch({ P0: { agreed: false, copy_version: 'v1' } }, NOW)).toHaveLength(1);
    expect(validateAnswerPatch({ P0: { agreed: true } }, NOW)).toHaveLength(1);
    expect(validateAnswerPatch({ P0: { agreed: true, version: 'v1' } }, NOW)).toEqual([]);
    expect(
      validateAnswerPatch({ P0: { agreed: true, copy_version: 'v1', agreed_at: 'nope' } }, NOW),
    ).toHaveLength(1);
  });

  it('first session date must be within the next 14 days', () => {
    expect(validateAnswerPatch({ C1: '2026-12-01' }, NOW)).toHaveLength(1);
    expect(validateAnswerPatch({ C1: '2026-10-01' }, NOW)).toEqual([]);
  });

  it('null clears an answer and is always valid', () => {
    expect(validateAnswerPatch({ G1: null }, NOW)).toEqual([]);
    expect(mergeAnswers(COMPLETE, { G1: null }).G1).toBeUndefined();
  });
});

describe('mergeAnswers', () => {
  it('drops dependent answers that no longer apply', () => {
    const a = mergeAnswers(
      {
        T3: 'yes',
        T3_areas: ['knee'],
        T3_note: 'old',
        S3: 'home_some',
        S3b: ['dumbbells'],
        P2: 'yes',
        P2_note: 'x',
      },
      {
        T3: 'no',
        S3: 'gym',
        P2: 'no',
      },
    );
    expect(a).toEqual({ T3: 'no', S3: 'gym', P2: 'no' });
  });
});

describe('completeness', () => {
  it('a complete answer set has every chapter and nothing missing', () => {
    expect(missingRequired(COMPLETE)).toEqual([]);
    expect(completedChapters(COMPLETE)).toEqual([
      'goals',
      'body',
      'lifestyle',
      'training',
      'schedule',
      'nutrition',
      'safety',
      'commitment',
    ]);
  });

  it('injury yes requires areas; home equipment requires a list', () => {
    expect(missingRequired({ ...COMPLETE, T3: 'yes' })).toEqual(['T3_areas']);
    expect(missingRequired({ ...COMPLETE, S3: 'home_some' })).toEqual(['S3b']);
  });

  it('P0 is not reported as missing (it has its own consent_missing code)', () => {
    const { P0: _p0, ...rest } = COMPLETE;
    expect(missingRequired(rest)).toEqual([]);
    expect(completedChapters(rest)).not.toContain('safety');
  });
});

describe('screening and mapping', () => {
  it('flags any yes on P1-P7 and injuries', () => {
    expect(screeningAnyYes(COMPLETE)).toBe(false);
    expect(screeningAnyYes({ ...COMPLETE, P6: 'yes' })).toBe(true);
    expect(injuryFlag({ ...COMPLETE, T3: 'yes', T3_areas: ['knee'] })).toBe(true);
  });

  it('maps onto profile columns and never onto screening', () => {
    const p = profileFieldsFromAnswers({
      ...COMPLETE,
      P1: 'yes',
      N2: ['nuts', 'dairy'],
      S3: 'home_some',
      S3b: ['dumbbells'],
    });
    expect(p).toMatchObject({
      sex: 'female',
      height_cm: 167.64,
      current_weight_lbs: 172,
      target_weight_lbs: 150,
      activity_level: 'moderate',
      goal_type: 'fat_loss',
      workout_experience: 'beginner',
      workout_days_per_week: 3,
      dietary_restrictions: ['nuts', 'dairy'],
      has_gym_membership: false,
      equipment_access: ['home_gym', 'dumbbells'],
      injuries: [],
    });
    expect(JSON.stringify(p)).not.toMatch(/P1|screen/);
  });

  it('feeds the single calculator and reproduces the approved example', () => {
    const r = resolveMacroInputs(macroRawFromAnswers(COMPLETE), NOW);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(computeMacros(r.inputs)).toMatchObject({
        calories: 1789,
        protein_g: 150,
        fat_g: 50,
        carbs_g: 185,
      });
  });
});

describe('prototype keys', () => {
  it('rejects and never writes __proto__ / constructor keys', () => {
    const patch = JSON.parse(
      '{"__proto__": {"polluted": true}, "constructor": "x", "G1": "fat_loss"}',
    );
    expect(
      validateAnswerPatch(patch, new Date('2026-10-01T12:00:00Z'))
        .map((e) => e.key)
        .sort(),
    ).toEqual(['__proto__', 'constructor']);
    const merged = mergeAnswers({}, patch);
    expect(Object.keys(merged)).toEqual(['G1']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
  });
});
