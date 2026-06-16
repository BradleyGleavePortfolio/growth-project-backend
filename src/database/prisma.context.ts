/**
 * Request-scoped Row-Level-Security (RLS) context — the shared contract module.
 *
 * Wave 1.5 carries the authenticated tenant identity — the acting user and the
 * set of gyms they may touch — alongside each request so RLS-scoped Prisma
 * queries can stamp it onto the database session via Postgres `set_config`
 * GUCs ({@link RLS_USER_ID_KEY}, {@link RLS_GYM_IDS_KEY}). The transport is an
 * `AsyncLocalStorage` store established at the request boundary (A2).
 *
 * This module is a deliberate **stub for A1**: it pins the public contract
 * ({@link RlsContext} + {@link getRlsContext} + the GUC-name constants) that
 * {@link withRlsContext} in `rls-context.ts` depends on, but does not yet wire
 * up `AsyncLocalStorage`. Until A2 implements the real store,
 * {@link getRlsContext} returns `null`.
 *
 * @see rls-context.ts — the A1 primitive (`withRlsContext`) built on this contract.
 */

/**
 * Postgres GUC (custom session-variable) name for the acting user's id. Read by
 * A3 policies via `current_setting('app.user_id', true)`. Defined here so the
 * helper, the policies, and the tests share a single source of truth.
 */
export const RLS_USER_ID_KEY = "app.user_id";

/**
 * Postgres GUC name for the comma-separated list of authorized gym ids. Read by
 * A3 policies via `current_setting('app.gym_ids', true)`.
 *
 * **Empty-array DENY contract.** When a request is authorized for no gyms, the
 * helper stamps this GUC as the empty string (`''`). A3 policies MUST treat an
 * empty-string value as **deny**, guarding every gym-scoped predicate with an
 * explicit non-empty check, e.g.:
 *
 *   current_setting('app.gym_ids', true) <> '' AND
 *   <table>.gym_id = ANY(string_to_array(current_setting('app.gym_ids', true), ','))
 *
 * This avoids the `string_to_array('', ',') = {''}` footgun, where an empty GUC
 * would otherwise produce a single empty-string array element and could match
 * rows whose gym id is itself empty/NULL-coerced.
 */
export const RLS_GYM_IDS_KEY = "app.gym_ids";

/**
 * The tenant identity attached to a single request.
 *
 * - `userId`  — the authenticated `User.id` driving per-user RLS predicates.
 * - `gymIds`  — every gym the request is authorized to read/write. MAY be empty:
 *   an empty list serializes to `''` and, per the {@link RLS_GYM_IDS_KEY}
 *   contract, A3 policies MUST treat that as deny for gym-scoped rows.
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
 * A1 stub: always returns `null`.
 *
 * TODO(A2 — wave-1-5/a2-rls-request-middleware): replace this stub with an
 * `AsyncLocalStorage<RlsContext>` lookup populated by the request middleware,
 * which will call {@link withRlsContext} (see src/database/rls-context.ts) to
 * run RLS-scoped work on a transaction-bound `tx` handle. Callers MUST treat
 * `null` as "no tenant context" (privileged maintenance paths legitimately run
 * without one), never as "deny".
 */
export function getRlsContext(): RlsContext | null {
  return null;
}
