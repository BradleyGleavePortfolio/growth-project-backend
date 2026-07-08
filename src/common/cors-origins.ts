import type { Request } from 'express';
import type { Logger } from '@nestjs/common';
import { isProdLike, parseStorefrontBaseUrl } from './env-validation';
import { BootstrapValidationError } from './errors/bootstrap-validation.error';

/**
 * CORS origin allow-list computation, extracted from main.ts (R-DARK-1
 * round-2) so bootstrap's enableCors() and featureFlagNotFoundMiddleware's
 * dark-route 404 share ONE origin math — no duplication.
 *
 * Sources (unchanged from the original main.ts inline block):
 *  - CORS_ORIGINS: comma-separated explicit allow-list (audit C6 replaced
 *    the old `origin: '*'`; wildcard is rejected outright because combined
 *    with `credentials: true` it produces a response browsers refuse).
 *  - STOREFRONT_BASE_URL (R43 / P2-1): the public storefront origin is
 *    auto-included so operators don't duplicate the hostname. Under
 *    prod-like NODE_ENV a malformed value is fatal; in dev it is skipped
 *    (and warned about only when a logger is supplied, so per-request
 *    recomputation stays silent).
 */
export function computeCorsAllowedOrigins(warnLogger?: Logger): string[] {
  const corsOriginsEnv = process.env.CORS_ORIGINS || '';
  const corsOrigins = corsOriginsEnv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (corsOrigins.includes('*')) {
    throw new BootstrapValidationError(
      'CORS_ORIGINS=* is not permitted — list explicit origins (e.g. https://console.example.com).',
      'BOOTSTRAP_CORS_WILDCARD',
    );
  }
  const storefrontBaseRaw = process.env.STOREFRONT_BASE_URL;
  if (typeof storefrontBaseRaw === 'string' && storefrontBaseRaw.trim().length > 0) {
    const parsed = parseStorefrontBaseUrl(storefrontBaseRaw);
    if (parsed.ok) {
      if (!corsOrigins.includes(parsed.origin)) {
        corsOrigins.push(parsed.origin);
      }
    } else if (isProdLike(process.env.NODE_ENV)) {
      throw new BootstrapValidationError(
        `STOREFRONT_BASE_URL is invalid: ${parsed.message}`,
        'BOOTSTRAP_STOREFRONT_BASE_URL_INVALID',
      );
    } else if (warnLogger) {
      warnLogger.warn(
        `STOREFRONT_BASE_URL is invalid (skipping CORS auto-include in dev): ${parsed.message}`,
      );
    }
  }
  return corsOrigins;
}

/**
 * Echo helper for responses emitted BEFORE the cors package runs (the
 * dark-route 404 gate). Returns the request's Origin when it is in the
 * allow-list, otherwise undefined. Env is re-read per request; bootstrap
 * already validated it, and a post-boot env mutation that would throw here
 * must degrade to "no CORS echo" rather than 500 a dark 404.
 */
export function computeCorsAllowedOrigin(req: Request): string | undefined {
  const originHeader = req.headers.origin;
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (!origin) return undefined;
  let allowed: string[];
  try {
    allowed = computeCorsAllowedOrigins();
  } catch {
    return undefined;
  }
  return allowed.includes(origin) ? origin : undefined;
}
