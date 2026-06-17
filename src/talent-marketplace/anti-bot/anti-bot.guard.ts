import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AntiBotProvider,
  AntiBotSignal,
  AntiBotSurface,
  ANTI_BOT_PROVIDER,
  ANTI_BOT_SURFACES,
} from './anti-bot.types';

/** Route metadata key carrying which {@link AntiBotSurface} a handler gates. */
export const ANTI_BOT_SURFACE_KEY = 'tm_anti_bot_surface';

/**
 * Decorator TM-5 puts on the apply / account-create handlers, e.g.
 *   @AntiBotGate(ANTI_BOT_SURFACES.Apply) @UseGuards(AntiBotGuard) @Post(...)
 * The guard reads this metadata to pick the per-surface limits; a handler
 * without it is passed straight through, so landing this now is a no-op.
 */
export const AntiBotGate = (surface: AntiBotSurface): MethodDecorator =>
  SetMetadata(ANTI_BOT_SURFACE_KEY, surface);

/**
 * AntiBotGuard — the GATE LAYER for the apply + account-create surface. Does
 * NOT touch Application/Applicant service bodies (TM-5 owns those): it sits in
 * front of the route, normalizes the request into a PII-light
 * {@link AntiBotSignal}, asks the pluggable provider, and maps the verdict to
 * HTTP — allow → pass; challenge → 428; deny → 429 (rate) / 403 (identity).
 * The body shape is uniform so a prober cannot tell which heuristic fired.
 */
@Injectable()
export class AntiBotGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ANTI_BOT_PROVIDER) private readonly provider: AntiBotProvider,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const surface = this.reflector.getAllAndOverride<AntiBotSurface | undefined>(
      ANTI_BOT_SURFACE_KEY,
      [context.getHandler(), context.getClass()],
    );
    // No surface declared → this guard is a no-op for that route.
    if (!surface) return true;

    const req = context.switchToHttp().getRequest<Record<string, unknown>>();
    const signal = this.buildSignal(req, surface);
    const verdict = await this.provider.evaluate(signal);

    if (verdict.decision === 'allow') return true;

    const retryAfter = Math.max(1, Math.ceil(verdict.retryAfterSeconds ?? 60));
    const res = context.switchToHttp().getResponse<{
      header?: (k: string, v: string) => void;
      setHeader?: (k: string, v: string) => void;
    }>();
    const setHeader = res.header ?? res.setHeader;
    setHeader?.call(res, 'Retry-After', String(retryAfter));

    if (verdict.decision === 'challenge') {
      // 428 — client must complete a challenge and retry.
      throw new HttpException(
        {
          statusCode: HttpStatus.PRECONDITION_REQUIRED,
          error: 'Precondition Required',
          message: 'Additional verification is required before continuing.',
          reason: verdict.reason,
          retryAfter,
        },
        HttpStatus.PRECONDITION_REQUIRED,
      );
    }

    // deny — identity heuristics map to 403, rate to 429.
    if (verdict.reason === 'duplicate_device' || verdict.reason === 'duplicate_identity') {
      throw new ForbiddenException({
        statusCode: HttpStatus.FORBIDDEN,
        error: 'Forbidden',
        message: 'This request was blocked. Please contact support if you believe this is an error.',
        reason: verdict.reason,
      });
    }
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        message: 'Too many attempts. Please wait before trying again.',
        reason: verdict.reason,
        retryAfter,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /**
   * Normalize the request into a PII-light signal. IP extraction follows the
   * Fly trusted-proxy chain used by UserThrottlerGuard: Fly-Client-IP → first
   * X-Forwarded-For hop → socket address.
   */
  private buildSignal(
    req: Record<string, unknown>,
    surface: AntiBotSurface,
  ): AntiBotSignal {
    const headers = (req.headers ?? {}) as Record<string, string | string[] | undefined>;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const user = req.user as { id?: string; email?: string } | undefined;

    const headerStr = (v: string | string[] | undefined): string =>
      (Array.isArray(v) ? v[0] : v ?? '').toString().trim();

    const ip =
      headerStr(headers['fly-client-ip']) ||
      headerStr(headers['x-forwarded-for']).split(',')[0]?.trim() ||
      ((req.ip as string) || (req.socket as { remoteAddress?: string })?.remoteAddress || '');

    // Identity hint preference: authed user id → asserted email → body email.
    const identityKey =
      user?.id ||
      user?.email ||
      (typeof body.email === 'string' ? body.email.trim().toLowerCase() : '') ||
      '';

    const deviceFingerprint =
      headerStr(headers['x-device-fingerprint']) ||
      (typeof body.device_fingerprint === 'string' ? body.device_fingerprint : '') ||
      undefined;

    return {
      surface: surface ?? ANTI_BOT_SURFACES.Apply,
      ip,
      userAgent: headerStr(headers['user-agent']),
      identityKey,
      deviceFingerprint,
      userId: user?.id,
    };
  }
}
