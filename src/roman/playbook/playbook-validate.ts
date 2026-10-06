/**
 * Roman v1.1 slice R11-P3a: validate after the model (privacy core of the
 * coach twin).
 *
 * The playbook builder (R11-P3b) calls validatePlaybookDraft on the model's
 * parsed JSON before anything is stored:
 *   1. the CoachPlaybook schema validator (R11-P1, injected as ctx.schema so
 *      this slice lands independently of P1's merge order);
 *   2. every item (a string, or a record whose values are all primitives) is
 *      dropped when any of its strings holds a scrub placeholder, contact
 *      details, a roster name, a calendar date, a number tied to one person,
 *      or 6+ consecutive words found in any private session note or coach
 *      message (no private note is ever quotable);
 *   3. red lines are parsed into the closed kinds; a closed-kind red line that
 *      only failed the verbatim rule is kept with code-written text;
 *   4. the schema validator runs again on the filtered result.
 *
 * The result lists dropped paths and reason codes only, never content, so the
 * caller can log it. Pure functions, no I/O, no logging.
 */
import {
  PlaybookRoster,
  containsContact,
  containsDate,
  containsPlaceholder,
  containsRosterName,
} from './playbook-scrub';

/** Closed red-line kinds (same list as the R11-P1 schema). */
export const PLAYBOOK_RED_LINE_KINDS = [
  'no_exercise',
  'no_supplement',
  'no_train_through_pain',
  'no_failure_training',
  'min_kcal',
  'no_fasted_training',
  'custom',
] as const;
export type PlaybookRedLineKind = (typeof PLAYBOOK_RED_LINE_KINDS)[number];

/** A run of this many consecutive words shared with a private source is a quote. */
export const PLAYBOOK_VERBATIM_WORDS = 6;

export type PlaybookDropReason =
  | 'placeholder'
  | 'contact'
  | 'roster_name'
  | 'date'
  | 'person_number'
  | 'verbatim_source';

export interface PlaybookDrop {
  path: string;
  reason: PlaybookDropReason;
}

export type PlaybookSchemaResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: readonly string[] };

export type PlaybookSchemaCheck<T> = (draft: unknown) => PlaybookSchemaResult<T>;

export interface PlaybookValidateContext<T> {
  roster: PlaybookRoster;
  /** Raw (pre-scrub) private session notes and coach messages used as sources. */
  privateTexts: readonly string[];
  /** The R11-P1 CoachPlaybook validator. */
  schema: PlaybookSchemaCheck<T>;
}

export type PlaybookValidateResult<T> =
  | {
      ok: true;
      value: T;
      dropped: PlaybookDrop[];
      /** Red lines kept with code-written text instead of the model's words. */
      rewritten: PlaybookDrop[];
      kept_items: number;
    }
  | { ok: false; reason: 'schema_invalid' | 'schema_invalid_after_filter'; errors: readonly string[] };

// ---------------------------------------------------------------------------
// Verbatim runs
// ---------------------------------------------------------------------------

function words(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0);
}

function shingles(text: string, size: number): string[] {
  const w = words(text);
  const out: string[] = [];
  for (let i = 0; i + size <= w.length; i += 1) out.push(w.slice(i, i + size).join(' '));
  return out;
}

/** Every 6-word run of the private sources, normalised (case and punctuation ignored). */
export function buildVerbatimIndex(
  texts: readonly string[],
  size: number = PLAYBOOK_VERBATIM_WORDS,
): ReadonlySet<string> {
  const index = new Set<string>();
  for (const t of texts) {
    if (typeof t !== 'string') continue;
    for (const s of shingles(t, size)) index.add(s);
  }
  return index;
}

/** True when the text shares a 6-word run with any private source. */
export function sharesVerbatimRun(
  text: string,
  index: ReadonlySet<string>,
  size: number = PLAYBOOK_VERBATIM_WORDS,
): boolean {
  if (index.size === 0) return false;
  return shingles(text, size).some((s) => index.has(s));
}

// ---------------------------------------------------------------------------
// Numbers tied to one person
// ---------------------------------------------------------------------------

const PERSON_REF_RE =
  /\b(?:he|she|him|her|his|hers|himself|herself|this client|that client|one client|my client|a client of)\b/i;
const AGE_RE = /\b\d{1,3}\s*-?\s*(?:years?|yrs?)\s*-?\s*old\b|\b\d{1,3}\s*(?:y\/o|yo)\b/i;
const OUTCOME_RE =
  /\b(?:lost|gained|dropped|weighs|weighed|weighing|put on|is down|is up|went down|went up)\s+(?:about\s+|around\s+|nearly\s+|over\s+|almost\s+)?\d+(?:[.,]\d+)?\s*(?:(?:lb|lbs|pounds?|kg|kgs|kilos?|st|stone|percent|inches|cm)\b|%)/i;
const HEIGHT_RE = /\b[4-7]'\s?\d{1,2}\b|\b[4-7]\s?(?:ft|foot)\s?\d{1,2}\b/i;

/** True when a number in the text describes one person (age, body stats, results). */
export function hasPersonTiedNumber(text: string): boolean {
  if (!/\d/.test(text)) return false;
  if (AGE_RE.test(text) || OUTCOME_RE.test(text) || HEIGHT_RE.test(text)) return true;
  return text
    .split(/[.!?;]\s+/)
    .some((sentence) => /\d/.test(sentence) && PERSON_REF_RE.test(sentence));
}

// ---------------------------------------------------------------------------
// Red lines -> closed kinds
// ---------------------------------------------------------------------------

const NEGATION_RE =
  /\b(?:never|no|not|don'?t|do not|avoid|without|stop|skip|cannot|can'?t|must not|mustn'?t|under no)\b/i;
const PAIN_RE =
  /\bthrough\s+(?:[\p{L}-]+\s+){0,2}pain\b|\b(?:stop|end|skip)\b[^.]{0,30}\b(?:if|when)\b[^.]{0,20}\b(?:hurts?|pain|painful)\b|\bpain\b[^.]{0,15}\bmeans?\s+stop\b/iu;
const FASTED_RE = /\bfasted\b|\bempty stomach\b/i;
const FAILURE_RE = /\bfailure\b/i;
const KCAL_NUM = '(\\d{1,2},\\d{3}|\\d{3,4})';
const KCAL_UNIT = '(?:kcal|calories|cals?)\\b';
const KCAL_BELOW_RE = new RegExp(
  `\\b(?:below|under|less than|lower than|beneath)\\s+(?:about\\s+|around\\s+)?${KCAL_NUM}\\s*${KCAL_UNIT}`,
  'i',
);
const KCAL_FLOOR_RE = new RegExp(
  `\\b(?:minimum(?: of)?|min\\.?|at least|floor(?: of)?|no lower than|no less than|not less than)\\s+(?:about\\s+|around\\s+)?${KCAL_NUM}\\s*${KCAL_UNIT}`,
  'i',
);

const SUPPLEMENTS = [
  'fat burners', 'fat burner', 'diet pills', 'diet pill', 'detox teas', 'detox tea', 'sarms',
  'prohormones', 'anabolic steroids', 'steroids', 'testosterone boosters', 'pre-workout',
  'preworkout', 'creatine', 'bcaas', 'bcaa', 'ephedrine', 'clenbuterol', 'dnp', 'laxatives',
  'appetite suppressants', 'caffeine pills', 'melatonin', 'ashwagandha', 'collagen', 'fish oil',
  'multivitamins', 'keto pills', 'weight loss pills', 'weight-loss pills', 'meal replacement shakes',
  'juice cleanses', 'cleanses', 'energy drinks', 'kratom', 'peptides', 'hgh',
];
const EXERCISES = [
  'behind the neck press', 'behind-the-neck press', 'behind the neck pulldowns', 'upright rows',
  'upright row', 'good mornings', 'kipping pull-ups', 'kipping pullups', 'kipping', 'box jumps',
  'burpees', 'conventional deadlifts', 'sumo deadlifts', 'romanian deadlifts', 'rdls',
  'deadlifts', 'back squats', 'front squats', 'jump squats', 'squats', 'lunges', 'leg press',
  'leg extensions', 'bench press', 'overhead press', 'military press', 'barbell rows', 'pull-ups',
  'pullups', 'chin-ups', 'dips', 'crunches', 'sit-ups', 'situps', 'russian twists',
  'jefferson curls', 'olympic lifts', 'snatches', 'power cleans', 'cleans', 'clean and jerk',
  'sprints', 'plyometrics', 'hip thrusts', 'smith machine squats', 'skull crushers',
  'hanging leg raises', 'toes to bar',
];

function phraseAlternation(list: readonly string[]): string {
  return [...list]
    .sort((a, b) => b.length - a.length)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
}

const SUPPLEMENT_RE = new RegExp(
  `\\b(?:no|never|avoid|don'?t|do not|not)\\b[^.;]{0,30}?\\b(${phraseAlternation(SUPPLEMENTS)})\\b`,
  'i',
);
// The exercise must close the clause, so "no squats deeper than parallel"
// stays a custom rule instead of banning squats.
const EXERCISE_RE = new RegExp(
  `\\b(?:no|never|avoid|don'?t|do not)\\s+(?:(?:do|program|prescribe|use|any|heavy|weighted|loaded|barbell|dumbbell)\\s+){0,3}(${phraseAlternation(EXERCISES)})(?=\\s*(?:[.,;:)]|$)|\\s+(?:or|and|ever|at all|for anyone|for clients|with clients|for any client)\\b)`,
  'i',
);

export interface ParsedRedLine {
  kind: PlaybookRedLineKind;
  value?: string;
}

function kcalValue(match: RegExpMatchArray | null): string | undefined {
  if (!match) return undefined;
  const n = Number(match[1].replace(',', ''));
  return Number.isFinite(n) && n >= 800 && n <= 5000 ? String(n) : undefined;
}

/**
 * Parse a red line into a closed kind. The text decides first; the model's
 * own label is used only when the text matches no pattern and the label is
 * consistent with the text.
 */
export function parseRedLine(text: string, modelKind?: unknown, modelValue?: unknown): ParsedRedLine {
  const t = typeof text === 'string' ? text : '';
  const negated = NEGATION_RE.test(t);
  const kcal = kcalValue(t.match(KCAL_FLOOR_RE)) ?? (negated ? kcalValue(t.match(KCAL_BELOW_RE)) : undefined);
  if (negated && PAIN_RE.test(t)) return { kind: 'no_train_through_pain' };
  if (kcal) return { kind: 'min_kcal', value: kcal };
  if (negated && FASTED_RE.test(t)) return { kind: 'no_fasted_training' };
  if (negated && FAILURE_RE.test(t)) return { kind: 'no_failure_training' };
  const supplement = t.match(SUPPLEMENT_RE);
  if (supplement) return { kind: 'no_supplement', value: supplement[1].toLowerCase() };
  const exercise = t.match(EXERCISE_RE);
  if (exercise) return { kind: 'no_exercise', value: exercise[1].toLowerCase() };

  const kind = typeof modelKind === 'string' ? modelKind : '';
  if (kind === 'no_train_through_pain' || kind === 'no_failure_training' || kind === 'no_fasted_training') {
    return { kind };
  }
  if (kind === 'no_exercise' || kind === 'no_supplement') {
    const v = typeof modelValue === 'string' ? modelValue.trim() : '';
    if (v.length > 0 && v.length <= 60 && t.toLowerCase().includes(v.toLowerCase())) {
      return { kind, value: v.toLowerCase() };
    }
  }
  if (kind === 'min_kcal') {
    const n = t.match(/(\d{1,2},\d{3}|\d{3,4})/);
    const v = kcalValue(n);
    if (v) return { kind, value: v };
  }
  return { kind: 'custom' };
}

/** Code-written red-line text, used when the model's wording quoted a private source. */
export function canonicalRedLineText(parsed: ParsedRedLine): string | null {
  switch (parsed.kind) {
    case 'no_exercise':
      return parsed.value ? `Avoid ${parsed.value}.` : null;
    case 'no_supplement':
      return parsed.value ? `Do not recommend ${parsed.value}.` : null;
    case 'no_train_through_pain':
      return 'Do not train through pain.';
    case 'no_failure_training':
      return 'Do not train to failure.';
    case 'min_kcal':
      return parsed.value ? `Do not go below ${parsed.value} kcal a day.` : null;
    case 'no_fasted_training':
      return 'Do not train fasted.';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Item checks and the tree walk
// ---------------------------------------------------------------------------

interface Checker {
  roster: PlaybookRoster;
  index: ReadonlySet<string>;
}

// Closed enum fields inside an item; never free text.
const ENUM_KEYS = new Set(['basis', 'kind']);

/** First reason an item must be dropped, or null when every string is clean. */
export function itemRejectReason(
  strings: readonly string[],
  checker: Checker,
): PlaybookDropReason | null {
  for (const s of strings) if (containsPlaceholder(s)) return 'placeholder';
  for (const s of strings) if (containsContact(s, checker.roster)) return 'contact';
  for (const s of strings) if (containsRosterName(s, checker.roster)) return 'roster_name';
  for (const s of strings) if (containsDate(s)) return 'date';
  for (const s of strings) if (hasPersonTiedNumber(s)) return 'person_number';
  for (const s of strings) if (sharesVerbatimRun(s, checker.index)) return 'verbatim_source';
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isLeafItem(v: unknown): boolean {
  if (typeof v === 'string') return true;
  if (!isRecord(v)) return false;
  const values = Object.values(v);
  return (
    values.some((x) => typeof x === 'string') &&
    values.every((x) => x === null || typeof x !== 'object')
  );
}

function itemStrings(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (!isRecord(v)) return [];
  return Object.entries(v)
    .filter(([k, x]) => typeof x === 'string' && !ENUM_KEYS.has(k))
    .map(([, x]) => x as string);
}

interface WalkState {
  checker: Checker;
  dropped: PlaybookDrop[];
  rewritten: PlaybookDrop[];
  kept: number;
}

function cleanRedLine(el: unknown, path: string, st: WalkState): unknown {
  const rec: Record<string, unknown> = isRecord(el) ? { ...el } : { text: el };
  const text = typeof rec.text === 'string' ? rec.text : '';
  const parsed = parseRedLine(text, rec.kind, rec.value);
  const next: Record<string, unknown> = { ...rec, kind: parsed.kind };
  if (parsed.value !== undefined) next.value = parsed.value;
  else delete next.value;
  const reason = itemRejectReason(itemStrings(next), st.checker);
  if (!reason) {
    st.kept += 1;
    return next;
  }
  if (reason === 'verbatim_source') {
    const canonical = canonicalRedLineText(parsed);
    if (canonical) {
      next.text = canonical;
      if (!itemRejectReason(itemStrings(next), st.checker)) {
        st.rewritten.push({ path, reason });
        st.kept += 1;
        return next;
      }
    }
  }
  st.dropped.push({ path, reason });
  return null;
}

function walk(node: unknown, path: string, st: WalkState): unknown {
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    node.forEach((el, i) => {
      const p = `${path}[${i}]`;
      if (isLeafItem(el)) {
        const reason = itemRejectReason(itemStrings(el), st.checker);
        if (reason) st.dropped.push({ path: p, reason });
        else {
          st.kept += 1;
          out.push(el);
        }
      } else {
        out.push(walk(el, p, st));
      }
    });
    return out;
  }
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    const p = path ? `${path}.${key}` : key;
    if (key === 'red_lines' && Array.isArray(value)) {
      out[key] = value
        .map((el, i) => cleanRedLine(el, `${p}[${i}]`, st))
        .filter((el) => el !== null);
    } else if ((typeof value === 'string' && !ENUM_KEYS.has(key)) || (isRecord(value) && isLeafItem(value))) {
      const reason = itemRejectReason(itemStrings(value), st.checker);
      if (reason) st.dropped.push({ path: p, reason });
      else {
        st.kept += 1;
        out[key] = value;
      }
    } else {
      out[key] = walk(value, p, st);
    }
  }
  return out;
}

/** Validate the model's playbook draft and drop anything identifying or quoted. */
export function validatePlaybookDraft<T>(
  raw: unknown,
  ctx: PlaybookValidateContext<T>,
): PlaybookValidateResult<T> {
  const first = ctx.schema(raw);
  if (!first.ok) return { ok: false, reason: 'schema_invalid', errors: first.errors };
  const st: WalkState = {
    checker: { roster: ctx.roster, index: buildVerbatimIndex(ctx.privateTexts) },
    dropped: [],
    rewritten: [],
    kept: 0,
  };
  const filtered = walk(first.value, '', st);
  const second = ctx.schema(filtered);
  if (!second.ok) return { ok: false, reason: 'schema_invalid_after_filter', errors: second.errors };
  return { ok: true, value: second.value, dropped: st.dropped, rewritten: st.rewritten, kept_items: st.kept };
}
