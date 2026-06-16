import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from "@nestjs/common";
import type { User } from "@prisma/client";
import { defer, Observable } from "rxjs";
import { runWithRlsContext, type RlsContext } from "./prisma.context";

/**
 * Once-per-process guard for the missing-`gym_ids`-claim warning. Module scope
 * so the warn fires on the first authenticated request after boot and then
 * stays silent, preventing a per-request log flood while B1b is unshipped.
 */
let warnedMissingGymIdsClaim = false;

/**
 * Minimal shape this interceptor reads off the request. After `JwtAuthGuard`
 * runs, `req.user` is the authenticated Prisma `User` record (see
 * `src/auth/auth-request.ts`), whose `id` drives per-user RLS predicates. Typed
 * as a partial `User` because public/unauthenticated requests carry no `user`.
 */
interface RlsAuthedRequest {
  user?: Pick<User, "id" | "role"> & { gym_ids?: readonly string[] };
}

/**
 * Establishes the request-scoped RLS {@link RlsContext} for the Wave 1.5 tenant
 * spine, binding it via {@link runWithRlsContext} around the entire downstream
 * handler so that any `PrismaService.withRls` call reached while handling the
 * request stamps the acting user's `app.user_id` / `app.gym_ids` GUCs.
 *
 * **Why an interceptor, not a middleware.** The Nest execution order is
 * middleware → guards → interceptors → handler. The acting identity is attached
 * to `req.user` by `JwtAuthGuard`, which runs as a guard — *after* any
 * middleware. A middleware therefore could never observe a populated `req.user`.
 * An interceptor runs after the guards, so `req.user` is available, and it can
 * wrap `next.handle()` in the `AsyncLocalStorage` scope established by
 * {@link runWithRlsContext}. This matches the repo's established global-RLS
 * pattern (`common/interceptors/rls-context.interceptor.ts`), which is the
 * legacy `app.current_user_id` path; this A2 interceptor is the new
 * `app.user_id` / `app.gym_ids` spine and supersedes it once A3 enables RLS.
 *
 * **Empty `gymIds` = DENY.** When the acting user is authorized for no gyms,
 * `gymIds` is the empty array. Per the {@link RlsContext} / `RLS_GYM_IDS_KEY`
 * contract this serializes to `''`, which A3 policies MUST treat as deny for
 * gym-scoped rows — the request fails closed rather than seeing every gym.
 *
 * **Unauthenticated requests run without a context.** Public endpoints have no
 * `req.user`; this interceptor does NOT open a {@link runWithRlsContext} scope
 * for them, leaving {@link getRlsContext} `null` downstream. Null context means
 * "no tenant scoping" (the privileged/public path), never "deny".
 */
@Injectable()
export class RlsContextInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RlsContextInterceptor.name);

  /**
   * Wraps the downstream handler in the request's RLS context when the request
   * is authenticated; otherwise lets it proceed unwrapped (public path).
   *
   * @param context - the Nest execution context; the HTTP request is read for
   *   the guard-populated `user`.
   * @param next - the downstream call handler whose `handle()` runs the rest of
   *   the pipeline (other interceptors → route handler).
   * @returns the handler's `Observable`, evaluated inside the bound RLS context
   *   for authenticated requests.
   */
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RlsAuthedRequest>();
    const user = request.user;

    // Public / unauthenticated request: no identity to bind. Proceed with a
    // null context (no scoping), matching the A1 semantic.
    if (user === undefined || user === null) {
      return next.handle();
    }

    const rlsContext: RlsContext = {
      userId: user.id,
      gymIds: this.resolveGymIds(user),
      // Carried so withRlsContext can also stamp the legacy app.current_user_role
      // GUC (W1.5-A3.1 dual-context expand). undefined when the request shape has
      // no role (e.g. lightweight test doubles).
      role: user.role,
    };

    // `defer` runs the factory at subscription time, and `runWithRlsContext`
    // binds the AsyncLocalStorage scope synchronously around `next.handle()`.
    // Because the downstream handler's work is driven by this subscription, it
    // executes inside the bound context. `defer` also normalizes the return to
    // a single `Observable` (vs. the helper's `T | Promise<T>` union).
    return defer(() => runWithRlsContext(rlsContext, () => next.handle()));
  }

  /**
   * Resolves the gyms the request is authorized for.
   *
   * A2 placeholder. If the JWT-derived user already carries a `gym_ids` claim,
   * it is used directly. Otherwise we fail closed with `[]` (deny-all per the
   * empty-`gymIds` contract) and warn once per process boot (first-hit only) so
   * production logs are not flooded while gym_ids claim is unpopulated, because
   * the `gymMembership` model does not exist yet.
   *
   * TODO(B1b — gymMembership model): replace this fallback with a real
   * membership lookup (`prisma.gymMembership.findMany({ where: { userId } })`)
   * once B1b ships the model. Until then, authenticated requests with no
   * `gym_ids` claim see no gym-scoped rows by design.
   *
   * @param user - the authenticated user, optionally carrying a `gym_ids` claim.
   * @returns the authorized gym ids, or `[]` (deny-all) when none are available.
   */
  private resolveGymIds(
    user: Pick<User, "id"> & { gym_ids?: readonly string[] },
  ): readonly string[] {
    if (user.gym_ids !== undefined && user.gym_ids.length > 0) {
      return user.gym_ids;
    }
    if (!warnedMissingGymIdsClaim) {
      warnedMissingGymIdsClaim = true;
      this.logger.warn(
        `A2 placeholder: user ${user.id} has no gym_ids claim; ` +
          `all authenticated requests will deny-all gym-scoped rows until B1b lands. ` +
          `This warning fires once per process boot.`,
      );
    }
    return [];
  }
}
