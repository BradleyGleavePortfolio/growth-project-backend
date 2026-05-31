import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

// Local DTOs + helpers for the payment-ops coach surface.
//
// These live in the checkout module (alongside payment-ops.controller.ts)
// rather than reaching into the connect/fees or admin/reports modules, so
// the pagination + CSV idiom here is self-contained and does not couple
// payment-ops to another module's internals.

// Strictly coerce a query-string scalar into an int for the global
// ValidationPipe (transform:true). Unlike parseInt, this does NOT silently
// accept partially-numeric garbage: only a string that is EXACTLY a base-10
// integer (optional sign, all digits, no decimal point, no exponent, no
// trailing suffix) is converted to a number. Anything else is returned
// unchanged so @IsInt rejects it with a clean 400 instead of being coerced
// (e.g. "50abc" -> "50abc" -> 400, not 50; "1.5", "1e2", "0x10" likewise).
const STRICT_INT_RE = /^[+-]?\d+$/;
const coerceInt = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  // A value that is already a real JS number: keep integers, let @IsInt
  // reject non-integers (e.g. 1.5) rather than truncating them.
  if (typeof value === 'number') return value;
  const s = String(value).trim();
  if (!STRICT_INT_RE.test(s)) return value;
  const n = Number(s);
  // Guard against values past Number's safe-integer range (which @IsInt /
  // @Max would otherwise mishandle); preserve the raw string so it 400s.
  return Number.isSafeInteger(n) ? n : value;
};

// Default page size and hard cap for the coach-facing cursor lists. The
// cap protects the DB from an unbounded `take` (B5/B6) while the default
// keeps the common case cheap.
export const PAYMENT_OPS_DEFAULT_LIMIT = 50;
export const PAYMENT_OPS_MAX_LIMIT = 100;

// Cursor-paginated query for the coach's own purchases / earnings lists.
//   - `limit` is clamped to [1, 100]; a non-integer or out-of-range value
//     is rejected with 400 by the global ValidationPipe.
//   - `cursor` is the `id` of the last row from the previous page. It must
//     be a UUID (every paginated row uses a uuid primary key), so a
//     malformed cursor is rejected with 400 instead of silently scanning
//     from the top.
export class CursorPageQueryDto {
  @IsOptional()
  @Transform(coerceInt)
  @IsInt()
  @Min(1)
  @Max(PAYMENT_OPS_MAX_LIMIT)
  limit?: number;

  @IsOptional()
  @IsUUID()
  cursor?: string;
}

// --- Minimal RFC-4180 CSV serializer (module-local) ---
//
// Kept here rather than importing admin/reports/csv.ts to avoid coupling
// payment-ops to another module. Same quoting rules: fields containing a
// comma, quote, CR or LF are wrapped in double-quotes; embedded quotes are
// doubled; null/undefined become an empty cell; Date is ISO-8601; objects
// are JSON-encoded so each cell stays a single field. Line terminator CRLF.
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
    columns
      .map((c) => csvEscape((row as Record<string, unknown>)[c]))
      .join(','),
  );
  return [header, ...body].join('\r\n') + '\r\n';
}
