import { parseStorefrontBaseUrl } from '../common/env-validation';

// GC-2c — the one place every public storefront link is built (#GC-DOMAIN:
// app.trygrowthproject.com/p/<code>). Callers pass the configured
// STOREFRONT_BASE_URL. Production refuses to boot without it
// (prodHardenedFeatureVars in env-validation.ts), so this fallback only ever
// serves dev and test.
export const STOREFRONT_DEV_FALLBACK = 'https://app.trygrowthproject.com';

export function storefrontBaseUrl(configured: string | undefined): string {
  const parsed = parseStorefrontBaseUrl(configured);
  return parsed.ok ? parsed.canonical : STOREFRONT_DEV_FALLBACK;
}

/** The guest pay page: share links, landing-page Buy buttons, the resume redirect. */
export function payPageUrl(
  configured: string | undefined,
  token: string,
  query: { lp?: string; resume?: string; confirmed?: string } = {},
): string {
  const qs = new URLSearchParams(
    Object.entries(query).filter((e): e is [string, string] => !!e[1]),
  ).toString();
  return `${storefrontBaseUrl(configured)}/p/${encodeURIComponent(token)}${qs ? `?${qs}` : ''}`;
}

/** The recovery email link: GET /api/v1/packages/public/join/:token/checkout/resume/:jwt. */
export function resumeUrl(
  configured: string | undefined,
  token: string,
  jwt: string,
): string {
  return `${storefrontBaseUrl(configured)}/api/v1/packages/public/join/${encodeURIComponent(
    token,
  )}/checkout/resume/${encodeURIComponent(jwt)}`;
}
