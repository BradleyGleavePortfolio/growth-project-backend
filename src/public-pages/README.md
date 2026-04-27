# public-pages

Durable, server-rendered status pages used as the operator-facing
destinations for the prod-tier env vars `APP_STORE_URL`,
`PLAY_STORE_URL`, and `PUBLIC_WEB_SIGNUP_URL` until the real App Store
/ Play Store listings and the marketing signup page exist.

## Purpose

- Give the operator real URLs they can commit to Fly secrets without
  inventing Apple / Google identifiers that do not resolve.
- Carry the invite-code passthrough so a visitor who arrives via
  `?code=…` or `/signup/:code` continues to see the same code on the
  signup page.
- Match the aesthetic of the invite landing (warm neutrals, serif
  headline, generous whitespace) so that a user bouncing between
  `/join/:code`, `/download/*`, and `/signup` perceives a single
  product.

## Key files

| File | What it owns |
|---|---|
| `public-pages.controller.ts` | `GET /download/ios`, `GET /download/android`, `GET /signup`, `GET /signup/:code` |
| `public-pages.html.ts` | Page templates, code sanitizer, page text |
| `public-pages.module.ts` | Wires the controller (no service needed) |

## Routing

All routes are mounted **outside** the `/api` global prefix (see
`main.ts`). When DNS for `app.trygrowthproject.com` points at this Fly
app, the URLs resolve as bare paths under the public hostname:

- `https://app.trygrowthproject.com/download/ios`
- `https://app.trygrowthproject.com/download/android`
- `https://app.trygrowthproject.com/signup`
- `https://app.trygrowthproject.com/signup?code=GP-A1B2C3`
- `https://app.trygrowthproject.com/signup/GP-A1B2C3`

## Invite-code passthrough

A code may arrive on `/signup` as either:

- `?code=…` — the form mobile and email links use today
- `/signup/:code` — for printed / QR invites that prefer the path

Both flow through `sanitizeInviteCode`, which trims, length-bounds
(3..32), and checks against `^[A-Za-z0-9-]{3,32}$`. Anything outside
that shape is silently dropped — the page still renders, just without
the code section. This means a malformed link does not break the
flow, and an arbitrary querystring cannot reflect into the rendered
page or a `mailto:` subject.

## Caching

- `/signup/:code` and `/signup?code=…` send `Cache-Control: no-store,
  max-age=0`. The personalized variant must not land in a shared
  cache.
- Bare `/signup`, `/download/ios`, `/download/android`: `public,
  max-age=300`. Five minutes is short enough that operator-driven
  copy changes propagate quickly and long enough to absorb a viral
  invite link.

## Throttling

Every route: 60 / minute / IP. Cheap to render and intentionally
public.

## Security

- All user-supplied input (the invite code) flows through
  `sanitizeInviteCode` before reaching the renderer; only
  `[A-Za-z0-9-]{3,32}` is accepted.
- Page copy is honest about the App Store / Play Store status; the
  controller never publishes placeholder Apple / Google IDs that do
  not resolve. That was the failure mode this module was added to
  avoid.
- `<meta name="robots" content="noindex,nofollow">` on every page;
  these are operational status pages, not marketing.

## Environment variables

This module renders even when no env is set. The downstream
`invite-landing` module reads `APP_STORE_URL`, `PLAY_STORE_URL`, and
`PUBLIC_WEB_SIGNUP_URL` to populate its CTAs — once the real listings
exist, set those secrets to the real URLs and the invite-landing CTAs
swap over without a code change.

## Failure modes

- Malformed code on `/signup/:code` → page renders without the code
  section. No 404; the user can still proceed.
- Body / headers exhausted by middleware → unreachable in practice; the
  controller writes the response directly via `@Res()`.

## Tests

| File | Covers |
|---|---|
| `test/public-pages.spec.ts` | Render shape, code sanitizer, cache headers, route mounting under bare paths |

## Operational notes

- The `app.trygrowthproject.com` hostname is the operator-facing
  domain. Until DNS is cut over, these pages are reachable via the
  Fly default hostname for QA.
- When the real App Store / Play Store listings go live, the operator
  flips `APP_STORE_URL` / `PLAY_STORE_URL` on Fly secrets and the
  invite-landing module starts pointing at the real URLs without a
  redeploy. The status pages here are kept as the durable fallback.
- The HTML is rendered inline (no Nest view engine, no template files)
  on purpose: ship-and-ignore status pages should have zero
  dependencies on framework rendering machinery.
