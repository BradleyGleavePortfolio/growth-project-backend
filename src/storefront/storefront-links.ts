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

/**
 * GC-2 — the pay page's Stripe return_url (card and wallet alike):
 * GET /p/:token/done. Stripe appends payment_intent,
 * payment_intent_client_secret and redirect_status; the landing page id rides
 * along so "Try again" keeps it.
 */
export function payDoneUrl(configured: string | undefined, token: string, lp: string | null = null): string {
  const qs = lp ? `?${new URLSearchParams({ lp }).toString()}` : '';
  return `${storefrontBaseUrl(configured)}/p/${encodeURIComponent(token)}/done${qs}`;
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
