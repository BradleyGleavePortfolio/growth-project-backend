// Tiny CSV serializer. We intentionally do not pull in a CSV dependency
// because the surface here is small, fully internal to the admin reports
// module, and the rules below cover what the operator console needs.
//
// RFC 4180 quoting rules used:
//   - Fields containing comma, quote, CR, or LF are wrapped in quotes.
//   - Embedded quotes are escaped as "" (two double-quotes).
//   - Line terminator is CRLF.
//   - null / undefined become an empty cell.
//   - Date is serialized via toISOString() so the output is timezone-explicit.
//   - Objects (Json columns, nested rows) are serialized as JSON so the cell
//     stays a single CSV field — the operator can post-process if needed.

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (value instanceof Date) {
    s = value.toISOString();
  } else if (typeof value === 'object') {
    s = JSON.stringify(value);
  } else {
    s = String(value);
  }
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function rowsToCsv<T>(
  columns: ReadonlyArray<string>,
  rows: ReadonlyArray<T>,
): string {
  const header = columns.map((c) => csvEscape(c)).join(',');
  const body = rows.map((row) =>
    columns.map((c) => csvEscape((row as Record<string, unknown>)[c])).join(','),
  );
  return [header, ...body].join('\r\n') + '\r\n';
}

// Flatten a single object payload (e.g. /metrics overview) into a two-column
// key/value CSV. Nested values are JSON-encoded so the file stays a flat
// table — the JSON form is preserved verbatim so downstream tools can
// re-parse if needed.
export function objectToKeyValueCsv(
  payload: Record<string, unknown>,
  prefix = '',
): string {
  const flat: Array<{ key: string; value: unknown }> = [];
  flatten(payload, prefix, flat);
  return rowsToCsv(['key', 'value'] as const, flat);
}

function flatten(
  value: unknown,
  path: string,
  out: Array<{ key: string; value: unknown }>,
): void {
  if (
    value === null ||
    value === undefined ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value instanceof Date
  ) {
    out.push({ key: path, value });
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const next = path ? `${path}.${k}` : k;
    flatten(v, next, out);
  }
}
