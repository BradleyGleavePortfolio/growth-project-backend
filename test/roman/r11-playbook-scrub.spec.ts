/**
 * Roman v1.1 slice R11-P3a: playbook scrub (before send) and validate (after
 * the model). Pure functions; no database, no provider.
 */
import {
  PLAYBOOK_SCRUB_TOKENS,
  buildPlaybookRoster,
  containsRosterName,
  scrubPlaybookText,
} from '../../src/roman/playbook/playbook-scrub';
import {
  PLAYBOOK_RED_LINE_KINDS,
  PlaybookRedLineKind,
  PlaybookSchemaCheck,
  buildVerbatimIndex,
  hasPersonTiedNumber,
  parseRedLine,
  sharesVerbatimRun,
  validatePlaybookDraft,
} from '../../src/roman/playbook/playbook-validate';

const roster = buildPlaybookRoster([
  {
    name: 'Sarah Okafor',
    display_name: 'Sarah O.',
    email: 'sarah.okafor@example.com',
    phone: '+1 (415) 555-0134',
  },
  { name: 'Max Delgado' },
  { name: 'Priya Raman-Iyer', display_name: 'PriyaLifts' },
  { name: 'Coach Daniel Brooks' },
  { name: 'Minh Do' },
]);

describe('R11-P3a scrub before send', () => {
  it.each<[string, string, string]>([
    ['first name', 'Sarah hates lunges', '[NAME] hates lunges'],
    ['full name', 'Told Sarah Okafor to deload', 'Told [NAME] to deload'],
    ['last name in lower case', 'okafor missed two sessions', '[NAME] missed two sessions'],
    ['sub-coach possessive', "Daniel's group trains Monday", "[NAME]'s group trains Monday"],
    ['hyphenated surname part', 'Iyer asked about creatine', '[NAME] asked about creatine'],
    ['display name', 'PriyaLifts posted a PR', '[NAME] posted a PR'],
    ['common-word name when capitalised', 'Max skipped legs', '[NAME] skipped legs'],
    ['common-word name used as a word', 'Work up to a max effort single', 'Work up to a max effort single'],
    ['title word is not a name', 'coach review after the block', 'coach review after the block'],
    ['email', 'Write to sarah.okafor@example.com today', 'Write to [EMAIL] today'],
    ['link with scheme', 'Plan at https://example.com/plan?id=3 now', 'Plan at [LINK] now'],
    ['bare domain', 'Forms live on coachsite.io/forms', 'Forms live on [LINK]'],
    ['handle', 'DM @priya_lifts for form checks', 'DM [HANDLE] for form checks'],
    ['formatted phone', 'Call +1 (415) 555-0134 after work', 'Call [PHONE] after work'],
    ['plain phone', 'Text 4155550199 anytime', 'Text [PHONE] anytime'],
    ['calorie range is not a phone', 'Keep intake at 2000-2200 kcal', 'Keep intake at 2000-2200 kcal'],
    ['ISO date', 'Started on 2026-09-14 with a cut', 'Started on [DATE] with a cut'],
    ['numeric date', 'Weigh-in 14/09/2026 went fine', 'Weigh-in [DATE] went fine'],
    ['month and day', 'Back from holiday Oct 6th, 2026', 'Back from holiday [DATE]'],
    ['day and month', 'Comp prep ends 3 March', 'Comp prep ends [DATE]'],
    ['month and year', 'Injured in September 2025', 'Injured in [DATE]'],
    ['weekdays kept', 'Trains Monday, Wednesday and Friday', 'Trains Monday, Wednesday and Friday'],
    ['sets and reps kept', '3x8-10 at RPE 8, rest 90 s', '3x8-10 at RPE 8, rest 90 s'],
    ['fraction kept', 'Fill 1/2 the plate with vegetables', 'Fill 1/2 the plate with vegetables'],
  ])('%s', (_label, input, expected) => {
    expect(scrubPlaybookText(input, roster)).toBe(expected);
  });

  it('removes every roster identity from a realistic session note', () => {
    const note =
      'Sarah Okafor (sarah.okafor@example.com, +1 415 555 0134) said on 2026-09-14 that Max Delgado ' +
      'and @priya_lifts train with her. Daniel Brooks covers Oct 12.';
    const out = scrubPlaybookText(note, roster);
    for (const leaked of ['Sarah', 'Okafor', 'Max', 'Delgado', 'priya', 'Daniel', 'Brooks', '415', '2026', 'Oct 12']) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain(PLAYBOOK_SCRUB_TOKENS.name);
    expect(containsRosterName(out, roster)).toBe(false);
  });

  it('treats names that are ordinary words by case before send and by position after the model', () => {
    expect(scrubPlaybookText('Ask Do about knees. Do 3 sets.', roster)).toBe('Ask [NAME] about knees. [NAME] 3 sets.');
    expect(scrubPlaybookText('do the warm-up first', roster)).toBe('do the warm-up first');
    expect(containsRosterName('Do not train to failure', roster)).toBe(false);
    expect(containsRosterName('Max effort singles once a week', roster)).toBe(false);
    expect(containsRosterName('Check with Do before adding volume', roster)).toBe(true);
    expect(containsRosterName('Swap lunges when knees bother Max', roster)).toBe(true);
    expect(containsRosterName('minh prefers mornings', roster)).toBe(true);
  });

  it('returns an empty string for non-text input', () => {
    expect(scrubPlaybookText(undefined, roster)).toBe('');
    expect(scrubPlaybookText(42, roster)).toBe('');
  });
});

describe('R11-P3a red lines map to the closed kinds', () => {
  it.each<[string, PlaybookRedLineKind, string | undefined]>([
    ['never push through joint pain', 'no_train_through_pain', undefined],
    ['Stop the set if it hurts', 'no_train_through_pain', undefined],
    ['Pain means stop', 'no_train_through_pain', undefined],
    ['Never below 1,200 kcal', 'min_kcal', '1200'],
    ['Minimum of 1400 calories for anyone cutting', 'min_kcal', '1400'],
    ['Never recommend fat burners', 'no_supplement', 'fat burners'],
    ['No upright rows', 'no_exercise', 'upright rows'],
    ['Never program behind the neck press for anyone', 'no_exercise', 'behind the neck press'],
    ['No squats deeper than parallel', 'custom', undefined],
    ['Never train to failure', 'no_failure_training', undefined],
    ['No fasted training', 'no_fasted_training', undefined],
    ['Always warm up for ten minutes', 'custom', undefined],
  ])('%s -> %s', (text, kind, value) => {
    const parsed = parseRedLine(text, 'custom');
    expect(parsed.kind).toBe(kind);
    expect(parsed.value).toBe(value);
    expect(PLAYBOOK_RED_LINE_KINDS).toContain(parsed.kind);
  });

  it('uses the model label only when the text supports it', () => {
    expect(
      parseRedLine('Keep Bulgarian split squats out of every plan', 'no_exercise', 'Bulgarian split squats'),
    ).toEqual({ kind: 'no_exercise', value: 'bulgarian split squats' });
    expect(parseRedLine('Prefer whole foods', 'no_supplement', 'creatine')).toEqual({ kind: 'custom' });
    expect(parseRedLine('Something new', 'not_a_kind')).toEqual({ kind: 'custom' });
  });
});

describe('R11-P3a person-tied numbers and verbatim runs', () => {
  it.each<[string, boolean]>([
    ['She benches 60 kg', true],
    ['A 45-year-old client needs more recovery', true],
    ['Lost 9 kg in 12 weeks', true],
    ['Client is 5\'4" and active', true],
    ['Raise volume by 2 sets when he stalls', true],
    ['Protein at 1 g per lb of goal body weight', false],
    ['Deload every 5th week', false],
    ['Their sessions run 60 minutes', false],
  ])('%s -> %s', (text, expected) => {
    expect(hasPersonTiedNumber(text)).toBe(expected);
  });

  it('flags 6 consecutive source words regardless of case and punctuation', () => {
    const index = buildVerbatimIndex(['Remember: log EVERY meal before you go to bed, tonight.']);
    expect(sharesVerbatimRun('remember log every meal before you', index)).toBe(true);
    expect(sharesVerbatimRun('Log meals through the day', index)).toBe(false);
    expect(sharesVerbatimRun('log every meal before you', index)).toBe(false);
  });
});

type Item = { text: string; basis: 'stated' | 'observed'; evidence_count: number };
type Draft = {
  exercises: { go_to: Item[]; avoid: Item[]; substitutions: Array<Record<string, unknown>> };
  diet: { protein: Item[] };
  red_lines: Array<{ kind: string; value?: string; text: string }>;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isDraft = (d: unknown): d is Draft =>
  isRecord(d) && isRecord(d.exercises) && isRecord(d.diet) && Array.isArray(d.red_lines);

// Stand-in for the R11-P1 validator: shape only.
const schema: PlaybookSchemaCheck<Draft> = (d) =>
  isDraft(d) ? { ok: true, value: d } : { ok: false, errors: ['shape'] };

const item = (text: string): Item => ({ text, basis: 'observed', evidence_count: 3 });

const privateTexts = [
  'Sarah said the incline walk at 12 percent for 20 minutes after lifting keeps her hunger down.',
  'Remember to log every meal before you go to bed tonight.',
  'Never let anyone train through pain in the lower back, ever.',
];

const draft: Draft = {
  exercises: {
    go_to: [
      item('Incline walk at 12 percent for 20 minutes after lifting'),
      item('Low-intensity incline walking after strength sessions to manage appetite'),
      item('Sarah responds well to front squats'),
      item('Use [NAME] style tempo squats'),
    ],
    avoid: [
      item('Avoid lunges for clients with knee pain'),
      item('She lost 12 lb on 1,600 kcal'),
      item('Started heavy pulls on 2026-09-14'),
      item('Send form videos to coachsite.io'),
    ],
    substitutions: [
      { for: 'barbell back squat', when: 'knee pain', use: 'box squat to parallel', basis: 'stated', evidence_count: 2 },
      { for: 'lunges', when: 'knees bother Max', use: 'step-ups', basis: 'observed', evidence_count: 1 },
    ],
  },
  diet: {
    protein: [
      item('Protein at 1 g per lb of goal body weight'),
      item('Remember to log every meal before you go to bed'),
      item('A 45-year-old client needs more protein'),
    ],
  },
  red_lines: [
    { kind: 'custom', text: 'Never push through joint pain' },
    { kind: 'custom', text: 'Never go below 1,200 kcal' },
    { kind: 'no_supplement', text: 'Never recommend fat burners or detox teas' },
    { kind: 'custom', text: 'No upright rows.' },
    { kind: 'custom', text: 'No squats deeper than parallel' },
    { kind: 'custom', text: 'Do not train to failure on compound lifts' },
    { kind: 'custom', text: 'No fasted training sessions' },
    { kind: 'custom', text: 'Never let anyone train through pain in the lower back' },
    { kind: 'min_kcal', text: 'Keep her above 1,400 kcal' },
  ],
};

describe('R11-P3a validate after the model', () => {
  const result = validatePlaybookDraft(draft, { roster, privateTexts, schema });

  it('keeps paraphrased methods and drops identifying or quoted items', () => {
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.exercises.go_to.map((i) => i.text)).toEqual([
      'Low-intensity incline walking after strength sessions to manage appetite',
    ]);
    expect(result.value.exercises.avoid.map((i) => i.text)).toEqual([
      'Avoid lunges for clients with knee pain',
    ]);
    expect(result.value.exercises.substitutions).toHaveLength(1);
    expect(result.value.exercises.substitutions[0].use).toBe('box squat to parallel');
    expect(result.value.diet.protein.map((i) => i.text)).toEqual([
      'Protein at 1 g per lb of goal body weight',
    ]);
  });

  it('records a reason code for every drop', () => {
    if (!result.ok) throw new Error('expected ok');
    expect(result.dropped).toEqual([
      { path: 'exercises.go_to[0]', reason: 'verbatim_source' },
      { path: 'exercises.go_to[2]', reason: 'roster_name' },
      { path: 'exercises.go_to[3]', reason: 'placeholder' },
      { path: 'exercises.avoid[1]', reason: 'person_number' },
      { path: 'exercises.avoid[2]', reason: 'date' },
      { path: 'exercises.avoid[3]', reason: 'contact' },
      { path: 'exercises.substitutions[1]', reason: 'roster_name' },
      { path: 'diet.protein[1]', reason: 'verbatim_source' },
      { path: 'diet.protein[2]', reason: 'person_number' },
      { path: 'red_lines[8]', reason: 'person_number' },
    ]);
    const report = JSON.stringify({ dropped: result.dropped, rewritten: result.rewritten });
    for (const content of ['Sarah', 'Max', '12 lb', 'coachsite', 'log every meal']) {
      expect(report).not.toContain(content);
    }
  });

  it('parses red lines and rewrites a quoted closed-kind red line in code words', () => {
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.red_lines.map((r) => [r.kind, r.value ?? null, r.text])).toEqual([
      ['no_train_through_pain', null, 'Never push through joint pain'],
      ['min_kcal', '1200', 'Never go below 1,200 kcal'],
      ['no_supplement', 'fat burners', 'Never recommend fat burners or detox teas'],
      ['no_exercise', 'upright rows', 'No upright rows.'],
      ['custom', null, 'No squats deeper than parallel'],
      ['no_failure_training', null, 'Do not train to failure on compound lifts'],
      ['no_fasted_training', null, 'No fasted training sessions'],
      ['no_train_through_pain', null, 'Do not train through pain.'],
    ]);
    expect(result.rewritten).toEqual([{ path: 'red_lines[7]', reason: 'verbatim_source' }]);
    expect(result.kept_items).toBe(4 + 8);
  });

  it('rejects a draft the schema refuses, before any filtering', () => {
    const bad = validatePlaybookDraft({ exercises: [] }, { roster, privateTexts, schema });
    expect(bad).toEqual({ ok: false, reason: 'schema_invalid', errors: ['shape'] });
  });

  it('re-runs the schema on the filtered draft', () => {
    const strict: PlaybookSchemaCheck<Draft> = (d) => {
      const first = schema(d);
      if (!first.ok) return first;
      return first.value.exercises.go_to.length > 0 ? first : { ok: false, errors: ['go_to empty'] };
    };
    const onlyNames: Draft = {
      ...draft,
      exercises: { ...draft.exercises, go_to: [item('Sarah responds well to front squats')] },
    };
    const out = validatePlaybookDraft(onlyNames, { roster, privateTexts, schema: strict });
    expect(out).toEqual({ ok: false, reason: 'schema_invalid_after_filter', errors: ['go_to empty'] });
  });

  it('never mutates the model draft', () => {
    expect(draft.exercises.go_to).toHaveLength(4);
    expect(draft.red_lines[0].kind).toBe('custom');
  });
});
