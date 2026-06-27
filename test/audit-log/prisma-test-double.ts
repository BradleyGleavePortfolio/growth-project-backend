/**
 * H6 — local Prisma test double for the audit-log specs.
 *
 * Copied locally (not imported across src/test paths) per the H6 builder
 * brief, modelled on src/regimes/__tests__/prisma-test-double.ts. The
 * AuditLogService reads only `prisma.$transaction` and, inside the tx
 * callback, `tx.auditLogEntry.create`, so the specs stub just those
 * delegates and widen the partial to the nominal PrismaService the
 * constructor requires.
 */

import type { PrismaService } from '../../src/prisma.service';

export type PartialPrisma = Partial<Record<keyof PrismaService, unknown>>;

/**
 * Widen a partial delegate-mock to the PrismaService constructor parameter.
 * The audit-log specs stub only the delegates the service under test reads,
 * so the widen is sound for the call paths under test.
 */
export function asPrismaDouble<T extends PartialPrisma>(mock: T): PrismaService {
  // @ts-expect-error partial structural mock of PrismaService — the specs stub
  // only the delegates AuditLogService reads (R0-sanctioned escape).
  return mock;
}
