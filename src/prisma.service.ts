import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { getRlsContext } from './database/prisma.context';
import { withRlsContext } from './database/rls-context';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    // Prisma v6 surfaces `$connect()` failures through the v8 unhandled-rejection
    // hook more aggressively than v5 did, which trips Jest's beforeAll boundary in
    // unit tests that boot the full AppModule without a real database (e.g.
    // test/openapi-spec.spec.ts). Unit tests never hit the real client — every
    // suite injects a mock via DI — so the production `$connect()` path is dead
    // weight in NODE_ENV=test. Skip it and let the real boot path in `npm start`
    // continue to fire-and-forget the connection on production/staging.
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    if (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('connection_limit=')) {
      this.logger.warn('DATABASE_URL has no connection_limit — Prisma will use its default. See docs/database-pool.md');
    }
    // Fire-and-forget — don't block app startup on DB connection
    this.$connect()
      .then(() => this.logger.log('Database connected successfully'))
      .catch((err) =>
        this.logger.error('Database connection failed on startup:', err.message),
      );
  }

  // OPS (audit M-4): graceful shutdown. enableShutdownHooks() in main.ts
  // forwards SIGTERM/SIGINT into the Nest lifecycle so this hook runs on
  // Fly redeploys and disconnects the pool cleanly. Without that call in
  // main.ts this method is dead code and Prisma will leak connections.
  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Runs `fn` with the current request's RLS tenant identity applied, hiding the
   * Wave 1.5 RLS wiring behind a one-liner for callers:
   *
   *   await this.prisma.withRls((tx) => tx.user.findMany({ ... }));
   *
   * Behaviour depends on whether a tenant context is bound (see
   * {@link getRlsContext}):
   *
   * - **Context bound (request path).** Delegates to {@link withRlsContext},
   *   which opens an interactive `$transaction`, stamps the `app.user_id` /
   *   `app.gym_ids` GUCs with `set_config(..., is_local := true)` on the `tx`
   *   handle, then runs `fn(tx)`. `fn` MUST issue every RLS-sensitive query on
   *   the supplied `tx` — querying the outer client instead runs on a different
   *   connection with no GUCs set and bypasses tenant scoping.
   *
   * - **No context (admin / migration / cron escape hatch).** Calls
   *   `fn(this)` directly — no transaction, no GUCs. This is the privileged path
   *   for maintenance code that legitimately runs outside a tenant request
   *   (scripts, schedulers, migrations). `this` is passed as a
   *   `Prisma.TransactionClient` so `fn` has one uniform signature across both
   *   paths; outside a transaction the client simply executes each query on its
   *   own. A null context is "no scoping", never "deny" — the deny decision is
   *   the empty-`gymIds` policy contract owned by A3.
   *
   * Role swap is deployment-time, not application-code-time. This method never
   * mutates the connection string or `SET ROLE`; running queries as the
   * `NOBYPASSRLS` `app_user` role is achieved purely by pointing `DATABASE_URL`
   * at a connection authenticated as `app_user` in the deployment environment.
   * Application code stays role-agnostic.
   *
   * @typeParam T - the return type of `fn`.
   * @param fn - the work to run; receives a `Prisma.TransactionClient` that is a
   *   GUC-stamped `tx` on the request path and `this` on the admin path.
   * @returns whatever `fn` resolves to.
   */
  async withRls<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const ctx = getRlsContext();
    if (ctx === null) {
      // `PrismaClient` is a structural superset of `Prisma.TransactionClient`
      // (the latter is `Omit<PrismaClient, ITXClientDenyList>`), so passing
      // `this` is assignment-compatible — no cast required. Outside a
      // transaction the client runs each query on its own connection, which is
      // exactly the admin/migration/cron escape-hatch semantics.
      return fn(this);
    }
    return withRlsContext(this, ctx, fn);
  }
}
