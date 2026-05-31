import { RequestMethod } from '@nestjs/common';
import type { RouteInfo } from '@nestjs/common/interfaces';

/**
 * B3 (PR-18) — single source of truth for the landing-pages public routes
 * that must be EXCLUDED from the global `/api` prefix.
 *
 * Both `src/main.ts` (the production `setGlobalPrefix('api', { exclude })`)
 * and the route-registration spec import THIS list, so the test can never
 * drift from production config. The prior P0 was exactly a global-prefix
 * mismatch (the bare custom-domain routes were accidentally mounted under
 * `/api`); pinning the exclude list here means a future edit that drops an
 * exclusion changes the behavior the test boots against, not a hand-copied
 * mirror, so the test fails closed.
 *
 * Two route shapes are covered:
 *  - the canonical `/p/:coachSlug/:pageSlug[...]` slug routes (R46), and
 *  - the four bare custom-domain apex routes (B3): `GET /`, `GET /checkout`,
 *    `POST /leads`, `POST /view`. These are method-scoped `RouteInfo`
 *    entries so they only strip the prefix for the exact verb the
 *    LandingPagePublicController declares at the controller root, never for
 *    any other controller's routes.
 */
export const LANDING_PUBLIC_PREFIX_EXCLUDE: ReadonlyArray<string | RouteInfo> = [
  // R46 — canonical public coach landing pages, served at the apex.
  'p/:coachSlug/:pageSlug',
  'p/:coachSlug/:pageSlug/checkout',
  'p/:coachSlug/:pageSlug/leads',
  'p/:coachSlug/:pageSlug/view',
  // B3 (PR-18) — verified custom-domain apex routes. Method-scoped so they
  // resolve at the bare host root (`/`, `/checkout`, `/leads`, `/view`) and
  // shadow no `/api/...` route.
  { path: '', method: RequestMethod.GET },
  { path: 'checkout', method: RequestMethod.GET },
  { path: 'leads', method: RequestMethod.POST },
  { path: 'view', method: RequestMethod.POST },
];
