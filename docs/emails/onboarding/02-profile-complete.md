---
id: coach-onboarding-02-profile-complete
subject: Your profile is live. Billing next.
preheader: One step before you can send messages or invite a client.
from_name: ${ESP_FROM_NAME}
from_email: ${SUPPORT_EMAIL}
reply_to: ${SUPPORT_EMAIL}
trigger:
  event: profile.completed
cta:
  label: Set up billing
  url: ${COACH_CONSOLE_URL}/settings/billing
tags:
  - coach-onboarding
  - profile
---

Your coach profile is filled in. Clients who tap your invite link
will see the display name, bio, and photo you just saved.

The next step is billing. The platform requires an active
subscription before you can send messages or invite clients —
read-only access works without it, but writing does not. Setup is
two minutes in the Stripe portal.

If billing has already been set up for you (some launch coaches
were provisioned manually), the page will show **Active** and you
can move on to copying your invite link.

— ${ESP_FROM_NAME}
