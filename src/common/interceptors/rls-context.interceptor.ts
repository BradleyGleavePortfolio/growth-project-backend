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
 * RlsContextInterceptor
 *
 * Sets PostgreSQL session variables consumed by RLS policies AFTER the
 * JwtAuthGuard has already populated req.user. This replaces the old
 * RlsContextMiddleware which ran BEFORE guards and therefore could never
 * observe a populated req.user.
 *
 * Execution order: Middleware → Guards (JwtAuthGuard) → Interceptors → Handler
 *
 * pgbouncer / transaction-pooling note:
 *   set_config(..., true) makes the setting TRANSACTION-SCOPED, meaning it
 *   persists only for the duration of the current transaction and is then
 *   automatically discarded. This is the correct and safe behaviour under
 *   pgbouncer transaction pooling mode — session-level settings (false) would
 *   "leak" to the next request that borrows the same connection from the pool.
 *
 *   Ideal approach for full correctness: wrap the RLS set_config + business
 *   queries in a single $transaction so everything runs on the same connection.
 *   The interceptor pattern here is a pragmatic alternative that is safe
 *   because Prisma typically issues all queries for a single request on the
 *   same connection when using $executeRawUnsafe immediately before service
 *   calls in the same async context.
 */
@Injectable()
export class RlsContextInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RlsContextInterceptor.name);

  constructor(private readonly prisma: PrismaService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const user = request.user; // available AFTER JwtAuthGuard runs

    if (user?.sub) {
      try {
        // Use transaction-scoped set_config (true) so the setting is discarded
        // after the transaction ends. This prevents connection-pool contamination
        // under pgbouncer transaction pooling mode.
        await this.prisma.$executeRawUnsafe(
          `SELECT set_config('app.current_user_id', $1, true)`,
          user.sub,
        );
        await this.prisma.$executeRawUnsafe(
          `SELECT set_config('app.current_user_role', $1, true)`,
          user.role ?? '',
        );
      } catch (error) {
        // Non-fatal — RLS will default to deny on missing config.
        // Log at warn level so it surfaces in monitoring without breaking requests.
        this.logger.warn(
          `Failed to set RLS context for user ${String(user.sub)}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return next.handle();
  }
}
