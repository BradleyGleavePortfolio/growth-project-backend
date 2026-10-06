import { broadcastError } from './broadcast-errors';

/**
 * Broadcast audience definition. Always evaluated inside the author's
 * authorized roster (head coach: own clients; sub-coach: assigned clients),
 * so no rule can widen the audience past the tenant.
 *
 *   { match: 'all' | 'any', rules: Rule[], exclude_client_ids?: string[] }
 *   rules: [] means "every client on my roster".
 *
 * Rule fields:
 *   package      op in            values: package ids (active entitlement)
 *   program      op in            values: workout program ids (assigned)
 *   tag          op in | not_in   values: coach-private tags
 *   signup_date  op within_days | before_days  value: days (1-3650)
 *   last_active  op within_days | not_within_days  value: days (1-365)
 *   risk         op in            values: red | amber | green | unknown
 */
export type SegmentRule =
  | { field: 'package'; op: 'in'; values: string[] }
  | { field: 'program'; op: 'in'; values: string[] }
  | { field: 'tag'; op: 'in' | 'not_in'; values: string[] }
  | { field: 'signup_date'; op: 'within_days' | 'before_days'; value: number }
  | { field: 'last_active'; op: 'within_days' | 'not_within_days'; value: number }
  | { field: 'risk'; op: 'in'; values: Array<'red' | 'amber' | 'green' | 'unknown'> };

export interface Segment {
  match: 'all' | 'any';
  rules: SegmentRule[];
  exclude_client_ids?: string[];
}

const MAX_RULES = 10;
const MAX_VALUES = 50;
const MAX_EXCLUDES = 500;
const ID_RE = /^[0-9a-fA-F-]{8,64}$/;
const RISK = new Set(['red', 'amber', 'green', 'unknown']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function normalizeTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (t.length < 1 || t.length > 32) return null;
  if (!/^[a-z0-9 _-]+$/.test(t)) return null;
  return t;
}

function stringValues(v: unknown, kind: 'id' | 'tag', bad: (r: string) => Error): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_VALUES) throw bad('values');
  const out = new Set<string>();
  for (const x of v) {
    if (kind === 'id') {
      if (typeof x !== 'string' || !ID_RE.test(x)) throw bad('value_id');
      out.add(x);
    } else {
      const t = normalizeTag(x);
      if (!t) throw bad('value_tag');
      out.add(t);
    }
  }
  return [...out];
}

function days(v: unknown, max: number, bad: (r: string) => Error): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) throw bad('value_days');
  return v;
}

/** Validate untrusted input. Throws broadcast.segment_invalid. */
export function parseSegment(input: unknown): Segment {
  const bad = (reason: string) => broadcastError('broadcast.segment_invalid', { reason });
  if (!isPlainObject(input)) throw bad('not_an_object');
  for (const k of Object.keys(input)) {
    if (!['match', 'rules', 'exclude_client_ids'].includes(k)) throw bad(`unknown_field:${k}`);
  }
  const match = input.match ?? 'all';
  if (match !== 'all' && match !== 'any') throw bad('match');
  const rawRules = input.rules ?? [];
  if (!Array.isArray(rawRules) || rawRules.length > MAX_RULES) throw bad('rules');
  const rules: SegmentRule[] = rawRules.map((r): SegmentRule => {
    if (!isPlainObject(r)) throw bad('rule');
    switch (r.field) {
      case 'package':
      case 'program':
        if (r.op !== 'in') throw bad('op');
        return { field: r.field, op: 'in', values: stringValues(r.values, 'id', bad) };
      case 'tag':
        if (r.op !== 'in' && r.op !== 'not_in') throw bad('op');
        return { field: 'tag', op: r.op, values: stringValues(r.values, 'tag', bad) };
      case 'signup_date':
        if (r.op !== 'within_days' && r.op !== 'before_days') throw bad('op');
        return { field: 'signup_date', op: r.op, value: days(r.value, 3650, bad) };
      case 'last_active':
        if (r.op !== 'within_days' && r.op !== 'not_within_days') throw bad('op');
        return { field: 'last_active', op: r.op, value: days(r.value, 365, bad) };
      case 'risk': {
        if (r.op !== 'in') throw bad('op');
        if (!Array.isArray(r.values) || r.values.length === 0 || r.values.length > 4)
          throw bad('values');
        const vals = new Set<'red' | 'amber' | 'green' | 'unknown'>();
        for (const v of r.values) {
          if (typeof v !== 'string' || !RISK.has(v)) throw bad('value_risk');
          vals.add(v as 'red' | 'amber' | 'green' | 'unknown');
        }
        return { field: 'risk', op: 'in', values: [...vals] };
      }
      default:
        throw bad('field');
    }
  });
  const seg: Segment = { match, rules };
  if (input.exclude_client_ids !== undefined) {
    const ex = input.exclude_client_ids;
    if (!Array.isArray(ex) || ex.length > MAX_EXCLUDES) throw bad('exclude_client_ids');
    const set = new Set<string>();
    for (const x of ex) {
      if (typeof x !== 'string' || !ID_RE.test(x)) throw bad('exclude_client_ids');
      set.add(x);
    }
    seg.exclude_client_ids = [...set];
  }
  return seg;
}

/** Pure combination step, unit-tested on its own. */
export function combineRuleSets(
  roster: string[],
  match: 'all' | 'any',
  ruleSets: Array<Set<string>>,
  exclude: string[] = [],
): string[] {
  const ex = new Set(exclude);
  return roster.filter((id) => {
    if (ex.has(id)) return false;
    if (ruleSets.length === 0) return true;
    return match === 'all' ? ruleSets.every((s) => s.has(id)) : ruleSets.some((s) => s.has(id));
  });
}
