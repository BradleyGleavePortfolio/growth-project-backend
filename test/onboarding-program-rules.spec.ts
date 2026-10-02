// C07 — pure program rule table. Exhaustive matrix checked against an
// independent oracle: the draft's reference selector (validate-programs.mjs),
// re-implemented here to evaluate the FIXTURE's own rules, so the code table
// and the content file must agree for every input combination.
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  PROGRAM_RULES,
  selectProgram,
  whyReasons,
  type SelectionAnswers,
} from '../src/onboarding/program-rules';
import {
  assertFixtureRulesMatch,
  FixtureError,
  parseFixture,
} from '../src/onboarding/clinic-programs';

const RAW = readFileSync(join(__dirname, '..', 'seed', 'clinic-programs.v1.json'), 'utf8');
type FixtureRule = {
  priority: number;
  when: Record<string, unknown>;
  program_key: string;
  days: { constant?: number; capped_at?: number; use_requested?: boolean };
  equipment_variant: string;
  review: boolean;
  overlay: string | null;
};
const FIXTURE = JSON.parse(RAW) as {
  selection: { rules: FixtureRule[]; input_mapping: { home_equipment: { allowed: string[] } } };
};

// ── Oracle: reference selector from the program draft, verbatim logic ─────
const yes = (v: unknown) => v === 'yes' || v === true;
const no = (v: unknown) => v === 'no' || v === false;
const experiences = ['beginner', 'intermediate', 'advanced'];
const locations = ['gym', 'home', 'home_some', 'none', 'both', 'mix'];
const allEquipment = FIXTURE.selection.input_mapping.home_equipment.allowed;
function oracleDomain(a: SelectionAnswers) {
  if (a.S3 === 'gym') return 'gym';
  if (a.S3 === 'both' || a.S3 === 'mix') return 'mixed-unconfirmed';
  if (
    (a.S3 === 'home' || a.S3 === 'home_some') &&
    Array.isArray(a.S3b) &&
    a.S3b.includes('dumbbells')
  ) {
    return 'home-dumbbells';
  }
  return 'limited';
}
function oracle(a: SelectionAnswers) {
  const needsEquipment = a.S3 === 'home' || a.S3 === 'home_some';
  const injury = yes(a.T3) || (Array.isArray(a.T3a) && a.T3a.length > 0);
  const readiness = [a.P1, a.P2, a.P3, a.P4, a.P5, a.P6, a.P7];
  const unknown =
    !experiences.includes(String(a.T1)) ||
    ![2, 3, 4, 5].includes(Number(a.S1)) ||
    !locations.includes(String(a.S3)) ||
    !(yes(a.T3) || no(a.T3)) ||
    readiness.some((v) => !(yes(v) || no(v))) ||
    (needsEquipment &&
      (!Array.isArray(a.S3b) ||
        a.S3b.some((v: unknown) => !allEquipment.includes(String(v))) ||
        (a.S3 === 'home_some' && a.S3b.length === 0))) ||
    (a.T3a !== undefined && !Array.isArray(a.T3a));
  const inputs: Record<string, unknown> = {
    any_injury_or_readiness_yes: injury || readiness.some(yes),
    any_required_selection_input_unknown_or_invalid: unknown,
    days_per_week: Number(a.S1),
    experience: a.T1,
    equipment_domain: oracleDomain(a),
  };
  const rule = FIXTURE.selection.rules.find((r) =>
    Object.entries(r.when).every(([k, v]) => {
      if (k === 'default') return Boolean(v);
      return Array.isArray(v) ? v.includes(inputs[k]) : inputs[k] === v;
    }),
  );
  if (!rule) throw new Error('oracle found no rule');
  const days =
    rule.days.constant ??
    (rule.days.capped_at
      ? Math.min(Number(inputs.days_per_week), rule.days.capped_at)
      : Number(inputs.days_per_week));
  return {
    key: rule.program_key,
    days,
    overlay: rule.overlay,
    review: rule.review,
    equipment_variant:
      rule.equipment_variant === 'from_domain' ? inputs.equipment_domain : rule.equipment_variant,
    rule_priority: rule.priority,
  };
}

const ALL_NO = { P1: 'no', P2: 'no', P3: 'no', P4: 'no', P5: 'no', P6: 'no', P7: 'no' };
const base = (o: Partial<SelectionAnswers>): SelectionAnswers => ({
  T1: 'intermediate',
  S1: '4',
  S3: 'gym',
  T3: 'no',
  ...ALL_NO,
  ...o,
});

describe('program rule table — exhaustive matrix vs reference oracle', () => {
  const T1s = ['beginner', 'intermediate', 'advanced', undefined, 'expert'];
  const S1s: unknown[] = ['2', '3', '4', '5', 2, 3, 4, 5, '1', '6', undefined, 'x'];
  const S3s = ['gym', 'home', 'home_some', 'none', 'both', 'mix', undefined, 'park'];
  const S3bs: unknown[] = [
    undefined,
    [],
    ['dumbbells'],
    ['resistance_bands'],
    ['dumbbells', 'kettlebells'],
    ['laser'],
  ];
  const T3s: Array<[unknown, unknown]> = [
    ['no', undefined],
    ['yes', ['knee']],
    ['yes', []],
    ['no', ['knee']],
    [undefined, undefined],
    ['no', 'knee'],
  ];
  const Ps: Array<Record<string, unknown>> = [
    ALL_NO,
    { ...ALL_NO, P1: 'yes' },
    { ...ALL_NO, P7: 'yes' },
    { ...ALL_NO, P4: undefined },
    { ...ALL_NO, P3: 'maybe' },
  ];

  it('agrees with the oracle on every combination', () => {
    let cases = 0;
    for (const T1 of T1s)
      for (const S1 of S1s)
        for (const S3 of S3s)
          for (const S3b of S3bs)
            for (const [T3, T3a] of T3s)
              for (const P of Ps) {
                const a: SelectionAnswers = { T1, S1, S3, S3b, T3, T3a, ...P };
                const got = selectProgram(a);
                const want = oracle(a);
                expect({
                  key: got.program_key,
                  days: got.selected_days,
                  overlay: got.overlay,
                  review: got.coach_review_required,
                  equipment_variant: got.equipment_variant,
                  rule_priority: got.rule_priority,
                }).toEqual(want);
                cases++;
              }
    expect(cases).toBe(5 * 12 * 8 * 6 * 6 * 5);
  });

  it('every rule priority is reachable except the defensive default', () => {
    const seen = new Set<number>();
    for (const T1 of ['beginner', 'advanced', 'x'])
      for (const S1 of ['2', '3', '4', '5'])
        for (const S3 of ['gym', 'home_some', 'none', 'mix'])
          for (const T3 of ['no', 'yes'])
            seen.add(
              selectProgram(
                base({
                  T1,
                  S1,
                  S3,
                  S3b: ['dumbbells'],
                  T3,
                  T3a: T3 === 'yes' ? ['knee'] : undefined,
                }),
              ).rule_priority,
            );
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('program rule table — named cases', () => {
  it('any readiness yes selects Steady Foundations at 2 days with extra care and review', () => {
    for (const p of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7']) {
      const s = selectProgram(base({ T1: 'advanced', S1: '5', [p]: 'yes' }));
      expect(s).toMatchObject({
        program_key: 'steady-foundations',
        selected_days: 2,
        overlay: 'extra-care',
        coach_review_required: true,
        rule_priority: 1,
      });
    }
  });

  it('injury flag selects Steady Foundations at 2 days', () => {
    expect(selectProgram(base({ T3: 'yes', T3a: ['shoulder'] })).program_key).toBe(
      'steady-foundations',
    );
    expect(selectProgram(base({ T3: 'no', T3a: ['shoulder'] })).rule_priority).toBe(1);
  });

  it('two requested days selects Steady Foundations without review', () => {
    expect(selectProgram(base({ S1: '2' }))).toMatchObject({
      program_key: 'steady-foundations',
      selected_days: 2,
      coach_review_required: false,
      overlay: null,
    });
  });

  it('limited or mixed setting caps Steady Foundations at 3 days', () => {
    expect(selectProgram(base({ S3: 'none', S1: '5' }))).toMatchObject({
      program_key: 'steady-foundations',
      selected_days: 3,
    });
    expect(selectProgram(base({ S3: 'mix', S1: '4' }))).toMatchObject({
      program_key: 'steady-foundations',
      selected_days: 3,
    });
    expect(
      selectProgram(base({ S3: 'home_some', S3b: ['resistance_bands'], S1: '3' })).selected_days,
    ).toBe(3);
  });

  it('experienced gym client training 4-5 days gets Strength & Balance at the requested days', () => {
    expect(selectProgram(base({ T1: 'advanced', S1: '5' }))).toMatchObject({
      program_key: 'strength-and-balance',
      selected_days: 5,
      equipment_variant: 'gym',
    });
    expect(selectProgram(base({ S1: 4 })).selected_days).toBe(4);
  });

  it('beginner gym or home-dumbbell client gets Considered Strength capped at 4 days', () => {
    expect(selectProgram(base({ T1: 'beginner', S1: '5' }))).toMatchObject({
      program_key: 'considered-strength',
      selected_days: 4,
      equipment_variant: 'gym',
    });
    expect(
      selectProgram(base({ T1: 'advanced', S1: '5', S3: 'home_some', S3b: ['dumbbells'] })),
    ).toMatchObject({
      program_key: 'considered-strength',
      selected_days: 4,
      equipment_variant: 'home-dumbbells',
    });
    expect(selectProgram(base({ T1: 'intermediate', S1: '3' })).selected_days).toBe(3);
  });

  it('unknown or missing selection input falls back to the supported plan', () => {
    expect(selectProgram(base({ T1: undefined })).rule_priority).toBe(2);
    expect(selectProgram(base({ S3: 'home_some', S3b: [] })).rule_priority).toBe(2);
    expect(selectProgram(base({ P5: undefined })).program_key).toBe('steady-foundations');
  });

  it('goal and other non-selection answers never change the result', () => {
    const a = base({ T1: 'advanced', S1: '5' });
    const withExtras = {
      ...a,
      G1: 'fat_loss',
      B1: 'female',
      L2: 'lt_6',
      T4: '20_30',
    } as SelectionAnswers;
    expect(selectProgram(withExtras)).toEqual(selectProgram(a));
  });
});

describe('why reasons', () => {
  const fx = parseFixture(RAW);
  it('substitutes actual normalised inputs and returns three lines for every rule', () => {
    const s = selectProgram(base({ T1: 'beginner', S1: '5' }));
    const why = whyReasons(s, fx.materialisation.why_templates);
    expect(why).toHaveLength(3);
    expect(why.join(' ')).toContain('5 training days');
    expect(why.join(' ')).toContain('4 sessions');
    expect(why.join(' ')).not.toMatch(/\{[a-z_]+\}/);
    for (const a of [
      base({ P1: 'yes' }),
      base({ T1: undefined }),
      base({ S1: '2' }),
      base({ S3: 'none' }),
      base({ T1: 'advanced' }),
    ]) {
      const lines = whyReasons(selectProgram(a), fx.materialisation.why_templates);
      expect(lines).toHaveLength(3);
      lines.forEach((l) => expect(l).not.toMatch(/\{[a-z_]+\}/));
    }
  });
});

describe('fixture/code drift guard', () => {
  it('accepts the checked-in fixture rules', () => {
    expect(() => assertFixtureRulesMatch(FIXTURE.selection.rules)).not.toThrow();
    expect(PROGRAM_RULES).toHaveLength(FIXTURE.selection.rules.length);
  });
  it('rejects a fixture whose rules differ from the code table', () => {
    const mutated = JSON.parse(JSON.stringify(FIXTURE.selection.rules)) as FixtureRule[];
    mutated[4].days = { capped_at: 4 };
    expect(() => assertFixtureRulesMatch(mutated)).toThrow(FixtureError);
  });
});
