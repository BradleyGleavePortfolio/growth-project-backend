# Vendor deletion and backup procedures (privacy policy publication hold, backend #611)

Status: procedure of record for the deletion and backup promises in `/privacy`,
`/consumer-health-privacy` and `/help/delete-account` (`src/public-pages/`).
Written 2026-10-02 for the #611 publication hold (B-611-1). The operator
publishes #611 only after backend #608 (in-app account erasure) is live.
Restoring a database backup is out of scope: §1.2 states the requirement and
points to the separate T4 follow-up (backend issue #662).

The published promises this document has to make true:

1. "We tell our service providers about deletion requests so they delete their copies too." (Privacy Policy, "Deleting your account")
2. "Backups — database backups and copies are never kept more than six months after a confirmed deletion request. Copies of the database made before an update to the service are deleted 30 days after the update is verified, and never kept beyond 90 days." (Privacy Policy retention list; same limits on `/help/delete-account` and in the consumer health policy, RCW 19.373.040. Plan-agnostic wording, owner 2026-10-03, O-611-4.)
3. In-app deletion: 14-day cancellable grace period, then erasure within one day (`DELETION_GRACE_DAYS=14`, nightly `DELETION_FINALIZE_CRON` 03:00 UTC). By email: reply within 30 days; consumer health requests answered within 45 days.
4. Roman conversations: "kept until you delete them or your account" (owner 2026-10-01 20:32, OR-110-1).

How to read this document:
- **Fact (repo)** means the behaviour is in this repository; the file is named. "#608" means backend PR #608 (head `e4e7a44d` when written), which is not on `main` yet.
- **Fact (vendor)** means the vendor's public documentation says so; the link is given. Vendor terms change, so re-check them at each quarterly review.
- **UNVERIFIED (owner)** means nobody has confirmed it from the account settings or contract. Before publication, the owner confirms each one or the policy wording changes.
- **Procedure** is what a person does, and who does it. Until there is a support team, the owner (Bradley) does every manual step. The address the policies publish is the shared `SUPPORT_EMAIL` (`src/public-pages/help-pages.html.ts`).

No secrets, project credentials or personal data are in this file.

---

## 0. The deletion run (what the app does on its own)

**Fact (repo, #608 `src/account-deletion/`).** The nightly job finalizes each account whose grace period has ended. It runs in one database transaction:

1. It tombstones the `User` row. The email becomes `deleted-<id>@tombstone.invalid` and the name becomes "Deleted user". Phone, coach link, push token, leaderboard name, signup ref and payout method are cleared, and `deleted_at` is set.
2. It runs `ERASURE_MANIFEST`, which decides every user-referencing column (`test/account-deletion/erasure-manifest-coverage.spec.ts` enforces this). Roman sessions and messages, the AI consent ledger, logs, wearables, intake, community content, notifications and the rest are deleted or scrubbed.
3. It deletes the person's lifecycle `deletion_audit` rows. One outcome row with a random subject id stays.
4. Only after every database statement succeeds, it removes the stored objects (Supabase Storage: voice notes, coach media, `bloodwork/<userId>/…`; Mux assets; data-export archives) and cancels every live Stripe subscription. Any failure rolls the transaction back, and the next nightly run retries.

After the commit, the Supabase auth identity is removed. The retry runs nightly until it succeeds. The tombstone then holds a one-way receipt hash for 30 days, and after that `deleted-<id>`.

What stays (also stated on the Privacy Policy after the B-611-2 fix):
- The tombstone `User` row: internal id, role, created/closed dates. It has no name, contact details or profile, and it does not expire. It exists so retained finance rows still point to one closed account.
- Finance mirrors that hold only amounts, dates and Stripe ids.
- One random-id deletion outcome row.
- Security and audit logs.

Sign in with Apple: #608 revokes the Apple token when `APPLE_TEAM_ID`, `APPLE_SIGNIN_KEY_ID` and `APPLE_SIGNIN_PRIVATE_KEY` are set. **UNVERIFIED (owner):** the key is not created yet, so the outcome is `not_configured`. The app then tells the person how to remove the app from their Apple Account.

**Operator ruling (agent 116, 2026-10-03, on Opus RG-1 at #611 `5eac8f21`):** the policy must be true on the day it publishes, and production has no Sign in with Apple key yet. So the Privacy Policy does **not** claim that deletion revokes Sign in with Apple. It says what is true today: deleting the account ends the app's link to the Apple Account (the deletion run removes the Supabase sign-in identity), and the person can remove the app from their Apple Account themselves (`SIGN_IN_WITH_APPLE_DELETION_TEXT` in `src/public-pages/trust-pages.html.ts`, shared by `/privacy` and `/help/delete-account`, both linking Apple's article). The steps are Apple's, from [Apple Support 102571](https://support.apple.com/en-us/102571) (published 2026-09-14): on iPhone, Settings > [your name] > Sign in with Apple > the app > Delete, then confirm; on the web, account.apple.com > Sign-In & Security > Sign in with Apple. Re-check them against that article when Apple changes it (`test/privacy-apple-unlink-path.spec.ts`). **Follow-up:** once the owner sets the Apple key secrets in production and a deletion shows `apple_revocation=revoked`, a follow-up PR restores the revocation sentence.

Everything below covers the copies the deletion run does **not** reach: vendor-side copies, logs and backups.

---

## 1. Supabase: Postgres, Auth, Storage

**What it holds:** everything in our database (`prisma/schema.prisma`), the Supabase Auth users (`auth.users`, same Postgres), and the Storage buckets `voice-notes`, `coach-media` and `bloodwork`.

**Deleted by:** the deletion run (§0), automatically and within one day after the grace period:
- Database rows are deleted or scrubbed.
- Auth users are removed with `auth.admin.deleteUser`, retried nightly.
- Storage objects are removed by key.

A client's own Roman chat delete erases messages immediately (`DELETE /roman/sessions[/:id]`, backend #635).

**Backups — Fact (vendor), [Supabase database backups](https://supabase.com/docs/guides/platform/backups):**
- Daily backups are kept for 7 days on Pro, 14 days on Team, and up to 30 days on Enterprise.
- Point-in-time recovery (PITR) is a paid add-on with a 7, 14 or 28 day window. When PITR is on, daily backups stop.
- Database backups do **not** include Storage objects, only their metadata, so a removed file is not in a database backup.
- Deleting a project removes its backups.

Supabase manages these backups. We cannot delete one person from them; they **age out** at the end of the window. With any plan above, the oldest database copy of a deleted person is gone at most 30 days after erasure, well inside the six-month promise.

**Owner (2026-10-03, O-611-4):** production is on the Supabase **Free** plan today. The public pages therefore make no plan-specific backup claim (no "7-day backups"): they promise only that database backups and copies are never kept more than six months after a confirmed deletion request, and the §1.1 dump limits. If the plan changes, record the new window in §9; any window up to six months keeps the promise.

**UNVERIFIED (owner):**
- Whether a Free-plan project has any automatic backup. The vendor page states no retention for it.
- How Supabase Storage keeps redundant or replicated copies of deleted objects internally. The vendor page does not say.

**Supabase logs:** API, auth and database logs can contain user ids, IP addresses and email addresses (auth). **UNVERIFIED (owner):** log retention for the plan. Logs age out on Supabase's schedule; we do not export them.

### 1.1 Our own database dumps (operator-held copies)

**Fact (repo).** `docs/deploy-runbook.md` §2 step 3 / §3 step 1 tells the operator to `pg_dump` a reference copy before any deploy with a migration. The business continuity plan template (`docs/soc2/policies/business-continuity-plan.md`, "Manual backup cadence") also proposes a weekly manual export. These are full copies of personal data, and no system ages them out on its own, so both documents now state the rules below (FIX ROUND 8, Opus B-611-11). If a dump is ever kept in a versioned bucket, the bucket also needs a noncurrent-version expiry, or old versions outlive the 90-day limit.

**Procedure (ADOPTED by the owner 2026-10-03, O-611-4; the 30-day and 90-day limits are published on the policies):**
- Every dump is named with its date and stored only in one owner-controlled location.
- Delete a dump 30 days after the deploy it was taken for is verified.
- Never keep any dump for more than 90 days. That bound alone keeps the six-month promise, even if a dump is taken the day before a deletion request.
- On the first working day of each month, the owner lists the stored dumps and deletes any older than these limits. The check goes in the quarterly review log (`docs/soc2/runbook-quarterly-review.md`).
- A dump is never copied to a laptop disk outside the vault. If one is, it is deleted the same day.

### 1.2 Restores: not covered by this document

This document has **no restore procedure**. A restore (PITR or a daily backup) rewinds the whole database, so accounts erased, Roman chats deleted, AI-consent withdrawals recorded and deletions scheduled after the restore point would come back or be lost.

**Requirement (any restore):** after the restore, and before the app or any job reads the restored data, every erasure, chat delete, AI-consent withdrawal and scheduled deletion recorded after the restore point is re-applied and the final state verified. Traffic reopens only after that.

The procedure that meets this requirement is separate T4 work: [backend issue #662, restore without resurrection](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/662). It must replay the AI-consent ledger with its original order, version and copy hash, never synthesize a grant, and fail closed. Until it lands, a production restore is not a planned recovery route (`docs/deploy-runbook.md` §2 step 3 and §3 step 4: recovery is forward-only).

The public pages promise no restore procedure. They promise that deleted data leaves live systems and that backup copies age out (§1, §1.1); this section records the condition a restore must meet to keep those promises.

---

## 2. Fly.io (hosting)

**What it holds:** the running API machines; stdout logs (structured JSON with user ids and request ids; `src/observability/log-redaction.ts` redacts secrets and tokens); and, briefly, data-export archives written to `DATA_EXPORT_FS_DIR` on the machine.

**Fact (repo):** `fly.toml` mounts no volume. Export archives are removed by #608's deletion run and by the nightly export cleanup, and they do not survive a machine replacement. We keep no database on Fly.

**Logs — Fact (vendor), [Fly logging overview](https://docs.fly.io/monitoring/logging-overview/):** Fly's log search keeps logs for 7 days. Logs age out; we cannot delete one person from them.

**UNVERIFIED (owner):** whether any log stream or log drain (for example Better Stack, which `src/observability/README.md` mentions only as an option) is configured in the Fly organization. If one is, add it to this document and to the Privacy Policy vendor list, with its retention.

---

## 3. Anthropic (Roman and coach AI drafts; community AI triage if turned on)

**What it receives:** the AI consent categories, and only for clients who ticked box 2 (`client-ai-v4`, ledger enforcement on since #626/#638).

**Fact (vendor), [Anthropic: how long do you store my organization's data](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data):** "For Anthropic API users, we automatically delete inputs and outputs on our backend within 30 days of receipt or generation." There are exceptions:
- a zero data retention (ZDR) agreement;
- longer retention to enforce the Usage Policy (inputs and outputs flagged by trust-and-safety systems are kept up to 2 years, classification scores up to 7 years);
- retention required by law.

**Fact (vendor), [API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention):** under ZDR, prompts and responses are not stored at rest after the response is returned. Some models ("Covered Models") require 30-day retention and are not ZDR-eligible.

**Deleted by:** Anthropic's own 30-day automatic deletion. There is no per-person delete call for API traffic, and we do not use the Files API, batches or stored sessions for client data (`src/ai-egress/`, `src/roman/`).

**Owner (2026-10-03, O-611-2):** TGP has **no** ZDR agreement with Anthropic. Both policies say: "Anthropic deletes what it receives within 30 days, except where its usage policy or the law requires it to keep it longer."

**UNVERIFIED (owner):**
- Whether the models in use are ZDR-eligible (only relevant if a ZDR agreement is made later) (Roman: `ROMAN_MODEL_PHASE_1` = `claude-3-7-sonnet-20250219` in `src/roman/anthropic-client.provider.ts`; coach AI: `COACH_AI_MODEL` = `claude-sonnet-4-6` in `src/ai/coach/coach-ai.constants.ts`).
- How the Usage Policy flag exception (up to 2 years) fits with the policy's statement that providers delete their copies.


**Procedure:** none per request beyond the deletion run. Anthropic's copies age out within 30 days.

---

## 4. Stripe (payments, invoices, coach payouts)

**What it holds:**
- Customers (name, email, billing details, card fingerprint) and charges, invoices and subscriptions.
- For coaches: Connect Express accounts with their identity verification.

**Deleted by:**
- **Fact (repo, #608):** the deletion run cancels every live subscription. It does **not** delete or redact the Stripe Customer, and it does not close a coach's Connect account.
- **Fact (vendor), [Stripe: handling customer deletion requests](https://docs.stripe.com/privacy/deletion-requests):**
  - Stripe "might retain data as legally required, after redaction";
  - delete calls act on the named object only;
  - transactions cannot be deleted and can be redacted only after 90 days;
  - [redaction jobs](https://docs.stripe.com/privacy/redaction) remove personal data from the Dashboard and API.

**Procedure (owner, within 30 days of the deletion finalizing, or of the email request):**
1. Find the person's Stripe Customer (and, for a coach, Connect account) from the retained finance mirror rows, which keep only Stripe ids.
2. Once no payment, refund or dispute is open, run a Stripe redaction job for the Customer. For a coach, close the Connect account in the Dashboard once no payout or refund is pending (OR-111-1 recovery may keep it open until the held amount settles).
3. Note the Stripe object ids, not personal data, in the deletion log (§9).

Stripe keeps the payment and tax records the law requires. The policy already says this ("Payment and tax records held by Stripe … as long as the law requires").

**Owner (2026-10-03, O-611-5):** Stripe redaction jobs are used for deletion requests; Stripe keeps the payment records the law requires. The Privacy Policy says so.

---

## 5. Expo push service (with Apple APNs and Google FCM)

**What it holds:** the device push token, plus the content of each notification while it is delivered.

**Deleted by:**
- **Fact (repo, #608):** the deletion run clears `User.expo_push_token` and deletes notification rows, so nothing more is sent.
- **Fact (vendor), [Expo: send notifications](https://docs.expo.dev/push-notifications/sending-notifications/):** "push receipts are cleared after 24 hours".

**UNVERIFIED (owner):**
- Whether Expo keeps notification content or tickets beyond the receipt window. The vendor page does not say.
- How APNs and FCM handle undelivered messages to a device that is offline. They store and forward only until expiry, per Apple and Google docs; this has not been checked.

**Procedure:** none per request; tokens are cleared at erasure.

---

## 6. Sentry (crash and error monitoring)

**What it holds:**
- Error events from the API. `src/observability/sentry-config.ts` `beforeSend` scrubs them, and ORM errors are replaced by `safeDiagnostic`.
- Error events from the mobile app. **Fact (repo, mobile `src/services/sentry.ts`, mobile #330 merged 2026-10-02):** `setSentryUser` sets only the opaque user **id** on events, never the email. `src/services/sentryPrivacy.ts` `scrubEvent` also reduces any event user to `{ id }` (mobile main `367e6c48`).
- The backend sets no Sentry user: `beforeSend` forwards an allow-listed envelope without `user` (pinned by `test/privacy-diagnostics-disclosure.spec.ts`).

The Privacy Policy says crash and performance reports are linked to the account id, with no name or email address attached. (Until FIX ROUND 8 it said they include the email address; Sol B-611-7, Opus C-611-12.)

Events can include health details that appear in an error, as the policy says.

**Deleted by:** age-out. **Fact (vendor), [Sentry data retention periods](https://docs.sentry.io/security-legal-pii/security/data-retention-periods/):** errors are kept 30 days (Developer) or 90 days (Team, Business), and logs 30 days. After that they can no longer be accessed. Every plan's limit is inside six months.

**Procedure (owner, on an email deletion request that asks for it, or for a consumer health request):** in Sentry, search events by the user id and delete the matching issues or events. Otherwise let them age out.

**Owner (2026-10-03, O-611-5):** error reports are kept 90 days (Team). The Privacy Policy retention list says so.

---

## 7. Resend (account and notification email)

**What it holds:** each email we send (recipient, subject, body) and delivery logs.

**Deleted by:** age-out. **Fact (vendor), [Resend security](https://resend.com/security) / [quotas and limits](https://resend.com/docs/knowledge-base/account-quotas-and-limits):** email and log data are kept 30 days on the Free, Pro and Scale plans.

**Fact (repo, #608):** scheduled emails stop when the deletion completes.

**Procedure:** none per request; copies age out within 30 days. **Owner (2026-10-03, O-611-5):** email logs are kept 30 days; the Privacy Policy retention list says so. **UNVERIFIED (owner):** whether any contact list or audience in Resend holds the person (we do not create audiences in code; `src/email/`).

---

## 8. Other providers named in the Privacy Policy

| Provider | Holds | Deleted how, by whom, when | Status |
|---|---|---|---|
| PostHog (product analytics) | Events keyed by our user id (mobile `identify(user.id)`, server `distinctId` = user id; `src/analytics/`) | **Procedure (owner, within 21 days of the deletion finalizing):** delete the person in PostHog (Persons, or the persons API) with their events and recordings. [PostHog: controlling data storage](https://posthog.com/docs/privacy/data-storage): deletion runs asynchronously, and event data is cleared in off-peak runs (weekends on PostHog Cloud). The 21-day deadline leaves room for that run inside the published 30 days (Opus C-611-14). #608 does not call PostHog. | Owner (2026-10-03, O-611-5): product analytics on, session recording **off**; a deleted person is removed within 30 days of the deletion (published) |
| Crisp (in-app support chat) | Whatever the person tells support, plus their contact | **Procedure (owner, within 30 days):** delete the contact and conversations in the Crisp inbox. [Crisp: how to delete a conversation](https://help.crisp.chat/en/article/how-to-delete-a-conversation-1g04h7j/): history is kept until deleted. | UNVERIFIED: whether the Crisp SDK is live in the production app build |
| Mux (coach video media) | Video assets a coach uploaded; the IP address and device type of each device that uploads or plays a video (devices upload to the Mux upload URL and play from `stream.mux.com` directly; mobile `src/utils/workout/exerciseMedia.ts`) | **Fact (repo, #608 `account-deletion.storage.ts`):** Mux assets are deleted by the deletion run. Connection data ages out on Mux's schedule. | Owner (2026-10-03, O-611-3): Mux is **live**; named in both policies with what it receives (the video files coaches upload, no name, email or account details attached; the Privacy Policy also names the device IP address and device type, Opus C-611-13) |
| Perplexity (milestone messages, if enabled) | Only the milestone type, no personal data (policy) | Nothing to delete | UNVERIFIED: flag state |
| Apple / Google sign-in | Their own account link to TGP | Apple: token revocation by #608 when the key is set (§0); until then the policy says only that deletion ends the app's link to the Apple Account and gives Apple's steps to remove the app (§0). Google: the person removes TGP in their Google account; Supabase identity is removed by the deletion run | Apple key UNVERIFIED (not created); a follow-up restores the revocation sentence once it is set (§0) |
| USDA FoodData Central, Open Food Facts | Search words only (policy) | Nothing to delete | n/a |

---

## 9. The deletion log and the review

**Procedure (owner):**
- Keep one private deletion log, outside this repository and never committed. Each row has the deletion reference or request date, the date of finalization, and which manual steps were done (Stripe redaction, PostHog, Crisp, Sentry when requested). The row holds vendor object ids only, never name, email or health data.
- Email requests: confirm the person's identity from the account email. Run the owner deletion within 30 days (45 days for a consumer health request, with one 45-day extension as the policy says), then do the manual steps above.
- Every quarter (`docs/soc2/runbook-quarterly-review.md`):
  - re-check every UNVERIFIED item and every vendor retention link above;
  - run the §1.1 dump inventory;
  - update this table.

| Item to record (owner) | Value | Checked on |
|---|---|---|
| Supabase plan / PITR on? / window | Free plan; no plan-specific claim published | 2026-10-03 (owner) |
| Supabase log retention | _unverified_ | |
| Fly log stream configured? | _unverified_ | |
| Anthropic ZDR agreement? Models in use ZDR-eligible? | No ZDR; 30-day sentence published | 2026-10-03 (owner) |
| Stripe redaction jobs available? | Yes, used for deletion requests | 2026-10-03 (owner) |
| Sentry plan (retention 30 or 90 days) | 90 days | 2026-10-03 (owner) |
| Resend plan (30 days) | 30 days | 2026-10-03 (owner) |
| PostHog plan / recordings on? | Analytics on, recordings off, person removed within 30 days (owner deletes within 21, §8) | 2026-10-03 (owner) |
| Crisp live in production build? | _unverified_ | |
| Mux live? Policy updated? | Live; both policies name it | 2026-10-03 (owner) |
| Apple Sign in key created (revocation live)? | _no (not created)_; the policy makes no revocation claim until it is (§0) | |

## 10. Does each promise hold?

- **"Never kept beyond six months" (backups):** holds when four things are true:
  - any Supabase backup window on the plan in use is at most six months (Free plan today, §1);
  - §1.1 dumps follow the 90-day limit;
  - Sentry, Resend and Fly logs age out at 90, 30 and 7 days;
  - Anthropic deletes within 30 days, except its Usage Policy and legal exceptions (published, §3).
- **"We tell our service providers so they delete their copies":** holds for Supabase, Fly, Expo, Mux and Resend through the deletion run plus age-out. It needs the manual §4 (Stripe) and §8 (PostHog, Crisp) steps, done within 30 days and recorded in the §9 log.
- **Roman conversations "kept until you delete them or your account":** holds through #635's client delete and #608's erasure manifest. Anthropic's copy ages out within 30 days (§3).
- **Deleted data and AI withdrawals stay that way after a restore:** no restore procedure exists; any restore must meet the §1.2 requirement, built in [#662](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/662).
