import { Prisma, type PrismaClient } from "@prisma/client";
import {
  RLS_GYM_IDS_KEY,
  RLS_USER_ID_KEY,
  type RlsContext,
} from "./prisma.context";

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
  // The *values* (userId, gymIds) are always bound parameters — no injection.
  const userKey = Prisma.raw(`'${RLS_USER_ID_KEY}'`);
  const gymKey = Prisma.raw(`'${RLS_GYM_IDS_KEY}'`);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config(${userKey}, ${ctx.userId}, true)`;
    await tx.$executeRaw`SELECT set_config(${gymKey}, ${gymIds}, true)`;
    return fn(tx);
  });
}
