---
id: coach-onboarding-06-two-week-checkin
subject: Two weeks in. Anything blocking you?
preheader: A short check-in. Reply if there is something we should know.
from_name: ${ESP_FROM_NAME}
from_email: ${SUPPORT_EMAIL}
reply_to: ${SUPPORT_EMAIL}
trigger:
  event: first_client.appeared
  delay: P14D
cta:
  label: Browse the help site
  url: ${HELP_BASE_URL}
tags:
  - coach-onboarding
  - checkin
---

You have been on the platform for two weeks.

This is the only check-in email in the sequence, and it exists for
one reason: to give you a clean line back to us if something has
been bothering you and you have not written in.

If the tool is doing what you need, no reply is needed. Carry on.

If something is in the way — a workflow that does not fit, a
feature you expected, a bug you have been working around — write
back to this email. The reply lands in the support inbox and we
will read it.

The help site has answers to the questions we hear most often. The
button below opens the index.

— ${ESP_FROM_NAME}
