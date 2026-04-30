---
id: coach-onboarding-05-first-client
subject: You have a client.
preheader: A few quick notes about messaging and read markers.
from_name: ${ESP_FROM_NAME}
from_email: ${SUPPORT_EMAIL}
reply_to: ${SUPPORT_EMAIL}
trigger:
  event: first_client.appeared
cta:
  label: Open the thread
  url: ${COACH_CONSOLE_URL}/clients/roster
tags:
  - coach-onboarding
  - first-client
---

Your roster has someone in it.

A few notes for the first conversation:

Sends are instant. The client gets a push notification on their
phone the moment you send. The thread shows read markers on both
sides, so you can tell at a glance whether your last message has
been opened.

Drafts stay attached to the thread, not to your device. If you
start a draft on the desktop and finish it on a different
machine, the draft will be there.

The client can reply at any time. There is no scheduled-message
feature on either side yet — every send is immediate.

When you are ready, open the thread below.

— ${ESP_FROM_NAME}
