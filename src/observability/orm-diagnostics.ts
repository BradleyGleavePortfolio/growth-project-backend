import { Prisma } from '@prisma/client';

export const ORM_ERROR_NAME =
  /^(?:PrismaClient(?:KnownRequest|UnknownRequest|Validation|Initialization|RustPanic)Error|DatabaseRequestError)$/;

/** ORM messages, stacks, metadata and causes can embed entire query arguments. */
export function safeDiagnostic(error: unknown): unknown {
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (ORM_ERROR_NAME.test(current.name)) {
      const code =
        current instanceof Prisma.PrismaClientKnownRequestError && /^P\d{4}$/.test(current.code)
          ? ` (${current.code})`
          : '';
      const safe = new Error(`Database request failed${code}`);
      safe.name = 'DatabaseRequestError';
      return safe;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return error;
}

/**
 * The only text a log line may carry for an error: ORM errors (also when
 * wrapped as a cause) collapse to `DatabaseRequestError: Database request
 * failed (P####)`; any other error keeps only its class name and a
 * machine-shaped `code`. Free-form messages, stacks and metadata never
 * pass, because they can echo names, notes, links or query arguments.
 */
export function safeLogDiagnostic(error: unknown): string {
  const safe = safeDiagnostic(error);
  if (!(safe instanceof Error)) return 'unknown error';
  if (safe !== error) return `${safe.name}: ${safe.message}`;
  const name = /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(safe.name) ? safe.name : 'Error';
  const code: unknown = 'code' in safe ? safe.code : undefined;
  return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(code)
    ? `${name} (${code})`
    : name;
}
