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
