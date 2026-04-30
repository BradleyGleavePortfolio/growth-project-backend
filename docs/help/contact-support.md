---
title: Contact support
audience: coaches
slug: contact-support
order: 60
---

# Contact support

Write to `${SUPPORT_EMAIL}`.

Before you write, please read [What support covers](./support-boundaries.md).
The fastest support reply is the one that fits a request we can
actually answer.

## What to include

The fields below are not a form — they are a checklist. A message
that includes the first four lands a useful reply on the first
exchange. A message that omits them spends a round trip recovering
them.

- **Account email.** The address on your coach account. If you
  signed in with Apple's hidden-relay address, send the relay
  address — it is what we look up by.
- **What you were trying to do.** One sentence. "Send my first
  invite", "open the billing portal", "see a client's thread".
- **What actually happened.** One or two sentences. Include the
  exact error text if there was one.
- **When it happened.** Approximate time and timezone is fine. We
  use it to find the request in the logs.
- **Screenshots, if a UI is involved.** Crop to the relevant
  region; we do not need the whole desktop.
- **A client's account email, if the issue involves them.** Only
  share an email; do not share their password, payment details, or
  health information.

## Intake schema

For operators or vendors building a contact form against this
inbox, the canonical intake fields are:

| Field            | Type     | Required | Notes                                                    |
| ---------------- | -------- | -------- | -------------------------------------------------------- |
| `account_email`  | email    | yes      | Coach account email or Apple relay address.              |
| `category`       | enum     | yes      | One of: `outage`, `billing`, `client_signup`, `data`, `security`, `account_merge`, `other`. |
| `subject`        | string   | yes      | Free-form, ≤ 120 chars.                                  |
| `body`           | string   | yes      | Free-form. Plain text is fine; markdown is rendered.    |
| `client_email`   | email    | no       | Set only when the issue is about a specific client.      |
| `attachments`    | file[]   | no       | Up to 5 files, ≤ 10 MB each. Images, PDFs, plain text only. |
| `console_url`    | string   | no       | The URL the coach was on when the issue happened.        |
| `user_agent`     | string   | no       | Auto-filled by the form, useful for browser-specific issues. |
| `ts_iso`         | datetime | yes      | ISO-8601 client timestamp, auto-filled.                  |

The form posts to whatever address the operator has configured for
`${SUPPORT_EMAIL}`. There is no separate API endpoint for it; email
is the canonical transport.

## What not to send

- Passwords. We will never ask, and we cannot use them.
- Card numbers. Card management lives in the Stripe portal.
- Personal health information that the client did not consent to
  share with us. Coach-client conversations can stay between you
  and your client; support does not need them to investigate
  account or platform issues.

## Response expectations

See the SLAs in [What support covers](./support-boundaries.md). If
you have not heard back within the stated window, reply to your
own thread — do not open a second one. Replies bump priority; new
threads start from the back.
