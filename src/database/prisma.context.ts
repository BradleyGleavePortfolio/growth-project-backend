/**
 * Request-scoped Row-Level-Security (RLS) context — the shared contract module.
 *
 * Wave 1.5 carries the authenticated tenant identity — the acting user and the
 * set of gyms they may touch — alongside each request so RLS-scoped Prisma
 * queries can stamp it onto the database session via Postgres `set_config`
 * GUCs ({@link RLS_USER_ID_KEY}, {@link RLS_GYM_IDS_KEY}). The transport is the
 * module-level {@link AsyncLocalStorage} store established at the request
 * boundary by A2's request interceptor (see rls-context.middleware.ts), which
 * calls {@link runWithRlsContext} to bind the context for the duration of the
 * request and {@link getRlsContext} to read it back deeper in the stack.
 *
 * A2 implements the real store: {@link runWithRlsContext} runs work inside an
 * `als.run(ctx, fn)` scope and {@link getRlsContext} returns the bound store
 * (or `null` outside any scope). The GUC-name constants and {@link RlsContext}
 * shape remain the shared contract that {@link withRlsContext} in
 * `rls-context.ts` depends on.
 *
 * @see rls-context.ts — the A1 primitive (`withRlsContext`) built on this contract.
 * @see ../prisma.service.ts — `PrismaService.withRls`, the caller-facing helper
 *   that reads {@link getRlsContext} and delegates to `withRlsContext`.
 */
import { AsyncLocalStorage } from "node:async_hooks";

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
 * Postgres GUC name for the acting user's id under the LEGACY namespace, read by
 * every shipped policy via `app.current_user_id()`. W1.5-A3.1 stamps this with
 * the SAME value as {@link RLS_USER_ID_KEY} from the request path so both
 * namespaces converge (expand step); the legacy namespace stays authoritative
 * until A3.2 re-points policies onto the new helpers.
 */
export const RLS_LEGACY_USER_ID_KEY = "app.current_user_id";

/**
 * Postgres GUC name for the acting user's role under the LEGACY namespace, read
 * by `app.current_user_role()` / `app.is_owner()`. Carried on the request path
 * so a `withRlsContext` transaction reproduces the full legacy context.
 */
export const RLS_LEGACY_USER_ROLE_KEY = "app.current_user_role";

/**
 * The tenant identity attached to a single request.
 *
 * - `userId`  — the authenticated `User.id` driving per-user RLS predicates.
 * - `gymIds`  — every gym the request is authorized to read/write. MAY be empty:
 *   an empty list serializes to `''` and, per the {@link RLS_GYM_IDS_KEY}
 *   contract, A3 policies MUST treat that as deny for gym-scoped rows.
 * - `role`    — the acting user's role, carried so the request transaction can
 *   also stamp the legacy `app.current_user_role` GUC (W1.5-A3.1 dual-context
 *   expand). Optional: omitted for callers that have no role to assert.
 */
export interface RlsContext {
  readonly userId: string;
  readonly gymIds: readonly string[];
  readonly role?: string;
}

/**
 * The single process-wide store carrying the per-request {@link RlsContext}
 * across async boundaries. `AsyncLocalStorage` propagates the bound value
 * through `await`, `setTimeout`, promise chains, and `Promise.all` fan-out
 * without threading it through every function signature, and keeps concurrent
 * requests isolated: each {@link runWithRlsContext} scope sees only its own
 * context. Module-level so every importer shares one store.
 */
const als = new AsyncLocalStorage<RlsContext>();

/**
 * Binds `ctx` as the RLS context for the synchronous-and-async extent of `fn`,
 * then runs `fn`. Any {@link getRlsContext} call reached (directly or through
 * awaited continuations) while `fn` is executing observes `ctx`; calls outside
 * this scope are unaffected.
 *
 * Established once per request by A2's interceptor around `next.handle()` so the
 * whole handler — services, repositories, `PrismaService.withRls` — runs with
 * the tenant identity bound. Nesting is supported: an inner
 * `runWithRlsContext` shadows the outer context for its own extent only, and
 * the outer context is restored when the inner scope unwinds.
 *
 * @typeParam T - the return type of `fn`.
 * @param ctx - the tenant identity to bind for the duration of `fn`.
 * @param fn - the work to run inside the bound context; its return value (sync
 *   or a promise) is passed through unchanged.
 * @returns whatever `fn` returns.
 */
export function runWithRlsContext<T>(
  ctx: RlsContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return als.run(ctx, fn);
}

/**
 * Returns the RLS context bound for the current async execution, or `null` when
 * no context is bound (admin scripts, migrations, cron, and public/unauthenticated
 * requests — anything outside a {@link runWithRlsContext} scope).
 *
 * Callers MUST treat `null` as "no tenant context" (privileged maintenance
 * paths and public endpoints legitimately run without one), never as "deny".
 * The deny decision is the empty-`gymIds` contract enforced by A3 policies (see
 * {@link RLS_GYM_IDS_KEY}), not the absence of a context.
 */
export function getRlsContext(): RlsContext | null {
  return als.getStore() ?? null;
}
