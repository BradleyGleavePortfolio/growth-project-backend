import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import {
  isFlagDark,
  matchedGatedRoutes,
  matchedGatedRoutesForController,
  resolvePilotCoachAllowlist,
  unionGatedRoutes,
} from './pilot-coach-allowlist';

/** The slice of the request this guard reads. `user` is attached by
 * JwtAuthGuard (the Prisma User); only `id` is consulted here. */
interface PilotGuardRequest {
  method: string;
  url: string;
  path?: unknown;
  user?: { id?: unknown } | null;
}

/**
 * S12-B1 PilotCoachAllowlistGuard — global APP_GUARD, registered in
 * app.module.ts directly AFTER JwtAuthGuard and BEFORE UserThrottlerGuard.
 *
 * Decision, in order:
 *  1. Route not on the gated surface (neither by `req.path` nor by the
 *     handler's `@Controller` path) ⇒ pass. Every non-importer route is
 *     untouched.
 *  2. Gated and any matched flag is not literally 'true' ⇒ uniform 404. This
 *     re-asserts the R-DARK-1 middleware's rule as defence in depth and runs
 *     BEFORE the @Public() exemption (dark means dark for `redeem` too).
 *  3. @Public() handler ⇒ pass. Only `POST extension/pair/redeem`: a pairing
 *     code exists only if the gated `init` minted it for an on-list coach.
 *  4. `req.user.id` is a string whose lower-cased form is on the allowlist ⇒
 *     pass; otherwise the same uniform 404. No owner-role bypass (Bradley's
 *     owner account must be listed too); empty/absent/malformed list ⇒ 404.
 *
 * The thrown NotFoundException carries exactly the message Nest's router
 * raises for an unmounted route (`Cannot <METHOD> <url>`), so
 * HttpExceptionFilter renders a body key-for-key identical to both the
 * middleware's flag-off 404 and a genuinely unmounted 404 (R-DARK-1: an
 * off-list caller cannot tell "not for you" from "does not exist").
 *
 * Ordering is load-bearing (pinned by test/common/pilot-coach-allowlist
 * .bootstrap.spec.ts): after JwtAuthGuard so the id is the verified caller;
 * before UserThrottlerGuard so the off-list 404 carries no X-RateLimit-*
 * headers (the flag-off and unmounted 404s carry none); before RolesGuard so
 * an off-list caller of any role sees 404, never 403.
 */
@Injectable()
export class PilotCoachAllowlistGuard implements CanActivate, OnModuleInit {
  private readonly logger = new Logger(PilotCoachAllowlistGuard.name);

  constructor(private readonly reflector: Reflector) {}

  /** One boot-time warning when the configured list is malformed. */
  onModuleInit(): void {
    resolvePilotCoachAllowlist((message) => this.logger.warn(message));
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<PilotGuardRequest>();
    const controllerPath = this.reflector.get<unknown>(PATH_METADATA, context.getClass());
    const routes = unionGatedRoutes(
      matchedGatedRoutes(req.path),
      matchedGatedRoutesForController(controllerPath),
    );
    if (routes.length === 0) return true;

    if (isFlagDark(routes)) throw uniformNotFound(req);

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const allowlist = resolvePilotCoachAllowlist((message) => this.logger.warn(message));
    const id = req.user?.id;
    if (typeof id === 'string' && allowlist.ids.has(id.toLowerCase())) return true;

    throw uniformNotFound(req);
  }
}

function uniformNotFound(req: PilotGuardRequest): NotFoundException {
  return new NotFoundException(`Cannot ${req.method} ${req.url}`);
}
