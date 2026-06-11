/**
 * MWB-5 — shared error + coercion helpers for the two live-create materialisers.
 *
 * Lives in the materialisers' own `__shared/` directory (the same surface as
 * `workout-diff.types.ts` / `workout-diff.applier.ts`). Keeps the create + edit
 * materialisers from drifting on error-shaping and the P2034 coercion contract.
 */

import { ConflictException, InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WorkoutDiff } from './workout-diff.types';

/** Brief §4.2 — diff payload must be <= 256KB serialised. */
export const MAX_DIFF_SERIALIZED_BYTES = 256 * 1024;

/**
 * A recoverable materialisation error. The approval service surfaces a thrown
 * materialiser error as a 500 (keeping the draft 'pending' for retry); using a
 * typed error with a stable `code` lets ops grep the cause without parsing free
 * text. Distinct from `ConflictException` (which the approval service treats as
 * a benign 409 race outcome — see ai-approval.service.ts).
 */
export class LiveCreateMaterialiseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LiveCreateMaterialiseError';
  }
}

/**
 * Enforce the 256KB serialised-size cap on a parsed diff. Throws a
 * RangeError-style message that the gateway maps to a 400 (the
 * `assert*Payload` helpers are called inside the gateway's try/catch). Kept
 * separate from the zod array bound because byte-size is a property of the
 * serialised JSON, not the parsed array.
 */
export function assertDiffSerializedSizeWithinLimit(diff: WorkoutDiff): void {
  const bytes = Buffer.byteLength(JSON.stringify(diff), 'utf8');
  if (bytes > MAX_DIFF_SERIALIZED_BYTES) {
    throw new RangeError(
      `diff exceeds ${MAX_DIFF_SERIALIZED_BYTES} bytes serialised (got ${bytes})`,
    );
  }
}

/**
 * Coerce a Prisma write-conflict / serialization failure (P2034) — or P2002 —
 * raised inside a Serializable transaction into a recoverable, typed error,
 * NEVER leaking a raw Prisma code (mirrors the MWB-2 pattern at
 * src/workout-builder/workout-builder.service.ts after the R3 fixer). A P2034
 * means a concurrent edit serialised against this write; the caller should
 * retry. Anything else (including our own typed errors) is rethrown unchanged.
 */
export function coercePrismaWriteConflict(
  err: unknown,
  capability: string,
): unknown {
  // Already-typed domain errors pass through untouched.
  if (
    err instanceof ConflictException ||
    err instanceof LiveCreateMaterialiseError ||
    err instanceof InternalServerErrorException
  ) {
    return err;
  }
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    (err.code === 'P2034' || err.code === 'P2002')
  ) {
    return new ConflictException({
      error: 'gateway_concurrent_edit_retry',
      capability,
      reason:
        'A concurrent write serialised against this operation. Retry the approval.',
    });
  }
  return err;
}
