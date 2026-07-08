// Decorator-wiring guards. These invariants are security-critical and easy to
// break by an innocent-looking refactor, so we pin them with metadata reflection
// rather than trusting review:
//   - the feature-flag gate lives in the global R-DARK-1 middleware
//     (featureFlagNotFoundMiddleware) BEFORE any guard runs; no per-controller
//     guard is needed and adding one back is a regression;
//   - init + status stay coach-gated (mobile-authenticated coach only);
//   - redeem stays @Public (extension bootstrap has no JWT) AND rate-limited
//     (the only brute-force brake over the 6-digit space).
import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { RequestMethod } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { CoachGuard } from '../../auth/coach.guard';
import { ExtensionPairController } from '../extension-pair.controller';
import {
  FEATURE_GATED_ROUTES,
} from '../../common/feature-flag/feature-flag-not-found.middleware';

// Nest stores @UseGuards targets under the '__guards__' metadata key, at the
// class for class-level guards and at the handler for method-level guards.
function guardsOn(target: object): unknown[] {
  const meta: unknown = Reflect.getMetadata('__guards__', target);
  return Array.isArray(meta) ? meta : [];
}

function guardName(g: unknown): string {
  if (typeof g === 'function' && typeof g.name === 'string') return g.name;
  if (g !== null && typeof g === 'object' && 'name' in g) {
    const n: unknown = Reflect.get(g, 'name');
    return typeof n === 'string' ? n : '';
  }
  return '';
}

// @nestjs/throttler stores per-bucket metadata under `THROTTLER:LIMIT<name>` /
// `THROTTLER:TTL<name>`; the DEFAULT bucket's suffix is "default" (see
// src/regimes/__tests__/regimes-throttle-metadata.spec.ts).
const THROTTLE_LIMIT_KEY = 'THROTTLER:LIMITdefault';
const THROTTLE_TTL_KEY = 'THROTTLER:TTLdefault';

describe('ExtensionPairController wiring', () => {
  it('feature-flag gate is enforced by the global R-DARK-1 middleware, not a per-controller guard', () => {
    // R-DARK-1: /api/extension/pair/* is enforced by the global middleware
    // BEFORE any Nest guard runs. Assert the route is in the registry and
    // that no per-controller feature-flag guard has been re-added.
    const gated = FEATURE_GATED_ROUTES.find((r) => r.pattern === '/api/extension/pair');
    expect(gated).toBeDefined();
    expect(gated?.envVar).toBe('FEATURE_EXTENSION_PAIRING');

    const classGuards = guardsOn(ExtensionPairController);
    for (const g of classGuards) {
      const name = guardName(g);
      expect(name).not.toMatch(/FeatureFlagGuard$/);
    }
  });

  it('main.ts registers featureFlagNotFoundMiddleware', () => {
    // A refactor that deletes app.use(featureFlagNotFoundMiddleware) would
    // silently drop the R-DARK-1 gate for this controller. Pin it here.
    const mainSrc = readFileSync(join(__dirname, '../../..', 'src/main.ts'), 'utf8');
    expect(mainSrc).toMatch(/app\.use\(\s*featureFlagNotFoundMiddleware\s*\)/);
  });

  it('keeps init coach-gated', () => {
    const handlerGuards = guardsOn(ExtensionPairController.prototype.init);
    expect(handlerGuards).toContain(CoachGuard);
  });

  it('keeps status coach-gated', () => {
    const handlerGuards = guardsOn(ExtensionPairController.prototype.status);
    expect(handlerGuards).toContain(CoachGuard);
  });

  it("declares @Roles('coach','owner') on init + status (global RolesGuard contract)", () => {
    // roles-enforced.spec walks the whole module and requires every non-@Public
    // route to carry @Roles. Pin the exact roles so a refactor that drops or
    // widens them (e.g. admitting students) is caught here, not in prod.
    for (const handler of [
      ExtensionPairController.prototype.init,
      ExtensionPairController.prototype.status,
    ]) {
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['coach', 'owner']);
    }
  });

  it('does NOT declare @Roles on the public redeem route', () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, ExtensionPairController.prototype.redeem),
    ).toBeUndefined();
  });

  it('mounts status as POST so the pairing code never rides in a query string', () => {
    // A GET status would force ?code=… into access logs, browser history and
    // proxies. Pin the method so a refactor back to @Get is caught here.
    const method = Reflect.getMetadata('method', ExtensionPairController.prototype.status);
    expect(method).toBe(RequestMethod.POST);
  });

  it('does NOT put a coach guard on redeem (extension bootstrap is unauthenticated)', () => {
    const handlerGuards = guardsOn(ExtensionPairController.prototype.redeem);
    expect(handlerGuards).not.toContain(CoachGuard);
  });

  it('marks redeem @Public so the global JwtAuthGuard skips it', () => {
    const isPublic = Reflect.getMetadata(IS_PUBLIC_KEY, ExtensionPairController.prototype.redeem);
    expect(isPublic).toBe(true);
  });

  it('does NOT mark init or status public', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, ExtensionPairController.prototype.init)).toBeFalsy();
    expect(
      Reflect.getMetadata(IS_PUBLIC_KEY, ExtensionPairController.prototype.status),
    ).toBeFalsy();
  });

  it('rate-limits redeem at the default 10/min per IP', () => {
    const limit = Reflect.getMetadata(THROTTLE_LIMIT_KEY, ExtensionPairController.prototype.redeem);
    const ttl = Reflect.getMetadata(THROTTLE_TTL_KEY, ExtensionPairController.prototype.redeem);
    expect(limit).toBe(10);
    expect(ttl).toBe(60_000);
  });

  it('does NOT rate-limit init or status (only the public redeem needs it)', () => {
    for (const handler of [
      ExtensionPairController.prototype.init,
      ExtensionPairController.prototype.status,
    ]) {
      expect(Reflect.getMetadata(THROTTLE_LIMIT_KEY, handler)).toBeUndefined();
    }
  });
});
