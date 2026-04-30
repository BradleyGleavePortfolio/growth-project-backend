---
title: Invite your first client
audience: coaches
slug: invite-first-client
order: 20
---

# Invite your first client

This walks through the first real invite, end to end. Use it once,
then keep it as a reference for the moments your client gets stuck.

## Before you send anything

Confirm three things in the coach console:

- **Settings → Profile** has a display name, bio, and photo. The
  client will see all three when they open the link.
- **Settings → Billing** reads **Active**.
- **Clients → Invite** shows a link. Copy it.

If any of these are missing, finish the
[setup checklist](./coach-setup-checklist.md) first. Sending an
invite before billing is active will block the client from sending
messages even after they sign up.

## Send the link

Send the link to one client by the channel you actually use with
them. Text and email are the most common. The link looks like:

```
${INVITE_BASE_URL}/AB12CD
```

Anything you write alongside the link is up to you, but the link
itself does the heavy lifting — it shows your photo, your bio, and
an **Open in app** button when the client taps it. You do not need
to explain what the app is in the message.

## What the client sees

Tapping the link opens a landing page in the browser. The page
shows your card and one button. The button does one of two things:

- If the client already has the app installed, it deep-links into
  the app and starts the sign-in flow.
- If the client does not have the app installed, it routes to the
  App Store or Play Store, and the deep link is preserved through
  the install. After installing and opening the app for the first
  time, they land on the same sign-in flow with your invite already
  attached.

The client signs in (Apple, Google, or email), and the moment that
finishes, your roster picks them up.

## Confirm they landed

In the console, open **Clients → Roster**. The client should appear
within a few seconds of completing sign-in. If they do not, ask
them which step they got stuck on:

- Could they open the link in their browser? — DNS or carrier issue
  on their end.
- Did the **Open in app** button appear? — Yes means the link
  resolved correctly. No means the link they used was incomplete
  (often from a copy-paste that dropped characters).
- Did they finish sign-in? — If they bailed on the Apple or Google
  prompt, there is no row to show; they need to retry.

## Common first-invite snags

- **The client has an existing account from a different coach.**
  They cannot be moved by sending a new invite. Ask them to delete
  their account in the app first, then sign up again with your
  invite. Or contact us — see [Contact support](./contact-support.md).
- **The link looks like `…/join/`** with no code. The code did not
  copy. Re-copy from **Clients → Invite**.
- **The client tapped the link but it opened a generic app store
  page.** The link did not contain the code, or they tapped a
  shortened version that dropped path segments. Send the original
  link without a URL shortener.
- **Apple or Google sign-in returned them to a blank screen.** Their
  browser blocked the redirect. Have them open the original link in
  Safari (iOS) or Chrome (Android) rather than an in-app browser.

## After the first invite

For every subsequent client, send the same link. The link does not
change between clients. There is no per-client setup on your side
until a client appears in your roster, at which point you can open
their thread and message them in the console.
