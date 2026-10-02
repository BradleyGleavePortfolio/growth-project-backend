import {
  type ArgumentsHost,
  BadRequestException,
  Catch,
  type ExceptionFilter,
} from '@nestjs/common';
import { HttpExceptionFilter } from '../filters/http-exception.filter';

// S-FEE round 4 (C-629-2) — the global ValidationPipe rejects a bad package
// body with a code-less 400 whose message is an array of class-validator
// strings, so clients could only show a generic error. On the coach package
// routes such a 400 becomes `code: 'PACKAGE_INVALID'` with one human message
// that names the field(s) and the next action. Bodies that already carry a
// machine code (every PackagesService refusal) pass through unchanged; the
// envelope itself is still built by HttpExceptionFilter.
export const PACKAGE_INVALID_CODE = 'PACKAGE_INVALID';

const UNKNOWN_PROPERTY = /^property (\S+) should not exist$/;
const LEADING_FIELD = /^([a-z_][a-z0-9_]*)\s/i;

function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The PACKAGE_INVALID body for a class-validator 400, or null to pass it through. */
export function packageInvalidBody(
  response: unknown,
): { code: string; error: string; message: string } | null {
  if (!response || typeof response !== 'object') return null;
  const body = response as { code?: unknown; message?: unknown };
  if (typeof body.code === 'string' || !Array.isArray(body.message)) return null;
  const messages = [
    ...new Set(body.message.filter((m): m is string => typeof m === 'string' && m.trim() !== '')),
  ];
  if (messages.length === 0) return null;
  const invalid: string[] = [];
  const unknown: string[] = [];
  const text: string[] = [];
  for (const m of messages) {
    const extra = UNKNOWN_PROPERTY.exec(m.trim());
    if (extra) {
      if (!unknown.includes(extra[1])) unknown.push(extra[1]);
      continue;
    }
    const field = LEADING_FIELD.exec(m.trim())?.[1];
    if (field && !invalid.includes(field)) invalid.push(field);
    text.push(sentence(m));
  }
  const next: string[] = [];
  if (invalid.length) next.push(`Check ${list(invalid)} and save again.`);
  if (unknown.length) {
    next.push(
      `Remove ${list(unknown)}: packages do not accept ${unknown.length === 1 ? 'that field' : 'those fields'}.`,
    );
  }
  return {
    code: PACKAGE_INVALID_CODE,
    error: PACKAGE_INVALID_CODE,
    message: [...text, ...next].join(' '),
  };
}

@Catch(BadRequestException)
export class PackageValidationFilter implements ExceptionFilter {
  private readonly envelope = new HttpExceptionFilter();

  catch(exception: BadRequestException, host: ArgumentsHost): void {
    const body = packageInvalidBody(exception.getResponse());
    this.envelope.catch(body ? new BadRequestException(body) : exception, host);
  }
}
