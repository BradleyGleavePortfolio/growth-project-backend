# Public Invite Landing & Deep-Link Readiness

This document covers the public coach-invite landing page (`/join/:code`,
`/invite/:code`), the deep-link contract that mobile relies on, and the
end-to-end QR / link validation harness operators should run before
shipping a new universal-link config.

## Routes

| Method | Path | Auth | Response |
| --- | --- | --- | --- |
| GET | `/join/:code` | public | `text/html` landing |
| GET | `/invite/:code` | public | `text/html` landing (alias of `/join/:code`) |
| GET | `/api/invite/:code/preview` | public | `application/json` preview (existing route) |
| POST | `/api/auth/validate-invite-code` | public | `application/json` preview (existing route) |
| POST | `/api/auth/attach-invite-code` | JWT | atomic attach (existing route) |
| POST | `/api/auth/signup-with-code` | public | register + attach (existing route) |

The two HTML routes are mounted **outside** the `/api` global prefix (see
`src/main.ts` `setGlobalPrefix exclude`) so they match the universal-link
config the mobile app ships with.

## Status semantics

The HTML page returns:

- `200` with the coach card when the code resolves, the coach is in good
  standing, and (for legacy `InviteCode` rows) the row is not revoked /
  expired / over its `max_uses`.
- `404` with a generic "invite unavailable" page in **every** other case —
  not-found, revoked, expired, paused, canceled, or even an unparseable
  code. This is intentional. The HTML never confirms "this code existed
  once" to a stranger; that would let an enumeration attacker partition
  the 30-bit code space without an account.

The JSON preview routes preserve their existing shape: `{valid:true, …}`
on success, `{valid:false}` (without a `reason`) on failure.

## Deep-link contract

Mobile registers two link surfaces:

- Universal link: `https://app.tgp.com/join/<code>` — handled by iOS
  associated domains / Android App Links. When the app is installed it
  opens directly; when it isn't, the OS hands the URL to the browser, which
  lands on the HTML page above.
- Custom scheme: `tgp://join/<code>` — used inside the app and as the
  immediate-open path on the HTML page. Works only when the app is already
  installed.

The HTML page renders three CTAs:

1. **Open in The Growth Project** → universal link
   (`https://app.tgp.com/join/<code>`). On a device with the app
   installed, the OS intercepts before the browser ever loads. On a
   device without it, this falls through to the same HTML page (no
   redirect loop — the user then taps a store link).
2. **Already have the app?** → custom scheme `tgp://join/<code>`.
3. **Continue on web** → `PUBLIC_WEB_SIGNUP_URL` (defaults to the same
   universal-link base).

App store fallbacks live below the primary CTA and use
`APP_STORE_URL` / `PLAY_STORE_URL` (placeholders by default — set the
real listing URLs as Fly secrets before launch).

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_INVITE_BASE_URL` | `https://app.tgp.com/join` | universal-link base used to build CTA hrefs and to mint default invite-link URLs in `GET /coaches/me/invite-link` |
| `PUBLIC_WEB_SIGNUP_URL` | `${PUBLIC_INVITE_BASE_URL}/<code>` | "Continue on web" target |
| `APP_STORE_URL` | placeholder | iOS App Store listing URL |
| `PLAY_STORE_URL` | placeholder | Google Play listing URL |

These are read on every request — change them as Fly secrets without a
redeploy.

## Security notes

- **Throttling**: HTML routes are throttled at 60/min/IP, JSON preview at
  30/min/IP. The 30-bit code space (32 char alphabet × 6) makes online
  enumeration impractical at these rates.
- **Branding sanitization**: `branding_accent_color` is matched against
  `^#[0-9a-fA-F]{3,6}$` and dropped if it doesn't match — a coach cannot
  inject CSS via this field. `branding_logo_url` is filtered to
  `http://`, `https://`, `tgp:`, or relative-`/` only — no `javascript:`
  or `data:` URLs reach the rendered HTML.
- **No private data**: `coach_name` and `business_name` are the only
  identifying fields ever rendered. Email, phone, client roster, billing
  state, and Stripe identifiers stay server-side.
- **Cache-Control: no-store**: a coach can pause/cancel at any time, and
  we never want a CDN-cached page to point a brand-new client at a
  coach who is no longer accepting work.
- **`noindex,nofollow`**: the page is not for search engines.

## OWNER cannot redeem

Three places refuse OWNER → student demotion + coach attach:

1. `InviteCodesService.attachUserToCoachByCode` (`Forbidden`) — the
   canonical code path. Used by `POST /api/coach-codes/auth/attach-coach-code`,
   `POST /api/auth/attach-invite-code`, the `signup-with-code` post-step,
   and the `googleAuth` invite-code propagation.
2. `AuthService.selectRole` (`Forbidden`) — guards the legacy
   `POST /api/auth/select-role` path that does its own user.update.
3. `AuthService.signupWithCode` — creates new users with `role:'student'`
   only via `register()`, so OWNER is structurally impossible at signup.

## QR / deep-link validation harness

Run this list before flipping a universal-link or custom-scheme config in
production. It exercises the public surface without touching real coach
state.

### 1. Valid code

```
curl -i https://app.tgp.com/join/GP-A1B2C3
```

Expect: `200`, `Content-Type: text/html`, body contains the coach name and
business name. Body contains both `https://app.tgp.com/join/GP-A1B2C3`
(universal link) and `tgp://join/GP-A1B2C3` (custom scheme).

### 2. Unknown code

```
curl -i https://app.tgp.com/join/GP-NOPE99
```

Expect: `404`, body is the generic "invite unavailable" page. The body
**must not contain** the string `GP-NOPE99` — confirm this with `grep`.

### 3. Revoked / expired legacy `InviteCode`

Mark a known code revoked via the coach console (or `UPDATE InviteCode SET
revoked = true WHERE id = ...`). Re-fetch.

Expect: `404`, generic invalid page.

### 4. Paused / canceled coach

Set `CoachProfile.subscription_status = 'paused'` for a known coach.
Re-fetch their default code's landing page.

Expect: `404`, generic invalid page. Set back to `active` and verify the
page returns to `200`.

### 5. Existing-account attach

```
curl -i -X POST https://app.tgp.com/api/auth/attach-invite-code \
  -H "Authorization: Bearer <student-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"invite_code":"GP-A1B2C3"}'
```

Expect: `200`, body `{"role":"student","coach_id":"<coach-id>"}`. Issuing
the same call a second time is a no-op (the user is already attached).

### 6. OWNER redemption blocked

Same call as (5) but with an OWNER's JWT.

Expect: `403` Forbidden, message `Owners cannot redeem a coach invite`.

### 7. Universal-link installed-app handoff (manual)

On a device with the app installed, tap an `https://app.tgp.com/join/...`
link in Mail / iMessage / Slack. Expect: app opens to the in-app
post-OAuth coach-attach screen with the code pre-filled. Browser must
**not** load this page when the app is installed.

### 8. Custom-scheme installed-app handoff (manual)

On a device with the app installed, paste `tgp://join/GP-A1B2C3` into
Notes and tap. Expect: app opens, same as (7).

### 9. App-not-installed fallback (manual)

On a device without the app, tap an `https://app.tgp.com/join/...` link.
Expect: this HTML page renders. Tapping the App Store / Play Store CTA
opens the listing. Tapping "Already have the app?" attempts the
`tgp://...` URL and silently fails (no app to handle) — this is the
expected degraded path.

## Future extraction

The HTML lives in this backend so the deep-link readiness lane can ship
without standing up a separate web app. The long-term home is either:

- **Same repo as `tgp-coach-console`** — a small Next.js public landing
  alongside the authenticated coach console, sharing the design system.
- **A standalone `tgp-web` marketing repo** — useful if the landing
  grows beyond a single page (e.g. coach directory, public bio pages).

When extracted:

1. Move `src/invite-landing/*` to the new app and rewrite the renderer
   in JSX (the template here is intentionally framework-agnostic).
2. Switch the universal-link CDN target from this Fly app to the new
   web origin.
3. Delete `InviteLandingModule` and the `setGlobalPrefix` excludes for
   `join/:code` and `invite/:code`. The JSON preview route stays here.
4. Keep the `Cache-Control: no-store` and `noindex,nofollow` headers —
   the privacy and freshness reasons don't change.
