---
id: coach-onboarding-03-billing-active
subject: Billing active. Grab your invite link.
preheader: One link, every client. It does not change between invites.
from_name: ${ESP_FROM_NAME}
from_email: ${SUPPORT_EMAIL}
reply_to: ${SUPPORT_EMAIL}
trigger:
  event: subscription.active
cta:
  label: Copy your invite link
  url: ${COACH_CONSOLE_URL}/clients/invite
tags:
  - coach-onboarding
  - invite
---

Billing is active. You can send messages and invite clients.

Your invite link lives at **Clients → Invite** in the console. It
is one link, used for every client you bring on. It does not
expire, and it is not single-use. If you ever need to retire the
current link — for example after a phone is lost — the same page
has a **Rotate** button that swaps in a new one and invalidates
the old.

Copy it once. Save it where you will reach for it: your contact-
form auto-reply, your scheduling tool, your message templates.

— ${ESP_FROM_NAME}
