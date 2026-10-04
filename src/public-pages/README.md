# public-pages

Durable, server-rendered status and trust pages mounted under the
public host `app.trygrowthproject.com`. Two clusters live here:

- **Status pages** — `/download/ios`, `/download/android`, `/signup`,
  `/signup/:code`. Used as the destinations for the prod-tier env
  vars `APP_STORE_URL`, `PLAY_STORE_URL`, and
  `PUBLIC_WEB_SIGNUP_URL` until the real App Store / Play Store
  listings and the marketing signup page exist.
- **Trust pages** — `/privacy`, `/consumer-health-privacy`, `/terms`,
  `/security`, `/status`.
  Real public pages used as the privacy policy, terms of service,
  security posture, and operational status URLs filed with the App
  Store / Play Store, the Stripe Customer Portal, and shared with
  early customers. See `trust-pages.html.ts` for editorial guard
  rails.
- **Account deletion page** — `/help/delete-account` (rendered by
  `help-pages.html.ts`, public, no login). The web URL filed in Google
  Play's data-deletion section: app and developer name, the in-app path
  (mobile #313), the email route for people without the app, what is
  deleted and kept, and the timings. Linked from the Privacy Policy, the
  `/help` nav and overview, and the shared policy footer. Ships with
  backend #608 / mobile #313; pinned by `test/help-delete-account.spec.ts`.

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

| File                         | What it owns                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `public-pages.controller.ts` | `GET /download/ios`, `GET /download/android`, `GET /signup`, `GET /signup/:code`, `GET /privacy`, `GET /consumer-health-privacy`, `GET /terms`, `GET /security`, `GET /status` |
| `public-pages.html.ts`       | Status-page templates (download / signup), invite-code sanitizer                                                                                                               |
| `trust-pages.html.ts`        | Trust-page templates (privacy / consumer health / terms / security / status), support email, policy paths, shared footer links, `safeHref`                                     |
| `public-pages.module.ts`     | Wires the controller (no service needed)                                                                                                                                       |

## Routing

All routes are mounted **outside** the `/api` global prefix (see
`main.ts`). When DNS for `app.trygrowthproject.com` points at this Fly
app, the URLs resolve as bare paths under the public hostname:

- `https://app.trygrowthproject.com/download/ios`
- `https://app.trygrowthproject.com/download/android`
- `https://app.trygrowthproject.com/signup`
- `https://app.trygrowthproject.com/signup?code=GP-A1B2C3`
- `https://app.trygrowthproject.com/signup/GP-A1B2C3`
- `https://app.trygrowthproject.com/privacy`
- `https://app.trygrowthproject.com/consumer-health-privacy`
- `https://app.trygrowthproject.com/terms`
- `https://app.trygrowthproject.com/security`
- `https://app.trygrowthproject.com/status`

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

## Trust pages

`/privacy`, `/consumer-health-privacy`, `/terms`, `/security`,
`/status` are real public pages used as the privacy policy, consumer
health data privacy policy, terms of service, security posture, and
operational status URLs filed with the App Store, the Play Store, and
the Stripe Customer Portal. They live in `trust-pages.html.ts`.

### Vendor deletion and backup procedures

The deletion and backup promises on `/privacy`, `/consumer-health-privacy`
and `/help/delete-account` are backed by
[`docs/privacy/vendor-deletion-and-backups.md`](../../docs/privacy/vendor-deletion-and-backups.md):
per vendor what is deleted, how, by whom and when, how backups age out,
and the owner checklist of unverified items. Changing a deletion or
retention sentence means updating that document in the same PR.

The pages promise no restore procedure, and none exists. Any database
restore must re-apply erasures, Roman chat deletes, AI-consent withdrawals
and scheduled deletions before the app reads the data; that procedure is
separate T4 work (backend issue #662). Do not add restore wording to the
public pages until it is built and audited.

### Policy accuracy rules (2026-09-30 rewrite)

- `/privacy` and `/consumer-health-privacy` describe only behaviour the
  app and backend ship. Features behind a default-off flag are written
  as "if enabled". Every vendor named is one the code calls (Supabase,
  Fly.io, Stripe, Anthropic, Perplexity, PostHog, Sentry, Crisp, Resend,
  Mux, Expo push, Apple / Google sign-in, Apple Health / Health Connect,
  USDA FoodData Central, Open Food Facts). Adding a vendor that receives
  personal data means updating both pages.
- `/consumer-health-privacy` follows RCW 19.373.020 (categories,
  purposes, sources, shared categories, recipients, affiliates, how to
  exercise rights) and RCW 19.373.040 (confirm/access, recipient list,
  withdraw consent, delete incl. processors and backups within six
  months, 45-day response with one 45-day extension, free twice a year,
  appeal within 45 days, Attorney General complaint link).
- The consumer health policy must stay one click from every public
  page: it is in the trust-page header nav, and `policyFooterLinks()`
  puts it in the footer of every trust, help, signup and download page.
  The mobile Trust Center links to the same path.
- Roman copy must match the owner rulings and the D2 two-box consent
  (owner-approved 2026-10-01 09:07 PDT): box 1 (required) is the
  personal-training waiver plus collection and use for coaching
  (`consult-consent-v3`, backend #607 / mobile #310); box 2 (optional, unticked) is Roman and coach
  AI drafts processed by Anthropic (AI consent ledger, `client-ai-v4`, backend #635),
  withdrawn in Settings > Privacy > Roman and AI; stopping all
  collection is Settings > Account > Delete account. Also: private from
  coaches, staff access only for support / safety / debugging, kept
  until the client deletes them or the account (owner OR-110-1: no
  time-based purge), client delete. The consumer health "Consent" section is
  the approved text byte for byte (pinned in `test/trust-pages.spec.ts`).
- The clinic partner is never named. Copy says "clinic partner".
- What a deletion keeps is written once in `trust-pages.html.ts`
  (`CLOSED_ACCOUNT_RECORD_TEXT`, `ONE_WAY_CODE_TEXT`,
  `ANTHROPIC_RETENTION_TEXT`, `DEIDENTIFIED_TEXT`) and used by both
  `/privacy` and the `/help/delete-account` "What we keep" list, so the
  two list the same kept items (`test/privacy-round8-retention.spec.ts`).
- Crash and performance reports carry the account id only (mobile
  `setSentryUser` and `scrubEvent`; backend `beforeSend` sends no user).
  The policy says no name or email address is attached; keep it that way
  (`test/privacy-diagnostics-disclosure.spec.ts`).
- Sign in with Apple: the policy makes no revocation claim while
  production lacks the Apple key secrets (operator ruling 2026-10-03). A
  follow-up restores the revocation sentence once the owner sets them
  (`docs/privacy/vendor-deletion-and-backups.md` §0).
- Section links go through `safeHref()`: site-relative paths, `mailto:`
  and `https:` only; anything else renders as `#`.

Editorial guard rails (see `test/trust-pages.spec.ts`):

- The official support contact (`Bradleyapple1031@gmail.com`,
  exported as `SUPPORT_EMAIL`) appears on every page so a reviewer or
  customer always has a real human to email.
- The Security page describes practical controls and explicitly states
  we do **not** currently hold SOC 2 / ISO 27001 / HIPAA
  certifications. Making a fake certification claim is the failure
  mode this module is designed to prevent.
- No AI fingerprints. Copy is human-written, concrete, and free of
  boilerplate hedging.
- The Status page lists today's real public endpoints and points at
  the support email for incidents. When a third-party monitoring feed
  is wired in, it can be embedded under the same URL without changing
  the contract.
- Every page carries a `Last reviewed` date (`POLICY_LAST_REVIEWED` in
  `trust-pages.html.ts`) so reviewers and customers see freshness.
  Bump it when copy changes.

The pages are written as a company-drafted statement of practice and
each ends with a footnote recommending formal legal review before any
public launch outside an invite-only beta.

## Tests

| File                        | Covers                                                                                                                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/public-pages.spec.ts` | Render shape, code sanitizer, cache headers, route mounting under bare paths                                                                                                                                                                                               |
| `test/trust-pages.spec.ts`  | Privacy / consumer health / terms / security / status render shape, key copy, RCW 19.373 disclosures and rights, vendor list, Roman disclosures, 16+, footer links on help/signup/download pages, HTML escaping and `safeHref`, no fake certifications, no AI fingerprints |

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
