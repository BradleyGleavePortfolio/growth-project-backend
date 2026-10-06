/**
 * Roman v1.1 slice R11-P3a: scrub before send (privacy core of the coach twin).
 *
 * The playbook builder (R11-P3b) sends a head coach's own material (session
 * notes, messages to clients, plan notes) to the model so it can learn the
 * coach's methods. Nothing that identifies a client may leave for the provider
 * or end up in a playbook that later shapes other clients' replies. Every
 * source string passes through scrubPlaybookText first; the matching
 * detectors below are reused by playbook-validate.ts on the model's output.
 *
 * Classes replaced, in this order (most specific shape first):
 *   email -> [EMAIL], url -> [LINK], @handle -> [HANDLE], phone -> [PHONE],
 *   date -> [DATE], roster name (the coach's clients and sub-coaches) -> [NAME].
 *
 * Pure functions, no I/O, no logging. Over-scrubbing is acceptable; leaking is
 * not. The roster is loaded by the caller (P3b) from User.name, the
 * leaderboard display name, email and phone of every client and sub-coach of
 * the head coach.
 */

export const PLAYBOOK_SCRUB_TOKENS = {
  email: '[EMAIL]',
  url: '[LINK]',
  handle: '[HANDLE]',
  phone: '[PHONE]',
  date: '[DATE]',
  name: '[NAME]',
} as const;

export type PlaybookScrubClass = keyof typeof PLAYBOOK_SCRUB_TOKENS;

/** One person whose identity must never reach the provider or a playbook. */
export interface PlaybookRosterPerson {
  name?: string | null;
  display_name?: string | null;
  email?: string | null;
  phone?: string | null;
}

/** Compiled roster matchers. Build once per playbook run. */
export interface PlaybookRoster {
  /** Name tokens matched in any letter case (longest first). */
  readonly anyCase: RegExp | null;
  /** Name tokens that are also ordinary words: matched only when capitalised. */
  readonly capitalised: RegExp | null;
  /** Exact roster phone numbers, any separators. */
  readonly phones: readonly RegExp[];
  /** Number of distinct name tokens (for tests and run metadata). */
  readonly tokenCount: number;
}

// Name parts that are titles or product words, never treated as a name token.
const NON_NAME_TOKENS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'jr', 'sr', 'ii', 'iii', 'iv',
  'coach', 'team', 'the', 'and', 'of', 'fit', 'fitness', 'training', 'client',
]);

// Names that are also ordinary (often fitness or food) words. They are
// replaced only when written capitalised, so "max effort" or "brown rice"
// survive while "Max" or "Rice" as a name does not.
const COMMON_WORD_NAMES = new Set([
  'will', 'max', 'grace', 'hope', 'faith', 'joy', 'rich', 'bob', 'mark', 'frank',
  'jack', 'bill', 'pat', 'sue', 'dean', 'rose', 'may', 'june', 'april', 'august',
  'summer', 'dawn', 'eve', 'iris', 'ivy', 'lily', 'ruby', 'jean', 'ray', 'sky',
  'art', 'rob', 'chase', 'hunter', 'cash', 'drew', 'wade', 'lane', 'page', 'reed',
  'miles', 'cole', 'kit', 'bo', 'gene', 'sunny', 'star', 'amber', 'rocky', 'buck',
  'guy', 'nick', 'don', 'ken', 'dash', 'long', 'young', 'strong', 'white', 'black',
  'brown', 'green', 'gray', 'grey', 'hill', 'wood', 'cook', 'baker', 'walker',
  'price', 'rice', 'fields', 'banks', 'bell', 'stone', 'king', 'park', 'lee',
  'best', 'love', 'early', 'short', 'little', 'church', 'hall', 'west', 'north',
]);

const LETTER_BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}_])';
const LETTER_BOUNDARY_AFTER = '(?![\\p{L}\\p{N}_])';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanNameToken(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')
    .trim();
}

function nameTokensOf(value: string | null | undefined): string[] {
  if (typeof value !== 'string') return [];
  const full = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!full) return [];
  const out: string[] = [];
  const whole = cleanNameToken(full);
  if (whole.length >= 2 && whole.includes(' ')) out.push(whole);
  for (const word of full.split(' ')) {
    const w = cleanNameToken(word);
    if (w.length >= 2) out.push(w);
    if (w.includes('-')) {
      for (const part of w.split('-')) {
        const p = cleanNameToken(part);
        if (p.length >= 2) out.push(p);
      }
    }
  }
  return out.filter((t) => !NON_NAME_TOKENS.has(t.toLowerCase()));
}

function alternation(tokens: string[], flags: string): RegExp | null {
  if (tokens.length === 0) return null;
  const sorted = [...new Set(tokens)].sort((a, b) => b.length - a.length);
  return new RegExp(
    `${LETTER_BOUNDARY_BEFORE}(?:${sorted.map(escapeRegExp).join('|')})${LETTER_BOUNDARY_AFTER}`,
    flags,
  );
}

function capitalise(token: string): string {
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

/** Compile the roster (the coach's clients and sub-coaches) into matchers. */
export function buildPlaybookRoster(people: readonly PlaybookRosterPerson[]): PlaybookRoster {
  const anyCase: string[] = [];
  const capitalised: string[] = [];
  const phones: RegExp[] = [];
  const seen = new Set<string>();
  for (const person of people) {
    for (const token of [...nameTokensOf(person.name), ...nameTokensOf(person.display_name)]) {
      const key = token.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (!key.includes(' ') && COMMON_WORD_NAMES.has(key)) {
        capitalised.push(capitalise(token), token.toUpperCase());
      } else {
        anyCase.push(token);
      }
    }
    const digits = typeof person.phone === 'string' ? person.phone.replace(/\D/g, '') : '';
    if (digits.length >= 7) {
      phones.push(new RegExp(digits.split('').join('[\\s().+-]{0,3}'), 'g'));
    }
  }
  return {
    anyCase: alternation(anyCase, 'giu'),
    capitalised: alternation(capitalised, 'gu'),
    phones,
    tokenCount: seen.size,
  };
}

// Email addresses (conservative).
const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[a-z]{2,}/giu;
// Links: scheme or www, or a bare domain with a common top-level domain.
const URL_RE =
  /\b(?:https?:\/\/|www\.)[^\s<>()]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|app|me|uk|us|ca|au|ly|gg|tv|fit|info|biz|link|page|health)\b(?:\/[^\s<>()]*)?/gi;
// Social handles (@name), not preceded by a word character or a dot.
const HANDLE_RE = /(?<![\p{L}\p{N}_.])@[\p{L}\p{N}_](?:[\p{L}\p{N}_.]{0,29}[\p{L}\p{N}_])?/gu;
// Digit runs with phone separators. Classified by isPhoneShaped below.
const PHONE_CANDIDATE_RE = /(?<![\p{L}\p{N}_+])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d(?:[\s.-]?\d){6,14}(?![\p{L}\p{N}_])/gu;

const MONTHS =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DAY = '\\d{1,2}(?:st|nd|rd|th)?';
const YEAR = "(?:\\d{4}|'\\d{2})";
const DATE_RES: readonly RegExp[] = [
  // 2026-10-06, 2026/10/6
  /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g,
  // 06/10/2026, 6.10.2026, 6-10-2026, 10/6/26
  /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{4}\b|\b\d{1,2}\/\d{1,2}\/\d{2}\b/g,
  // Oct 6, October 6th, Oct 6, 2026
  new RegExp(`\\b(?:${MONTHS})\\.?\\s+${DAY}(?:,?\\s+${YEAR})?\\b`, 'gi'),
  // 6 Oct, 6th of October 2026
  new RegExp(`\\b${DAY}\\s+(?:of\\s+)?(?:${MONTHS})\\b\\.?(?:,?\\s+${YEAR}\\b)?`, 'gi'),
  // October 2026, Oct '26
  new RegExp(`\\b(?:${MONTHS})\\.?\\s+${YEAR}\\b`, 'gi'),
];

function isPhoneShaped(match: string): boolean {
  const digits = (match.match(/\d/g) ?? []).length;
  if (digits >= 10) return true;
  if (match.startsWith('+') && digits >= 8) return true;
  return match.includes('(') && digits >= 7;
}

function hit(re: RegExp | null, text: string): boolean {
  if (!re) return false;
  re.lastIndex = 0;
  const found = re.test(text);
  re.lastIndex = 0;
  return found;
}

/** Replace every identifying shape in one source string with placeholders. */
export function scrubPlaybookText(text: unknown, roster: PlaybookRoster): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  let s = text.normalize('NFC');
  s = s.replace(EMAIL_RE, PLAYBOOK_SCRUB_TOKENS.email);
  s = s.replace(URL_RE, PLAYBOOK_SCRUB_TOKENS.url);
  s = s.replace(HANDLE_RE, PLAYBOOK_SCRUB_TOKENS.handle);
  s = s.replace(PHONE_CANDIDATE_RE, (m) => (isPhoneShaped(m) ? PLAYBOOK_SCRUB_TOKENS.phone : m));
  for (const re of roster.phones) s = s.replace(re, PLAYBOOK_SCRUB_TOKENS.phone);
  for (const re of DATE_RES) s = s.replace(re, PLAYBOOK_SCRUB_TOKENS.date);
  if (roster.anyCase) s = s.replace(roster.anyCase, PLAYBOOK_SCRUB_TOKENS.name);
  if (roster.capitalised) s = s.replace(roster.capitalised, PLAYBOOK_SCRUB_TOKENS.name);
  return s;
}

/** True when the text names anyone on the roster. */
export function containsRosterName(text: string, roster: PlaybookRoster): boolean {
  const s = text.normalize('NFC');
  return hit(roster.anyCase, s) || hit(roster.capitalised, s);
}

/** True when the text carries an email, link, handle or phone number. */
export function containsContact(text: string, roster?: PlaybookRoster): boolean {
  if (hit(EMAIL_RE, text) || hit(URL_RE, text) || hit(HANDLE_RE, text)) return true;
  if (roster && roster.phones.some((re) => hit(re, text))) return true;
  PHONE_CANDIDATE_RE.lastIndex = 0;
  for (const m of text.matchAll(PHONE_CANDIDATE_RE)) {
    if (isPhoneShaped(m[0])) return true;
  }
  return false;
}

/** True when the text carries a calendar date. */
export function containsDate(text: string): boolean {
  return DATE_RES.some((re) => hit(re, text));
}

const SCRUB_TOKEN_RE = /\[\s*(?:name|email|link|url|handle|phone|date|redacted|client)\s*\]/i;

/** True when the text still holds a scrub placeholder (the model copied one). */
export function containsPlaceholder(text: string): boolean {
  return SCRUB_TOKEN_RE.test(text);
}
