---
title: Coach support content
audience: coaches, operators
---

# Coach support content

The served coach-facing help is maintained in `src/public-pages/help-pages.html.ts`
and published at https://app.trygrowthproject.com/help.
Setup, first-client, tour and FAQ files here summarize and link to that content.

The content is organized so a coach can find an answer at any stage
of their lifecycle, from setup to client onboarding to incident.

## Index

| Page | Read this when |
| --- | --- |
| [Coach setup checklist](./coach-setup-checklist.md) | A new coach is configuring their account for the first time. |
| [Invite your first client](./invite-first-client.md) | The coach is ready to send their first invite link. |
| [Coach app tour](./coach-console-tour.md) | The coach wants a guide to the mobile coach tabs. |
| [FAQ](./faq.md) | The coach has a one-line question. |
| [What support covers](./support-boundaries.md) | The coach wants to know what we will and will not help with. |
| [Contact support](./contact-support.md) | The coach has decided to write in. |
| [Support config](./support-config.md) | An operator needs to know how this content is configured and routed. |

## How this folder is organized

- `_tokens.md` — registry of every named config token used in copy.
- `_decisions.md` — append-only log of editorial decisions.
- `*.md` — public help pages, one topic per file.

The underscored files are operator-facing. The help endpoints render the
TypeScript content, not these Markdown files.

## Editorial rules

See [`_decisions.md`](./_decisions.md). The short version: quiet,
direct prose; no emoji; no placeholders; one call-to-action per
email; tokens for every deployment-specific value.
