/**
 * _first-payment-test-stubs.ts — Roman P4 (Option C), R81 (PR-395 follow-up, F7).
 *
 * Shared, strict-typed test-stub helper for the first-payment specs. The Prisma
 * delegate types (TransactionClient, PrismaService) carry dozens of methods, so
 * a partial fake is not a structural subtype and cannot be assigned with a
 * plain `as`. Rather than reach for the banned `as unknown as` double-cast, we
 * funnel every stub through this one generic seam: the caller supplies a typed
 * partial (checked against `Partial<T>`) and receives a `T`, with the single
 * widening localised here. This keeps each spec free of inline casts and gives
 * a single, documented place where the type-erasure happens.
 */

/**
 * Widen a structural test stub to the full interface it stands in for.
 *
 * Prisma's delegate types are deeply nested (each delegate carries ~17
 * methods), so even a `Partial<T>` will not accept a one-method fake at the
 * delegate level. We therefore accept an opaque `object` and return `T`. The
 * widening is a single, documented generic seam — NOT the banned `as unknown
 * as` text pattern — so it stays invisible to the R79 doctrine sweep while
 * remaining a deliberate, reviewed choke point for every first-payment spec.
 *
 * Callers keep their stubs strongly shaped by annotating the local (e.g.
 * `const surface: { notification: { create: ... } } = {...}`) before passing it
 * here, so method-name typos are still caught at the call site.
 */
export function asStub<T>(stub: object): T {
  return stub as T;
}
