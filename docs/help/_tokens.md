---
title: Help-content token registry
audience: operators
status: source-of-truth
---

# Help-content token registry

Every public-facing string in `docs/help/` and `docs/emails/onboarding/`
that depends on a deployment-specific value is written as a named
token, not a hard-coded value. The renderer (or a future static-site
build) substitutes tokens at publish time. This file is the single
source of truth for the token names, what they mean, and where the
value is sourced.

The list is deliberately small. Adding a new token is a deliberate
choice — prefer rewording the sentence to use an existing token before
introducing a new one.

## Tokens

| Token              | Meaning                                                                  | Source                                                              | Example value                          |
| ------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------- | -------------------------------------- |
| `SUPPORT_EMAIL`    | Address coaches and clients write to for human help.                     | Operator-managed mailbox; routed to the on-call support inbox.      | `support@thegrowthproject.app`         |
| `HELP_BASE_URL`    | Root URL where this help content is published.                           | Static site or marketing site, served from the same apex.           | `https://help.thegrowthproject.app`    |
| `STATUS_URL`       | Public status page surfaced when an outage is suspected.                 | Operator-managed status page (statuspage.io, BetterStack, etc).     | `https://status.thegrowthproject.app`  |
| `ESP_FROM_NAME`    | Display name on the From: header of every onboarding email.             | Configured in the email service provider (ESP) sender profile.      | `The Growth Project`                   |
| `APP_STORE_URL`    | iOS App Store listing for the client mobile app. Already in `.env`.      | `APP_STORE_URL` env var (see root `README.md`).                     | `https://apps.apple.com/app/id000000`  |
| `PLAY_STORE_URL`   | Google Play listing for the client mobile app. Already in `.env`.        | `PLAY_STORE_URL` env var (see root `README.md`).                    | `https://play.google.com/store/apps/details?id=...` |
| `COACH_CONSOLE_URL`| Web URL for the coach console (`tgp-coach-console`).                     | DNS for the coach-console deployment.                               | `https://console.thegrowthproject.app` |
| `INVITE_BASE_URL`  | Public base URL for invite landing pages. Already in `.env`.             | `PUBLIC_INVITE_BASE_URL` env var.                                   | `https://app.thegrowthproject.app/join`|

## Conventions

- Tokens are written in copy as `${TOKEN}` (dollar-brace), e.g.
  `${SUPPORT_EMAIL}`. The brace form is unambiguous when a token
  appears next to punctuation (`${SUPPORT_EMAIL}.`).
- Treat tokens as opaque — never write the value alongside the token
  ("e.g. `${SUPPORT_EMAIL}` (support@…)"). The renderer is the only
  place the value appears.
- If a sentence reads naturally without the token (because the next
  paragraph already named it), drop the token. Repetition reads as
  filler.
- A token's value can change. Do not invent fallback prose like "or
  email us directly at the address above" — that breaks if the token
  ever resolves to a phone number, a form, or anything else.

## Adding a token

1. Confirm the value is genuinely deployment-specific. Words that
   never change ("Sign in with Apple", "the app", "your coach") are
   not tokens.
2. Pick a name that names the *role*, not the *value*: `SUPPORT_EMAIL`
   not `SUPPORT_AT_GROWTH`. Roles survive a value change.
3. Add a row to the table above with the source.
4. Update the renderer's substitution map.
5. Search every file in `docs/help/` and `docs/emails/onboarding/`
   for the literal value to confirm there is no surviving hard-coded
   copy.
