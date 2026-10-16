/**
 * The subset of a Prisma `where` the notification inbox uses, read the way
 * Postgres reads it: AND / OR / NOT (one or a list), equality, null, not,
 * in / notIn, startsWith, gte / gt / lt, a JSON `path` + `equals`, and a
 * to-one relation `is`.
 */
type W = Record<string, unknown>;

function field(actual: unknown, cond: unknown): boolean {
  if (cond === null) return actual === null || actual === undefined;
  if (cond instanceof Date || typeof cond !== 'object') {
    return cond instanceof Date ? actual instanceof Date && +actual === +cond : actual === cond;
  }
  const c = cond as W;
  if ('is' in c) return !!actual && whereMatches(actual as object, c.is);
  if ('path' in c) {
    const at = (c.path as string[]).reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as W)[k] : undefined), actual);
    return at === c.equals;
  }
  if ('not' in c && !('notIn' in c) && c.not !== null) return actual !== c.not;
  if (actual === null || actual === undefined) return false;
  const v = actual instanceof Date ? +actual : actual;
  const n = (x: unknown) => (x instanceof Date ? +x : x) as number;
  return (
    (!('in' in c) || (c.in as unknown[]).includes(actual)) &&
    (!('notIn' in c) || !(c.notIn as unknown[]).includes(actual)) &&
    (!('startsWith' in c) || String(actual).startsWith(c.startsWith as string)) &&
    (!('gte' in c) || (v as number) >= n(c.gte)) &&
    (!('gt' in c) || (v as number) > n(c.gt)) &&
    (!('lt' in c) || (v as number) < n(c.lt))
  );
}

export function whereMatches(row: object, where: unknown = {}): boolean {
  const list = (x: unknown) => (Array.isArray(x) ? x : [x]);
  return Object.entries(where as W).every(([k, cond]) => {
    if (k === 'AND') return list(cond).every((w) => whereMatches(row, w));
    if (k === 'OR') return (cond as unknown[]).some((w) => whereMatches(row, w));
    if (k === 'NOT') return list(cond).every((w) => !whereMatches(row, w));
    return field((row as W)[k], cond);
  });
}
