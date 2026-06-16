/**
 * Typed Prisma test double for the F2 regime specs.
 *
 * The regime services touch only a handful of Prisma delegates. Each spec
 * supplies just the delegate mocks it needs; `asPrismaDouble` widens the
 * partial to the full PrismaService the service constructors require.
 *
 * The single structural widen lives HERE (one place, well-documented) instead
 * of being sprinkled across every spec: the runtime object only ever exposes
 * the mocked delegates, and the services only ever read those delegates, so
 * the widen is sound for the call paths under test.
 */

import type { PrismaService } from '../../prisma.service';

export type PartialPrisma = Partial<
  Record<keyof PrismaService, unknown>
>;

/**
 * Widen a partial delegate-mock to the PrismaService constructor parameter.
 * Implemented with a generic so callers keep full autocomplete on the mock
 * literal they pass in, while the service under test receives the nominal type.
 */
export function asPrismaDouble<T extends PartialPrisma>(
  mock: T,
): PrismaService {
  return mock as unknown as PrismaService;
}
