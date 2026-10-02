/**
 * Objectionable-content filter for community submissions (Apple 1.2).
 *
 * No moderation/filter service existed in the backend (checked 2026-09-30:
 * only prompt sanitisation, length limits and rate limits), so this is a small
 * deterministic, dependency-free filter applied BEFORE publication on every
 * community text write (posts, comments, cohort messages, DMs, challenge
 * comments). It blocks slurs, sexually explicit terms, threats and
 * self-harm encouragement. It does not try to be a classifier: anything it
 * misses is caught by Report -> moderation queue -> hide/warn/ban.
 *
 * Matching: lower-cased, accents stripped, common character substitutions
 * folded (0->o, 1->i, 3->e, 4->a, 5->s, 7->t, @->a, $->s), repeated letters
 * collapsed, separators between single letters removed ("f.u.c.k"), and every
 * term matched on word boundaries so ordinary words that merely contain a
 * term are not blocked.
 *
 * The term list is stored ROT13-encoded so this source file does not carry
 * slurs in plain text; decodeTerm() reverses it at module load.
 */

const ENCODED_TERMS: readonly string[] = [
  'avttre',
  'avttn',
  'puvax',
  'tbbx',
  'fcvp',
  'jrgonpx',
  'xvxr',
  'enturnq',
  'gbjryurnq',
  'ornare',
  'cnxv',
  'snttbg',
  'qlxr',
  'genaal',
  'furznyr',
  'ergneq',
  'ergneqrq',
  'phag',
  'chffl',
  'oybjwbo',
  'unaqwbo',
  'phzfubg',
  'tnatonat',
  'cbea',
  'cbeab',
  'cbeauho',
  'kivqrbf',
  'baylsnaf',
  'ahqrf',
  'qvpxcvp',
  'xvyy lbhefrys',
  'xlf',
  'tb qvr',
  'unat lbhefrys',
  'v jvyy xvyy lbh',
  'vyy xvyy lbh',
  "v'yy xvyy lbh",
  'encr lbh',
  'encvfg',
  'zbgureshpxre',
  'shpx lbh',
  'shpx bss',
  'ovgpu',
  'juber',
  'fyhg',
];

function rot13(s: string): string {
  return s.replace(/[a-z]/gi, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

const SUBSTITUTIONS: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '!': 'i',
  '3': 'e',
  '4': 'a',
  '@': 'a',
  '5': 's',
  $: 's',
  '7': 't',
  '+': 't',
};

/** Normalise free text for matching. Exported for tests. */
export function normaliseForFilter(input: string): string {
  let s = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  s = s.replace(/[01!34@5$7+]/g, (c) => SUBSTITUTIONS[c] ?? c);
  // "f.u.c.k" / "f u c k" -> "fuck": drop separators between single letters.
  s = s.replace(/\b([a-z])(?:[\s._*-]+(?=[a-z]\b))/g, '$1');
  // collapse 3+ repeated letters ("fuuuuck" -> "fuck"), keep doubles ("book").
  s = s.replace(/([a-z])\1{2,}/g, '$1');
  s = s
    .replace(/[^a-z' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TERMS = ENCODED_TERMS.map((t) => normaliseForFilter(rot13(t)));
const TERM_RES = TERMS.map(
  (t) => new RegExp(`(?:^|[^a-z])${escapeRe(t)}(?:s|es|ed|ing)?(?=$|[^a-z])`),
);

export interface ContentFilterResult {
  allowed: boolean;
  /** Number of distinct blocked terms matched (never the terms themselves). */
  matches: number;
}

/** Check one or more text fields (null/undefined fields are ignored). */
export function checkCommunityText(
  ...fields: Array<string | null | undefined>
): ContentFilterResult {
  let matches = 0;
  for (const field of fields) {
    if (!field) continue;
    const norm = normaliseForFilter(field);
    if (!norm) continue;
    for (const re of TERM_RES) {
      if (re.test(norm)) matches += 1;
    }
  }
  return { allowed: matches === 0, matches };
}

/** Number of terms in the list (tests assert the list is loaded). */
export const COMMUNITY_FILTER_TERM_COUNT = TERMS.length;
