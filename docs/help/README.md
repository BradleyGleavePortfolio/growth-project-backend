---
title: Coach support content
audience: coaches, operators
---

# Coach support content

This folder is the canonical Markdown source for coach-facing help.
The renderer publishes it at `${HELP_BASE_URL}`.

The content is organized so a coach can find an answer at any stage
of their lifecycle, from setup to client onboarding to incident.

## Index

| Page | Read this when |
| --- | --- |
| [Coach setup checklist](./coach-setup-checklist.md) | A new coach is configuring their account for the first time. |
| [Invite your first client](./invite-first-client.md) | The coach is ready to send their first invite link. |
| [Coach console tour](./coach-console-tour.md) | The coach wants a guided walk-through of the console UI. |
| [FAQ](./faq.md) | The coach has a one-line question. |
| [What support covers](./support-boundaries.md) | The coach wants to know what we will and will not help with. |
| [Contact support](./contact-support.md) | The coach has decided to write in. |
| [Support config](./support-config.md) | An operator needs to know how this content is configured and routed. |

## How this folder is organized

- `_tokens.md` — registry of every named config token used in copy.
- `_decisions.md` — append-only log of editorial decisions.
- `*.md` — public help pages, one topic per file.

The two underscored files are operator-facing and are not published.
Every other file is published verbatim.

## Editorial rules

See [`_decisions.md`](./_decisions.md). The short version: quiet,
direct prose; no emoji; no placeholders; one call-to-action per
email; tokens for every deployment-specific value.
