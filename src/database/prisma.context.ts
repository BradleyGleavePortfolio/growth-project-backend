/**
 * Request-scoped Row-Level-Security (RLS) context.
 *
 * Wave 1.5 carries the authenticated tenant identity — the acting user and the
 * set of gyms they may touch — alongside each request so the RLS Prisma
 * middleware can stamp it onto every query via Postgres session variables
 * (`app.user_id`, `app.gym_ids`). The transport is an `AsyncLocalStorage` store
 * established at the request boundary.
 *
 * This module is a deliberate **stub for A1**: it pins the public contract
 * ({@link RlsContext} + {@link getRlsContext}) that {@link createRlsMiddleware}
 * depends on, but does not yet wire up `AsyncLocalStorage`. Until A2 implements
 * the real store, {@link getRlsContext} returns `null`, which the middleware
 * treats as "admin / migration mode" — no session variables are set and queries
 * run with the caller's ambient privileges.
 *
 * @see createRlsMiddleware — the sole consumer of this contract in A1.
 */

/**
 * The tenant identity attached to a single request.
 *
 * - `userId`  — the authenticated `User.id` driving per-user RLS predicates.
 * - `gymIds`  — every gym the request is authorized to read/write; may be empty
 *   for a user with no gym membership, in which case gym-scoped predicates deny.
 */
export interface RlsContext {
  readonly userId: string;
  readonly gymIds: readonly string[];
}

/**
 * Returns the RLS context for the current async execution, or `null` when no
 * context is bound (admin scripts, migrations, cron — anything outside a tenant
 * request).
 *
 * A1 stub: always returns `null`. A2 replaces this with an `AsyncLocalStorage`
 * lookup. Callers MUST treat `null` as "do not constrain" and never as "deny",
 * because privileged maintenance paths legitimately run without a context.
 */
export function getRlsContext(): RlsContext | null {
  return null;
}
