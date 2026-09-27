// Natural-language quantity/unit extractor for food search queries.
//
// Users type things like "6oz chicken breast", "1/2 cup oats", "2 slices
// bread". Previously the entire string went through trigram similarity,
// which both produced bad matches and forced the user to re-enter the
// quantity in the picker. This module pulls the leading number + unit out
// of the query and hands the remaining noun phrase to the upstream search,
// leaving the quantity/unit for mobile to pre-fill.
//
// The regex is intentionally narrow — it only matches a number (decimal or
// fraction) followed by a known unit followed by at least one more token.
// Anything else falls through to "no parse, use the whole query as the food
// name", which is the safe default. We do NOT try to extract brands, adjectives,
// or compound quantities ("1 cup of oats AND a banana") — those are out of
// scope for the Trainerize-grade floor (see audit §9 / §10).

export type CanonicalUnit =
  | 'g'
  | 'oz'
  | 'cup'
  | 'tbsp'
  | 'tsp'
  | 'slice'
  | 'piece';

export interface ParsedFoodQuery {
  /** Numeric quantity if one was parsed (e.g. 0.5 for "1/2"). */
  quantity?: number;
  /** Canonical unit (plural/synonyms folded). */
  unit?: CanonicalUnit;
  /** Remaining food noun phrase, trimmed, to send to upstream search. */
  foodName: string;
}

// Plural / synonym → canonical unit. Lowercased; longest forms first to
// avoid partial matches (e.g. "tablespoons" before "tablespoon").
const UNIT_MAP: Record<string, CanonicalUnit> = {
  grams: 'g',
  gram: 'g',
  g: 'g',
  oz: 'oz',
  ounces: 'oz',
  ounce: 'oz',
  cups: 'cup',
  cup: 'cup',
  tablespoons: 'tbsp',
  tablespoon: 'tbsp',
  tbsp: 'tbsp',
  tbs: 'tbsp',
  teaspoons: 'tsp',
  teaspoon: 'tsp',
  tsp: 'tsp',
  slices: 'slice',
  slice: 'slice',
  pieces: 'piece',
  piece: 'piece',
};

// Sorted longest-first to anchor regex greedily on multi-letter units.
const UNIT_ALTERNATION = Object.keys(UNIT_MAP)
  .sort((a, b) => b.length - a.length)
  .join('|');

// Allow: decimal ("0.5", "1.25"), fraction ("1/2", "3/4"), or integer ("12").
// Captures: 1=quantity, 2=unit, 3=remaining food name.
// `\s*` between quantity and unit so "6oz" and "6 oz" both match.
const QUERY_RE = new RegExp(
  `^\\s*(\\d+\\/\\d+|\\d+(?:\\.\\d+)?)\\s*(${UNIT_ALTERNATION})\\b\\s+(.+?)\\s*$`,
  'i',
);

function parseNumeric(raw: string): number | null {
  if (raw.includes('/')) {
    const [num, denom] = raw.split('/').map((s) => parseFloat(s));
    if (!Number.isFinite(num) || !Number.isFinite(denom) || denom === 0) return null;
    return num / denom;
  }
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pull a leading "<qty> <unit>" off the query, if present, and return the
 * remaining food name. On no match returns `{ foodName: original.trim() }`
 * with no quantity/unit. Always safe — never throws.
 */
export function parseFoodQuery(q: string): ParsedFoodQuery {
  const trimmed = (q || '').trim();
  if (!trimmed) return { foodName: '' };

  const match = QUERY_RE.exec(trimmed);
  if (!match) return { foodName: trimmed };

  const [, qtyRaw, unitRaw, foodName] = match;
  const quantity = parseNumeric(qtyRaw);
  const unit = UNIT_MAP[unitRaw.toLowerCase()];
  if (quantity == null || !unit || !foodName.trim()) {
    return { foodName: trimmed };
  }

  return {
    quantity,
    unit,
    foodName: foodName.trim(),
  };
}
