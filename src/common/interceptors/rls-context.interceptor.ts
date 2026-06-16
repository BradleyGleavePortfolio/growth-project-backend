import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { PrismaService } from '../../prisma.service';

/**
 * RlsContextInterceptor (LEGACY, authoritative)
 *
 * Sets the PostgreSQL session variables consumed by every live RLS policy AFTER
 * the JwtAuthGuard has populated req.user. This is the AUTHORITATIVE RLS context
 * path: 32 migrations + every shipped policy read `app.current_user_id` /
 * `app.current_user_role` via the app.current_user_id() / app.current_user_role()
 * helpers. It stays in force until W1.5-A3.2 retires it (see the R82 tracking
 * issue) after the parity soak proves the new namespace is identical.
 *
 * Execution order: Middleware → Guards (JwtAuthGuard) → Interceptors → Handler
 *
 * W1.5-A3.1 dual-context expand. This interceptor now ALSO stamps the A2
 * namespace `app.user_id` with the SAME identity, so both GUC namespaces carry
 * identical truth on the legacy connection per request — the "expand" half of
 * the expand→verify→contract convergence. No live policy reads the new namespace
 * yet (that re-pointing is deferred to A3.2); the new helpers added in migration
 * 20261220000000_rls_helpers_v2 exist only so A3.2 can switch over. The parity
 * "verify" half lives in withRlsContext (database/rls-context.ts), which stamps
 * both namespaces on one tx handle and deny-logs any divergence in shadow mode.
 *
 * pgbouncer / transaction-pooling note:
 *   set_config(..., true) makes the setting TRANSACTION-SCOPED, so it persists
 *   only for the current transaction and is then discarded — the correct, safe
 *   behaviour under pgbouncer transaction-pool mode (session-level `false` would
 *   leak to the next request that borrows the same pooled connection). The fully
 *   correct primitive is withRlsContext(), which opens a $transaction and stamps
 *   the GUC on the tx handle; the A2 path uses it. This legacy interceptor
 *   preserves its established per-request set_config behaviour to remain a
 *   drop-in authoritative wall until A3.2.
 */
@Injectable()
export class RlsContextInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RlsContextInterceptor.name);

  constructor(private readonly prisma: PrismaService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const user = request.user; // available AFTER JwtAuthGuard runs

    // F-1 FIX (W1.5-A3.1): the JwtAuthGuard attaches the full Prisma User record
    // as req.user, whose identity field is `id`, not `sub` (ENGINEERING_RULES §11
    // "Always reference req.user.id, never req.user.sub"). The previous `user.sub`
    // read was undefined for this request shape, so the legacy GUC was stamped
    // with the WRONG claim. Read `user.id`.
    if (user?.id) {
      const userId = String(user.id);
      try {
        // Use transaction-scoped set_config (true) so the setting is discarded
        // after the transaction ends. This prevents connection-pool contamination
        // under pgbouncer transaction pooling mode.
        //
        // KNOWN HAZARD — F-A1 (P2), tracked for the A3.2 cutover (issue #419).
        // These set_config calls run on the BASE Prisma client with NO enclosing
        // $transaction, so under pgbouncer transaction-pool mode each statement is
        // its own implicit transaction and may be leased a DIFFERENT pooled
        // backend than the handler's subsequent ORM query. With is_local=true the
        // GUC is then discarded at that implicit commit, so the real query can
        // observe an UNSET context. This is the legacy interceptor's long-standing
        // behaviour and the live RLS wall presently depends on its current shape;
        // rewriting the tx model here is the A3.2 "retire legacy interceptor"
        // contract step (out-of-lane for A3.1). The pgbouncer-safe primitive is
        // withRlsContext() (src/database/rls-context.ts), which opens a
        // $transaction and stamps the GUC on the tx handle; A3.2 must migrate this
        // path onto it BEFORE any app_user role flip. Do not "fix" it piecemeal
        // here — see issue #419.
        await this.prisma.$executeRawUnsafe(
          `SELECT set_config('app.current_user_id', $1, true)`,
          userId,
        );
        await this.prisma.$executeRawUnsafe(
          `SELECT set_config('app.current_user_role', $1, true)`,
          user.role ?? '',
        );
        // Dual-context expand: stamp the A2 namespace with the same identity so
        // both namespaces are identical on this connection. NO live policy reads
        // it yet (A3.2 re-points policies onto app.current_user_id_v2()).
        await this.prisma.$executeRawUnsafe(
          `SELECT set_config('app.user_id', $1, true)`,
          userId,
        );
      } catch (error) {
        // Non-fatal — RLS will default to deny on missing config.
        // Log at warn level so it surfaces in monitoring without breaking requests.
        this.logger.warn(
          `Failed to set RLS context for user ${userId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return next.handle();
  }
}
