import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma.service';
import { JwksVerifierService } from './jwks.service';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { ALLOW_DELETION_SCHEDULED_KEY } from '../common/decorators/allow-deletion-scheduled.decorator';
import { PtmService } from '../ptm/ptm.service';

/**
 * JwtAuthGuard — Supabase ES256 token validation via JWKS.
 *
 * Previous implementation called `supabase.auth.getUser(token)` on every
 * authenticated request, which round-tripped to Supabase Auth (~100–200ms)
 * for every API call. Under load that turned every endpoint into a fan-out
 * to a single shared dependency.
 *
 * Now: tokens are verified locally against Supabase's published JWK set
 * (see JwksVerifierService). Verification cost is microseconds, the JWKS
 * endpoint is hit at most a handful of times per process per hour, and
 * key rotation is handled automatically by `jose.createRemoteJWKSet`.
 *
 * Registered globally as APP_GUARD: every route is authenticated by
 * default; routes that must be reachable without a JWT opt out with
 * `@Public()`.
 *
 * ## app_open signal (Phase 1A)
 *
 * After a successful authentication the guard fires a fire-and-forget
 * `app_open` PTM signal at most once every 4 hours per user per process.
 * The dedup window is per-pod (in-memory Map) — on a multi-pod deploy
 * each pod may emit at most one signal per user per 4 hours, which is
 * acceptable: the heuristic engine only asks "did app_open happen in the
 * last 7 days?", so per-pod dedup retains full fidelity while keeping the
 * write volume reasonable.
 *
 * The Map is evicted lazily when it exceeds APP_OPEN_DEDUP_MAX_SIZE entries;
 * the oldest half of entries (by last-emit timestamp) is pruned on each
 * overflow. This bounds memory on a long-lived process with a large roster.
 *
 * Signal is only emitted for non-deleted, non-scheduled-for-deletion users
 * — the GDPR lifecycle gates already enforced above. Signal metadata is
 * PII-free: `{ source: 'jwt_validate' }`.
 */

/** In-memory dedup state. Lives at module scope so it is shared across all
 * guard invocations inside a single process (one entry per live user). */
const appOpenDedup = new Map<string, number>();

/** Window in which a second emit for the same user is suppressed (ms). */
const APP_OPEN_DEDUP_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours

/** When the map grows beyond this size, prune the oldest 50% of entries to
 * avoid unbounded memory growth on large rosters. */
const APP_OPEN_DEDUP_MAX_SIZE = 10_000;

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private prisma: PrismaService,
    private jwks: JwksVerifierService,
    private reflector: Reflector,
    private ptm: PtmService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();

    const authHeader: string = req.headers?.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('No authentication token provided');
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      throw new UnauthorizedException('No authentication token provided');
    }

    let payload;
    try {
      payload = await this.jwks.verify(token);
    } catch {
      // The verifier already logged the specific reason; we don't echo it
      // back to the client to avoid leaking auth-system internals.
      throw new UnauthorizedException('Invalid or expired token');
    }

    // Supabase access tokens carry the user's auth UUID in `sub`.
    const supabaseId = typeof payload.sub === 'string' ? payload.sub : null;
    if (!supabaseId) {
      throw new UnauthorizedException('Token missing subject claim');
    }

    const user = await this.prisma.user.findUnique({
      where: { supabase_id: supabaseId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // GDPR lifecycle gate. A scrubbed account (deleted_at set) is fully
    // off-limits — return 403 so the client can render a terminal state
    // rather than a confusing 401 retry loop. A scheduled-for-deletion
    // account (deletion_scheduled_at set) is also locked out from every
    // route except the explicitly-opted-in recovery endpoints, so a
    // logged-in client can still cancel the schedule but cannot keep
    // mutating data during the grace window.
    if (user.deleted_at) {
      throw new ForbiddenException('Account has been deleted');
    }
    if (user.deletion_scheduled_at) {
      const allowDuringDeletion = this.reflector.getAllAndOverride<boolean>(
        ALLOW_DELETION_SCHEDULED_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (!allowDuringDeletion) {
        throw new ForbiddenException(
          'Account is scheduled for deletion; cancel the deletion to regain access',
        );
      }
    }

    req.user = user;

    // Fire-and-forget app_open signal. Only runs after the GDPR gates so
    // deleted / scheduled-deletion users never generate a signal. Wrapped
    // in try/catch so any unexpected error is silently discarded — this
    // must never block or 5xx the upstream request.
    try {
      this.maybeEmitAppOpen(user.id);
    } catch {
      // Intentionally swallowed — signal emission is advisory.
    }

    return true;
  }

  /**
   * Emit an `app_open` signal for `userId` unless one was already emitted
   * within the last APP_OPEN_DEDUP_WINDOW_MS. Pruning happens when the map
   * overflows APP_OPEN_DEDUP_MAX_SIZE.
   *
   * Exposed as a non-private method so unit tests can inspect / reset the
   * dedup map via the exported `appOpenDedup` symbol without monkey-patching
   * the guard instance.
   */
  maybeEmitAppOpen(userId: string): void {
    const now = Date.now();
    const last = appOpenDedup.get(userId);
    if (last !== undefined && now - last < APP_OPEN_DEDUP_WINDOW_MS) {
      return; // Already emitted within the window — suppress.
    }

    // Overflow guard: prune oldest 50% before inserting.
    if (appOpenDedup.size >= APP_OPEN_DEDUP_MAX_SIZE) {
      const entries = Array.from(appOpenDedup.entries()).sort(
        ([, a], [, b]) => a - b,
      );
      const pruneCount = Math.floor(entries.length / 2);
      for (let i = 0; i < pruneCount; i++) {
        appOpenDedup.delete(entries[i][0]);
      }
    }

    appOpenDedup.set(userId, now);
    this.ptm.emit(userId, 'app_open', 1, { source: 'jwt_validate' });
  }
}

/** Exported for test isolation — tests can clear the map between cases
 * without reaching into the class instance. */
export { appOpenDedup, APP_OPEN_DEDUP_WINDOW_MS, APP_OPEN_DEDUP_MAX_SIZE };
