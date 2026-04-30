---
title: Support config
audience: operators
slug: support-config
order: 90
---

# Support config

How the support content in this folder is configured, routed, and
kept current. This page is operator-facing — it is not part of the
public help site.

## Tokens

All deployment-specific values are tokens, defined in
[`_tokens.md`](./_tokens.md). The renderer (or static-site build)
substitutes tokens at publish time. Do not hard-code values into
the prose.

The complete set today:

- `SUPPORT_EMAIL`
- `HELP_BASE_URL`
- `STATUS_URL`
- `ESP_FROM_NAME`
- `APP_STORE_URL`
- `PLAY_STORE_URL`
- `COACH_CONSOLE_URL`
- `INVITE_BASE_URL`

`APP_STORE_URL`, `PLAY_STORE_URL`, and `INVITE_BASE_URL` are already
runtime env vars (see the root `README.md`). The remaining tokens
are publish-time config, sourced as documented in `_tokens.md`.

## Inbox routing

`${SUPPORT_EMAIL}` is a single mailbox. The recommended setup is:

1. A shared mailbox at the configured address (e.g.
   `support@thegrowthproject.app`).
2. Forwarding rules into a help-desk product (Front, Help Scout,
   Zendesk — operator's choice).
3. Tag routing on the `category` field from the intake schema in
   [`contact-support.md`](./contact-support.md):
   - `outage`, `security` → on-call engineer queue, paged.
   - `billing` → billing queue, daytime SLA.
   - `client_signup`, `data`, `account_merge`, `other` → general
     queue, two-business-day SLA.

The intake form on the help site populates `category` directly;
inbound email without the field defaults to `other`.

## Status page

`${STATUS_URL}` is owned and operated by the on-call engineer. The
help content is not the place to announce incidents — when the
platform is degraded, update the status page, not these files.

The help content links to `${STATUS_URL}` exactly once, in
[`support-boundaries.md`](./support-boundaries.md), so coaches know
where to look without the link being everywhere.

## Onboarding email sequence

The onboarding emails live in [`../emails/onboarding/`](../emails/onboarding/).
Each file is markdown with frontmatter that captures the trigger
condition and the canonical CTA. The ESP imports the files at deploy
time and configures sends from the frontmatter.

The sequence is opt-in by behavior, not by send: each email is
gated on the coach completing the action the previous email asked
for. See the index in that folder for the trigger graph.

## Updating content

1. Make the edit in this folder on a feature branch.
2. Open a PR. The branch name should start with `docs/`.
3. CI runs the standard repo checks. There is no separate docs
   linter today; markdown is reviewed by hand.
4. After merge, the next deploy of the static site picks up the
   change.

## What lives where

| Concern | Source of truth |
| --- | --- |
| Public coach help | `docs/help/*.md` (this folder) |
| Onboarding emails | `docs/emails/onboarding/*.md` |
| Operator runbooks | `docs/*.md` (parent folder, e.g. `deploy-runbook.md`) |
| Module-level engineering docs | `src/<module>/README.md` |
| Platform-wide env vars and contracts | root `README.md` |
| Status and incidents | `${STATUS_URL}` |

If a piece of information could go in two of those places, prefer
the one closer to the audience that needs it most.
