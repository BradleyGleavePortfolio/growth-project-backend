---
title: Coach onboarding email sequence
audience: operators, ESP integrator
---

# Coach onboarding email sequence

Markdown source for the transactional email sequence sent to a
newly-promoted coach. Each file in this folder is one email, and
its frontmatter captures everything the email service provider
(ESP) needs to import and schedule it.

The sequence is **opt-in by behavior**: email N+1 is sent only
after the coach has completed the action email N asked for. We do
not send the full sequence on a fixed cadence — that would mistime
people who move quickly and harass people who do not.

## The trigger graph

```
account_promoted_to_coach
        │
        ▼
   01-welcome.md
        │
        │ trigger: profile.completed
        ▼
   02-profile-complete.md
        │
        │ trigger: subscription.active
        ▼
   03-billing-active.md
        │
        │ trigger: invite.copied
        ▼
   04-invite-ready.md
        │
        │ trigger: first_client.appeared
        ▼
   05-first-client.md
        │
        │ trigger: + 14 days, no prior reply
        ▼
   06-two-week-checkin.md
```

A coach who races through setup hits emails 1 → 5 in a single day,
which is fine — the messages are short. A coach who stalls at any
step gets the relevant email and nothing further until they
complete it.

## Frontmatter contract

Every email file has frontmatter with the following fields. The
ESP integration reads these directly.

| Field            | Purpose                                                           |
| ---------------- | ----------------------------------------------------------------- |
| `id`             | Stable slug. Never change once shipped.                           |
| `subject`        | Subject line. Plain text, no emoji, ≤ 60 chars.                  |
| `preheader`      | The preview text rendered next to the subject.                    |
| `from_name`      | Always `${ESP_FROM_NAME}`.                                       |
| `from_email`     | Always `${SUPPORT_EMAIL}`.                                       |
| `reply_to`       | Always `${SUPPORT_EMAIL}`.                                       |
| `trigger.event`  | The behavior that fires this email. See the trigger graph.       |
| `trigger.delay`  | Optional ISO-8601 duration delay after the event.                |
| `cta.label`      | The single call-to-action button label.                          |
| `cta.url`        | The destination of that button. Always a token-based URL.        |
| `tags`           | Tags applied in the ESP for reporting.                           |

## Body conventions

- One CTA per email. No second link, no postscript link.
- No emoji, no exclamation marks, no marketing softeners.
- No "Hi {first_name}!" — we may not have a first name. Greet by
  role: "Welcome." / "A note about billing." / "Your roster has
  someone in it."
- Short paragraphs (one to three sentences).
- A signature line of `${ESP_FROM_NAME}` only. No personal name.

## Files

- [`01-welcome.md`](./01-welcome.md)
- [`02-profile-complete.md`](./02-profile-complete.md)
- [`03-billing-active.md`](./03-billing-active.md)
- [`04-invite-ready.md`](./04-invite-ready.md)
- [`05-first-client.md`](./05-first-client.md)
- [`06-two-week-checkin.md`](./06-two-week-checkin.md)
