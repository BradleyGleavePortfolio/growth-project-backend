import {
  buildPlaybookRoster,
  scrubPlaybookText,
} from '../../src/roman/playbook/playbook-scrub';
import {
  PlaybookSchemaCheck,
  validatePlaybookDraft,
} from '../../src/roman/playbook/playbook-validate';

// The same injected shape-validator seam used by the PR's own regression suite.
type Item = { text: string; basis: 'observed'; evidence_count: number };
type Draft = {
  exercises: { go_to: Item[]; avoid: Item[]; substitutions: unknown[] };
  diet: { protein: Item[] };
  red_lines: unknown[];
};
const schema: PlaybookSchemaCheck<Draft> = (raw) => {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'exercises' in raw &&
    'diet' in raw &&
    'red_lines' in raw
  ) {
    return { ok: true, value: raw as Draft };
  }
  return { ok: false, errors: ['shape'] };
};
const roster = buildPlaybookRoster([
  { name: 'Max Delgado' },
  { name: 'Sarah Okafor' },
]);
const source = 'max reports knee pain after squats';
const item = (text: string): Item => ({
  text,
  basis: 'observed',
  evidence_count: 3,
});
const draft = (text: string): Draft => ({
  exercises: { go_to: [item(text)], avoid: [], substitutions: [] },
  diet: { protein: [] },
  red_lines: [],
});

describe('Sol W3: ordinary first-name privacy boundaries', () => {
  it('removes the client first name from an ordinary lowercase note before send', () => {
    expect(scrubPlaybookText(source, roster)).toBe(
      '[NAME] reports knee pain after squats',
    );
  });

  it('drops a model paraphrase that names the client at the beginning of the item', () => {
    const result = validatePlaybookDraft(
      draft('Max needs knee-friendly exercise options'),
      { roster, privateTexts: [source], schema },
    );
    if (!result.ok) throw new Error('expected a valid filtered draft');
    expect(result.value.exercises.go_to).toEqual([]);
    expect(result.dropped).toEqual([
      { path: 'exercises.go_to[0]', reason: 'roster_name' },
    ]);
  });

  it('positive control: removes another roster name through both real functions', () => {
    expect(scrubPlaybookText('sarah reports knee pain after squats', roster)).toBe(
      '[NAME] reports knee pain after squats',
    );
    const result = validatePlaybookDraft(
      draft('Sarah needs knee-friendly exercise options'),
      { roster, privateTexts: [source], schema },
    );
    if (!result.ok) throw new Error('expected a valid filtered draft');
    expect(result.value.exercises.go_to).toEqual([]);
    expect(result.dropped).toEqual([
      { path: 'exercises.go_to[0]', reason: 'roster_name' },
    ]);
  });
});
