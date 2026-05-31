import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

// Local DTOs + helpers for the payment-ops coach surface.
//
// These live in the checkout module (alongside payment-ops.controller.ts)
// rather than reaching into the connect/fees or admin/reports modules, so
// the pagination + CSV idiom here is self-contained and does not couple
// payment-ops to another module's internals.

// Coerce a query-string scalar into an int. Mirrors the repo idiom in
// bloodwork.dto.ts so the global ValidationPipe (transform:true) hands the
// handler a real number, and a non-numeric value falls through to @IsInt
// for a clean 400 rather than being silently dropped.
const coerceInt = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = parseInt(String(value), 10);
  return Number.isNaN(n) ? value : n;
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
