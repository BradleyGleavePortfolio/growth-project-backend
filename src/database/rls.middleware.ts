import { Prisma } from "@prisma/client";
import { getRlsContext, type RlsContext } from "./prisma.context";

/**
 * Configuration for {@link createRlsMiddleware}.
 */
export interface RlsMiddlewareOptions {
  /**
   * Master switch. When `false`, the extension is a transparent pass-through:
   * no context lookup, no `set_config`, just the underlying query. This lets
   * admin tooling, migrations, and cron build a client that deliberately runs
   * with full privileges. Defaults to `true`.
   */
  readonly enabled?: boolean;
}

/**
 * The minimal raw-SQL surface the middleware needs from a Prisma client. The
 * `query` callback receives the live client as `unknown`; we narrow to this
 * shape so the middleware can stamp session variables without depending on the
 * fully-generated client type (which varies by schema and is awkward to name
 * inside an extension).
 */
interface RawSqlClient {
  $executeRaw(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<number>;
}

function hasExecuteRaw(client: unknown): client is RawSqlClient {
  return (
    typeof client === "object" &&
    client !== null &&
    typeof (client as { $executeRaw?: unknown }).$executeRaw === "function"
  );
}

/**
 * Stamps the tenant identity onto the current database session so Postgres RLS
 * policies can read it. Uses `set_config(key, value, true)` — the `true`
 * (`is_local`) flag scopes the setting to the surrounding transaction, so it
 * cannot leak across pooled connections once a transaction completes.
 *
 * `gymIds` is serialized as a comma-separated list; A3's policies parse it with
 * `string_to_array(current_setting('app.gym_ids', true), ',')`.
 */
async function applyRlsContext(
  client: RawSqlClient,
  ctx: RlsContext,
): Promise<void> {
  const gymIds = ctx.gymIds.join(",");
  await client.$executeRaw`SELECT set_config('app.gym_ids', ${gymIds}, true)`;
  await client.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
}

/**
 * The arguments Prisma hands a `$allOperations` interceptor, narrowed to what
 * this middleware uses. `query` is the delegate to the real operation; `client`
 * is the live (extended) client, typed `unknown` because its concrete shape is
 * schema-dependent and we only need the raw-SQL surface.
 */
export interface RlsOperationParams {
  readonly args: unknown;
  readonly query: (args: unknown) => Promise<unknown>;
  readonly client: unknown;
}

/**
 * The `$allOperations` interceptor body, extracted so it can be unit-tested
 * without standing up a real Prisma engine. See {@link createRlsMiddleware} for
 * the full contract.
 */
export async function applyRlsToOperation(
  enabled: boolean,
  params: RlsOperationParams,
): Promise<unknown> {
  const { args, query, client } = params;
  if (!enabled) {
    return query(args);
  }

  const ctx = getRlsContext();
  if (ctx !== null && hasExecuteRaw(client)) {
    await applyRlsContext(client, ctx);
  }

  return query(args);
}

/**
 * Builds the `$allOperations` interceptor closure for a given `enabled` flag.
 *
 * Extracted from {@link createRlsMiddleware} so the `this`-bound body — which
 * resolves the live client via {@link Prisma.getExtensionContext} — is directly
 * unit-testable without standing up Prisma's full extension pipeline.
 */
export function rlsAllOperations(
  enabled: boolean,
): (
  this: unknown,
  params: { args: unknown; query: (args: unknown) => Promise<unknown> },
) => Promise<unknown> {
  return function (this: unknown, { args, query }) {
    // `client` is not passed in the operation args; it is resolved from the
    // extension `this`-context. `getExtensionContext` returns the live
    // (extended) client whose raw-SQL surface we use to stamp session vars.
    const client = Prisma.getExtensionContext(this);
    return applyRlsToOperation(enabled, { args, query, client });
  };
}

/**
 * Builds a Prisma client extension that enforces Row-Level-Security context on
 * every query.
 *
 * **Contract**
 * - For each operation, the extension reads {@link getRlsContext}.
 * - When a context is present, it issues two `set_config(..., true)` statements
 *   (`app.gym_ids`, `app.user_id`) *before* delegating to the real query, so any
 *   RLS policy evaluated by that query sees the caller's tenant identity.
 * - When the context is `null`, **no** session variables are set: the query runs
 *   with the connection's ambient privileges. This is the intentional
 *   admin/migration escape hatch — `null` means "unconstrained", never "deny".
 * - When `enabled` is `false`, the extension short-circuits entirely and is a
 *   pure pass-through.
 *
 * The extension never swallows the underlying result: it returns exactly what
 * the wrapped query returns.
 *
 * Apply with `prisma.$extends(createRlsMiddleware())`. Wiring into
 * `PrismaService` is A2's responsibility; in A1 this factory stands alone and is
 * a no-op at runtime because the A1 {@link getRlsContext} stub returns `null`.
 *
 * @param options - see {@link RlsMiddlewareOptions}; `enabled` defaults to `true`.
 */
export function createRlsMiddleware(options: RlsMiddlewareOptions = {}) {
  const enabled = options.enabled ?? true;

  return Prisma.defineExtension({
    name: "rls-tenant-context",
    query: {
      $allOperations: rlsAllOperations(enabled),
    },
  });
}
