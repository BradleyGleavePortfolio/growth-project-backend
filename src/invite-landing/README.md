# invite-landing

Public, server-rendered HTML for `/join/:code` and `/invite/:code`.
Serves as the universal-link target the mobile app's deep-link config
points at: when the app is installed, the OS hands the URL to the app;
when it is not, the user lands here.

## Purpose

- Render a quiet-luxury success page with the coach's name, business,
  and brand accent for a valid code.
- Render a single, generic "invite unavailable" page for any
  not-found / revoked / expired / paused / canceled state — never
  confirm to a stranger that a specific code existed.
- Drive the App Store / Play Store / web-signup fallback so a user
  without the app installed has a path forward.
- Stay extraction-ready: when this template moves to a dedicated
  marketing app, the controller seam is the only edit.

## Key files

| File | What it owns |
|---|---|
| `invite-landing.controller.ts` | `GET /join/:code`, `GET /invite/:code` |
| `invite-landing.service.ts` | HTML rendering (`renderValid`, `renderInvalid`); HTML escape and color sanitization |
| `invite-landing.module.ts` | Imports `InviteCodesModule` so the controller can call `previewCode` |

## Routing

These routes are mounted **outside** the `/api` global prefix (see
`main.ts` `setGlobalPrefix(... { exclude: ['join/:code', 'invite/:code',
... ] })`). The mobile app's universal-link config uses
`https://app.tgp.com/join/...`, and the alternate `/invite/:code` path
exists so QR codes / printed invites can use either form without a
redirect.

The `/api/invite/:code/preview` JSON route remains under `/api` and is
served by `InviteCodesController` — the JSON contract is unchanged.

## Request flow

1. Controller validates the code length (3..32) before going to the
   database. The DTO layer does not run on path params, so this guard
   is local.
2. `InviteLandingService.preview` proxies to
   `InviteCodesService.previewCode`. The indirection exists so this
   service can grow a richer DTO (e.g. coach headshot URL) without
   changing every caller.
3. On `{ valid: true }`, `renderValid` produces an HTML document with:
   - Universal link (`https://app.tgp.com/join/<code>`) — primary CTA.
   - Custom-scheme deep link (`tgp://join/<code>`) — fallback for cold
     start when the app is installed.
   - Web-signup URL — for the no-app case (resolves to the
     `/signup/<code>` durable page in the public-pages module).
   - App Store / Play Store URLs from env.
4. On `{ valid: false }`, `renderInvalid` produces a 404 page with the
   same visual language but no coach data.

## Security

- HTML and attribute escaping are done in-module
  (`escapeHtml`, `escapeAttr`). Coach name and business name flow
  through `escapeHtml`; URLs flow through `escapeAttr` with a strict
  scheme allowlist (`http:`, `https:`, `tgp:`, or root-relative). A
  malformed `logo_url` becomes `#` rather than `javascript:` or
  `data:`.
- `branding_accent_color` is matched against `^#(?:[0-9a-fA-F]{3}|
  [0-9a-fA-F]{6})$`. Anything else falls back to the default
  ink-black. A coach cannot break out of the inline `style` attribute
  with a malformed accent.
- The error page deliberately collapses not-found / revoked / expired
  / paused / canceled into one shape and one 404. Confirming "this
  code existed once" to a stranger is a small but real privacy leak.
- `Cache-Control: no-store, max-age=0` on every response.
  CoachProfile state (paused, canceled, branding) can change at any
  moment and a stale cached page must not point a brand-new client at
  a paused coach.
- `<meta name="robots" content="noindex,nofollow">` on every page so
  the coach card is not indexed.

## Throttling

Both `/join/:code` and `/invite/:code` are throttled at 60/minute/IP.
The same limit governs anonymous CDN-bypass clients; the underlying
`previewCode` is also rate-limited at 30/min (see
[`../invite-codes/README.md`](../invite-codes/README.md)).

## Environment variables

| Var | Tier | Purpose |
|---|---|---|
| `PUBLIC_INVITE_BASE_URL` | prod | Universal-link base (defaults to `https://app.tgp.com/join`). Drives the primary CTA href. |
| `PUBLIC_WEB_SIGNUP_URL` | prod | Web-signup fallback the "Continue on web" link points at. |
| `APP_STORE_URL` | prod | iOS App Store URL. Until the listing is live, points at the durable status page. |
| `PLAY_STORE_URL` | prod | Google Play URL. Same fallback story. |

In development, every env above has a development default so the page
renders without further configuration.

## Failure modes

- Code shorter than 3 or longer than 32 characters → 404 invalid
  page. No DB read.
- `previewCode` returns `{valid: false}` → 404 invalid page.
- `branding_logo_url` not a `https:` URL → image is omitted; the rest
  of the page renders.
- `branding_accent_color` unparseable → falls back to the default
  ink-black; the page renders.

## Tests

| File | Covers |
|---|---|
| `test/invite-landing.spec.ts` | Routing, valid render, invalid 404, escaping, accent-color sanitization, no-store header |

## Operational notes

- The page is small (<3 KB gzipped) and renders inline CSS, so the
  origin can serve it without an edge cache.
- This template is the temporary in-backend landing for `/join/:code`
  and `/invite/:code`. Long-term it belongs in a dedicated marketing
  / web app. The extraction plan is in `docs/invite-landing.md`.
- For the rationale on why the universal-link target lives in the API
  service today (deep-link readiness lane), see
  `docs/invite-landing.md` and `docs/staging-execution-tracker.md`.
