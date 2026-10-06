**Tier:** T3 (store / safety: Apple 1.2 report-and-respond; new outbound email to the operator inbox)
**Why:** Message reports and community reports are saved, and both report sheets promise review within 24 hours, but no person is told a report exists (AUDIT-03-125 N1, AUDIT-10-125 U-2). This sends one email to the support inbox for every new report.
**T4 trigger scan:** no auth, RLS/tenancy, money, credentials or destructive data change. PII: the email is built from ids and fixed labels only; message text, the reporter's details/notes, health data and names are never read into it (tests assert this). No migration, no flag, no new env var, no new dependency.
**T3 trigger scan:** user-facing safety path (report filing) gains a fire-and-forget side effect; the report response is unchanged and never waits on or fails from the email.
**Bounded T1:** new `src/report-alerts/report-alert.service.ts` + `report-alert.hbs` template; two call sites (`MessagesSafetyService.reportMessage`, `CommunityModerationService.report`); provider registration in the two modules; one template key + subject.
**Canonical builder:** Claude Opus 5.5 (B-REPORTALERT-125, agent 125).
**Acceptance evidence:** `test/report-alerts/report-alert.spec.ts` (8 tests) passes locally; `test/email.service.spec.ts` (renders every template, incl. the new one) and `test/messages-safety.service.spec.ts` pass unchanged; R75 range check OK; eslint clean on the changed src files. Full suite and tsc in this PR's CI.

## What it fixes
- **B1 (Apple 1.2 / false claim):** a member reports a DM or a community post as self-harm, threats or abuse; the app promises review within 24 hours, but nobody is told the report exists, so it can sit unseen. Now every new report emails the support inbox.

## Behaviour
- Recipient: `SUPPORT_EMAIL` (`src/public-pages/trust-pages.html.ts`), the app's one support address, already the community safety contact. Sender: the existing `EMAIL_FROM_ADDRESS` through `EmailService` (Resend). No new address or env var.
- Content: report id, kind (DM / community), reported content type + id, reason label, time (PT and UTC), where to review it. Self-harm or suicide reports say so first in the subject (`Self-harm or suicide report: review now (...)`) and first in the body.
- DM reasons the app folds into a wider reason (Hate speech, Violence or threats, Misinformation -> harassment / other, label first in details, m#429) are named from that fixed label prefix only; the details text is never emailed. An unknown community reason code shows as a fixed "unlisted" label, never the raw text.
- One email per new report (idempotency key `report-alert:<kind>:<report id>`); a repeat DM report (`already_reported`) sends nothing.
- Failure never fails the report: `reportFiled()` always resolves; a failure is logged (ids + provider code only) and counted in `report_alert_email_total{kind,outcome}` on the prom-client registry.

## Overlap
- None. No open backend PR touches messages-safety, community/moderation, community.module.ts or src/email. b#789 touches messaging.service.ts only; m#428 / m#429 are merged mobile changes whose reason codes and labels this reuses.

## Operator note
- Delivery needs production `EMAIL_TRANSPORT=resend` (RESEND_API_KEY is present per fly-env-truth 10-05). With `EMAIL_TRANSPORT=log` the alert is logged, not sent.
