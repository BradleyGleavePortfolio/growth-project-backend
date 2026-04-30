---
id: coach-onboarding-01-welcome
subject: Welcome to The Growth Project
preheader: A short setup checklist, in the order it makes sense to do it.
from_name: ${ESP_FROM_NAME}
from_email: ${SUPPORT_EMAIL}
reply_to: ${SUPPORT_EMAIL}
trigger:
  event: account_promoted_to_coach
cta:
  label: Open the coach console
  url: ${COACH_CONSOLE_URL}
tags:
  - coach-onboarding
  - welcome
---

Welcome.

Your account is now a coach account. The next thirty minutes set
up the rest.

There are six steps. Three you do once, three you confirm work
end-to-end. Take them in order, because each one unblocks the next.

1. Sign in to the console at `${COACH_CONSOLE_URL}`.
2. Fill in your profile — display name, bio, photo, timezone.
3. Start your subscription in **Settings → Billing**.
4. Copy your invite link from **Clients → Invite**.
5. Send the link to one test client and confirm they appear in
   your roster.
6. Read the support boundaries page so you know what we cover.

The full checklist is at `${HELP_BASE_URL}/coach-setup-checklist`.
Open the console below when you are ready.

— ${ESP_FROM_NAME}
