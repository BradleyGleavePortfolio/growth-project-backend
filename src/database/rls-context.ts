import { Prisma, type PrismaClient } from "@prisma/client";
import { Logger } from "@nestjs/common";
import {
  RLS_GYM_IDS_KEY,
  RLS_LEGACY_USER_ID_KEY,
  RLS_LEGACY_USER_ROLE_KEY,
  RLS_USER_ID_KEY,
  type RlsContext,
} from "./prisma.context";

/**
 * Shadow-mode parity logger (W1.5-A3.1). The "verify" half of the
 * expand→verify→contract convergence: every request transaction stamps both the
 * legacy (`app.current_user_id`) and new (`app.user_id`) namespaces and then
 * asserts they resolved to the SAME acting user. A mismatch is deny-logged (no
 * throw on the prod path in this PR) so A3.2 only re-points policies once the
 * staging soak shows 100% agreement. Modeled on AWS IAM shadow evaluation.
 */
const parityLogger = new Logger("RlsParity");

/**
 * Runs `fn` inside an interactive Postgres transaction whose session has the
 * caller's RLS tenant identity stamped via `set_config(key, value, true)`.
 *
 * **Why a transaction (Supabase pgbouncer transaction-pool mode).** The
 * production `DATABASE_URL` points at the Supabase pgbouncer pooler
 * (port 6543, `?pgbouncer=true`), which is **transaction-pooled**: a backend
 * connection is only leased to a client for the duration of one transaction,
 * and a session-level `SET` would leak to (or be lost between) arbitrary
 * clients. The only safe way to scope a GUC to a single logical operation is
 * `set_config(..., is_local := true)` issued *inside* a transaction and read by
 * queries on that **same** transaction handle. That is exactly what this helper
 * provides: it opens `prisma.$transaction`, stamps both GUCs on the `tx`
 * handle, then hands `tx` to `fn`.
 *
 * @remarks
 * Concurrency: each call to `withRlsContext` opens its own interactive
 * transaction on its own backend connection. The `set_config` GUCs are
 * transaction-local (`is_local := true`), so concurrent calls cannot pollute
 * each other's tenant context — even under high-concurrency request handling.
 * The caller does not need to serialize access.
 *
 * **Caller contract.** `fn` MUST use the supplied `tx` handle for every
 * RLS-sensitive query. Issuing a query against the outer `prisma` client from
 * inside `fn` runs on a *different* connection with **no** GUCs set and will
 * therefore execute unscoped — bypassing the tenant identity entirely.
 *
 * **Fail-closed.** Both `set_config` calls are awaited before `fn` runs; if
 * either rejects, `fn` is never invoked and the transaction rolls back. If `fn`
 * itself throws, the transaction rolls back and the error propagates.
 *
 * **Empty-gyms DENY.** `gymIds` is serialized as `gymIds.join(",")`; an empty
 * list becomes `""`. The deny-by-policy contract for the empty-string GUC is
 * owned by A3 — see {@link RLS_GYM_IDS_KEY} in prisma.context.ts.
 *
 * @param prisma - the base Prisma client (admin/migration connection in A1;
 *   the `app_user` connection once A2 wires it).
 * @param ctx - the tenant identity to stamp for the duration of `fn`.
 * @param fn - the work to run; receives the transaction-bound `tx` handle.
 * @returns whatever `fn(tx)` resolves to.
 */
export async function withRlsContext<T>(
  prisma: PrismaClient,
  ctx: RlsContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const gymIds = ctx.gymIds.join(",");
  // The GUC *names* are internal constants (never user input), inlined as SQL
  // literals so policies/tests can match `set_config('app.user_id', $1, true)`.
  // The *values* (userId, gymIds, role) are always bound parameters — no injection.
  const userKey = Prisma.raw(`'${RLS_USER_ID_KEY}'`);
  const gymKey = Prisma.raw(`'${RLS_GYM_IDS_KEY}'`);
  const legacyUserKey = Prisma.raw(`'${RLS_LEGACY_USER_ID_KEY}'`);
  const legacyRoleKey = Prisma.raw(`'${RLS_LEGACY_USER_ROLE_KEY}'`);
  const role = ctx.role ?? "";
  return prisma.$transaction(async (tx) => {
    // New namespace (A2 spine) — what A3.2 will eventually point policies at.
    await tx.$executeRaw`SELECT set_config(${userKey}, ${ctx.userId}, true)`;
    await tx.$executeRaw`SELECT set_config(${gymKey}, ${gymIds}, true)`;
    // W1.5-A3.1 dual-context expand: stamp the LEGACY namespace on the SAME tx
    // handle with the SAME identity so both namespaces are identical for the
    // duration of this transaction. The legacy namespace remains authoritative
    // (live policies read app.current_user_id()); the new namespace shadows it.
    await tx.$executeRaw`SELECT set_config(${legacyUserKey}, ${ctx.userId}, true)`;
    await tx.$executeRaw`SELECT set_config(${legacyRoleKey}, ${role}, true)`;
    await assertParity(tx);
    return fn(tx);
  });
}

/**
 * Reads both GUC namespaces back off the SAME transaction handle and deny-logs
 * (shadow mode — never throws) when the legacy and new acting-user GUCs diverge.
 * Reading on `tx` is mandatory: under pgbouncer transaction-pool mode a read on
 * the base client would land on a different connection with no GUC set. No PII
 * is logged — only opaque user ids (which already appear in the legacy
 * interceptor's logs).
 */
async function assertParity(tx: Prisma.TransactionClient): Promise<void> {
  const rows = await tx.$queryRaw<
    { legacy_user_id: string | null; new_user_id: string | null }[]
  >`SELECT NULLIF(current_setting(${RLS_LEGACY_USER_ID_KEY}, true), '') AS legacy_user_id,
           NULLIF(current_setting(${RLS_USER_ID_KEY}, true), '') AS new_user_id`;
  const { legacy_user_id, new_user_id } = rows[0] ?? {
    legacy_user_id: null,
    new_user_id: null,
  };
  if (legacy_user_id !== new_user_id) {
    parityLogger.warn(
      `RLS_PARITY_MISMATCH legacy_user_id=${String(legacy_user_id)} ` +
        `new_user_id=${String(new_user_id)}`,
    );
  }
}
