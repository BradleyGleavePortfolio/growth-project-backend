---
title: Coach console tour
audience: coaches, content team
slug: coach-console-tour
order: 30
---

# Coach console tour

This page is the script and shot list for a guided tour of the coach
console. It serves two readers: a coach who wants to read the tour,
and the content team who will record the screencast version.

The tour is six scenes. Total running time on video is just under
three minutes.

## Scene 1 — Sign in

**Shot:** the sign-in page at `${COACH_CONSOLE_URL}`, full browser
window, no other tabs visible.

**Script:** "Sign in with the email you used during setup. Apple,
Google, and email all land you in the same place."

**Cut on:** the moment the dashboard loads.

## Scene 2 — Dashboard at a glance

**Shot:** the dashboard view. Highlight the top header (your
display name and role chip), and the three primary tiles: roster
count, unread messages, and billing status.

**Script:** "The header shows the account you are signed in as. If
the chip reads **Coach**, you are in the right place. The three
tiles below it are everything you need to glance at on a normal
day — how many clients you have, how many messages are waiting,
and whether billing is healthy."

**Cut on:** cursor hovering the unread-messages tile.

## Scene 3 — Roster and a single client

**Shot:** click into **Clients → Roster**. The list view fills the
frame. Click a representative client (use a seeded test client, not
a real one).

**Script:** "Roster is the source of truth for who is on your books.
Each row links to a thread. The thread is a conversation, with
read markers on both sides, so you can see at a glance whether your
last message has been opened."

**Cut on:** the thread fully loaded with two or three sample
messages visible.

## Scene 4 — Send a message

**Shot:** the composer at the bottom of the thread. Type one short
message — "Quick check-in. How is the week going?" — and send.

**Script:** "Sending is instant. The client gets a push notification
on their phone. If you save a draft instead of sending, it stays
attached to the thread; you can come back to it from any device."

**Cut on:** the sent message appearing in the timeline with a
delivered marker.

## Scene 5 — Invite link

**Shot:** sidebar to **Clients → Invite**. Show the link card with
the **Copy** and **Rotate** buttons.

**Script:** "Your invite link does not change between clients. Copy
it once, send it to whoever you want to bring on. If you ever need
to retire the current link, **Rotate** generates a new one and
makes the old one stop working."

**Cut on:** clicking **Copy** and the toast confirming the copy.

## Scene 6 — Settings and billing

**Shot:** sidebar to **Settings → Billing**. Show the active
status and the **Manage in Stripe** button.

**Script:** "Billing lives in Stripe. The console shows the current
status and a button into the Stripe portal, where you can update a
card, see invoices, or cancel. If billing ever lapses, this tile is
the first place to look."

**Cut on:** the Stripe portal button highlighted, then a hard cut
to the Growth Project wordmark.

## Shot list summary

| Scene | Surface | Duration |
| --- | --- | --- |
| 1 | Sign-in page | 0:15 |
| 2 | Dashboard | 0:20 |
| 3 | Roster → client thread | 0:35 |
| 4 | Composer + send | 0:25 |
| 5 | Invite link card | 0:25 |
| 6 | Settings → Billing | 0:25 |

## Recording notes

- Record at 1920×1080. The console is responsive but the tour reads
  best at desktop width.
- Use a seeded test account with three clients and one open thread.
  Do not record over a live coach's data.
- Hide browser bookmarks bars and extension chrome.
- Voiceover is read flat. No music bed. The console UI is the
  product; narration is a guide rail.
- Capture each scene as a separate clip so a single re-record does
  not require re-recording the whole tour.
