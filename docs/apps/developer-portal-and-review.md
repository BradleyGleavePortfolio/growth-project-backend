# Apps Platform — Developer Portal and Review

Status: DRAFT (docs only)
Wave: 6

## 1. Purpose

Specifies the developer portal surface, the submission flow, the review SLA, the reject-reason taxonomy, the sandbox lifecycle, a worked example app walkthrough, the trust ladder for unverified vs verified developers, and the banned category list.

This is the front door to the apps platform for third-party developers and the policy surface for TGP staff reviewers.

## 2. Personas + permission matrix (portal/review slice)

| Action | DEVELOPER (unverified) | DEVELOPER (verified) | ADMIN (reviewer) | OWNER (TGP) |
|---|---|---|---|---|
| Create developer account | yes | yes (already) | n/a | n/a |
| Onboard Stripe Connect | yes | yes | n/a | n/a |
| Upload app draft | yes | yes | n/a | n/a |
| Install into sandbox org | yes (own sandbox) | yes (own sandbox) | yes (any) | yes |
| Install into production org | no | yes (after approval) | yes | yes |
| Submit for production review | yes | yes | n/a | n/a |
| Approve submission | no | no | yes | yes |
| Reject submission | no | no | yes | yes |
| Delist app | no | yes (own apps) | yes | yes |
| Ban developer | no | no | no | yes (OWNER only) |
| Sign manifest (KMS) | yes (own keys) | yes (own keys) | n/a | n/a |

## 3. Review SLA — OWNER_DECISION (recommended: 5 business days)

### 3.1 Options

#### Option A — 5 business days for new, 2 business days for verified updates (RECOMMENDED)

New app submissions reviewed within 5 business days. Verified-developer updates that do not change capability scopes: 2 business days.

Pros: aggressive enough to attract early devs; lenient enough to staff with ~1.0 FTE reviewer at launch (100 coach scale with ~20 apps).
Cons: requires commitment.

#### Option B — 10 business days flat

Easier to staff; slower onboarding.

#### Option C — "best effort"

No SLA commitment. Poor market signal.

### 3.2 Recommendation

**Option A**. Publicly-committed SLA. Missed SLA is tracked as an internal incident.

### 3.3 Fast-path

Capability-preserving updates (bugfix, copy change, screenshot update) from verified developers are eligible for a 24-hour fast-path if automated checks pass.

### 3.4 Escalation

If SLA is missed: developer can file escalation from the dev portal. Admin director is paged within 1 business day.

## 4. Developer portal surface

### 4.1 Pages

| Page | Purpose |
|---|---|
| `/dev` | Landing, doc links, start-here |
| `/dev/account` | Developer identity, legal info, tax forms |
| `/dev/connect` | Stripe Connect onboarding status |
| `/dev/keys` | KMS signing keys (list, rotate, revoke) |
| `/dev/apps` | List of own apps |
| `/dev/apps/<id>` | App detail, versions, analytics |
| `/dev/apps/<id>/versions/new` | Upload new version |
| `/dev/apps/<id>/sandbox` | Sandbox org management (free test coaches) |
| `/dev/apps/<id>/submissions` | Submission history + reviewer feedback |
| `/dev/apps/<id>/analytics` | Installs, revenue, churn |
| `/dev/apps/<id>/webhooks` | Webhook DLQ, delivery log |
| `/dev/apps/<id>/payouts` | Payout history (read-only mirror of finance) |
| `/dev/docs` | SDK reference, manifest spec |
| `/dev/policies` | Acceptable use, banned categories, review rubric |
| `/dev/support` | Support ticket surface |

### 4.2 Developer account states

| State | Meaning |
|---|---|
| registered | email verified, nothing else |
| onboarding | Connect onboarding in progress |
| unverified | can publish to sandbox, cannot publish to production |
| verified | has passed identity verification; can publish after review |
| suspended | admin-suspended; read-only access |
| banned | terminated; no access, payouts held pending investigation |

## 5. Submission flow

### 5.1 Sequence

```
DEV uploads manifest + signed bundle
   |
   v
/dev/apps/<id>/versions/new
  - manifest validator runs
  - bundle scan runs (static checks; see 5.2)
  - if errors, return inline
   |
   v
DEV installs into own sandbox org
  - sandbox org is a real coach org flagged sandbox=true
  - sandbox has 3 synthetic clients, 2 cohorts, 1 sub-coach
  - no real data
   |
   v
DEV iterates; when ready, clicks "Submit for review"
   |
   v
Submission row created (state=submitted)
   |
   v
Review queue (ADMIN)
  - automated checks re-run
  - reviewer works through checklist (Section 7)
  - reviewer may comment, request changes, reject, or approve
   |
   +-- approve ---> app state=approved; installable in production
   +-- request changes ---> state=changes_requested; dev iterates; resubmit
   +-- reject ---> state=rejected; dev can appeal once
```

### 5.2 Automated bundle scans

Static checks (no execution):

- Bundle size <= 5 MB gzipped for iframe assets; <= 10 MB for worker code.
- No known-malicious JS signatures (yara-style rules; curated by TGP security).
- No unapproved third-party trackers (e.g. analytics that aren't TGP).
- CSP-compatible (no inline `<script>` unless nonced).
- Worker code imports only allowlisted packages (SDK + declared libs).
- Worker network egress declared matches actual `fetch` callsites (AST scan).
- No PII in source strings (regex for SSN patterns, credit-card patterns, etc.).
- License file present.

Failures block submission with actionable diagnostic.

### 5.3 Version immutability

Once a version is published, its bundle is immutable. Patch to fix a typo = new version number. We do not support silent rewrites.

## 6. Reject-reason taxonomy

Reviewers pick from a controlled list. Free-text elaboration required.

| Category | Sub-reasons |
|---|---|
| **Manifest** | schema violation, unsigned, signature expired, capability scope unjustified, missing reason copy |
| **Privacy** | PII collected without subscope, privacy policy missing/inaccessible, data export endpoint missing, GDPR delete not honored |
| **Security** | leaked secrets in bundle, unsafe-eval, CSP violation, credential request in iframe postMessage, known-CVE dependency |
| **Quality** | broken install, crashes on load, illegible copy, localization broken, no support email responsive |
| **Policy** | banned category (see Section 9), misleading tagline, impersonation, trademark violation |
| **Billing** | paid app without Connect, suspicious pricing, refund policy missing, trial misrepresented |
| **Performance** | bundle too large, render blocks > 3s, worker exceeds CPU budget on synthetic load |
| **Psychology doctrine (Wave 10)** | public streak counter, noisy engagement metrics, dark pattern social proof, manufactured urgency |
| **Other** | reviewer elaborates; triage to specific category within 48h |

Each reject includes: category, sub-reason, reviewer notes, suggested remediation, appeal instructions.

## 7. Reviewer checklist

Reviewers tick each item. Automated where possible; manual where not.

### 7.1 Manifest
- [ ] Signature verifies (automated)
- [ ] Capability set is minimal for declared surfaces
- [ ] Capability reasons are specific and human-readable
- [ ] PII-touching capabilities flagged `pii: true`
- [ ] Egress allowlist is minimal and only includes third parties with published terms
- [ ] Cron expressions valid and reasonable (no `* * * * *`)

### 7.2 Surfaces
- [ ] iframe URLs load on `app-cdn.tgp.example`
- [ ] Worker URLs on `worker.tgp.example`
- [ ] All declared surfaces render without errors
- [ ] Navigation entries don't collide with TGP core nav

### 7.3 Monetization
- [ ] If paid, Connect account is live
- [ ] Price is reasonable and matches tagline/description
- [ ] Trial terms match description
- [ ] Refund policy is linked and readable

### 7.4 Quality
- [ ] Install -> boot -> first meaningful render under 2s on cold (p95)
- [ ] Copy passes reading-age check (grade 8 or lower)
- [ ] Screenshots match current version
- [ ] Support email reachable (test ping)
- [ ] Privacy policy and terms accessible

### 7.5 Security
- [ ] Bundle scan clean
- [ ] Known-CVE dependency check
- [ ] No secrets in bundle
- [ ] Worker respects wall-clock cap on synthetic 10x load
- [ ] postMessage envelope types match spec

### 7.6 Policy
- [ ] Not in banned category list
- [ ] No impersonation of TGP brand or existing verified dev
- [ ] Psychology doctrine check (Wave 10)

### 7.7 Sandbox proof
- [ ] Reviewer installs into a synthetic sandbox; app works end-to-end
- [ ] Uninstall works; GDPR wipe verified within 5 minutes

## 8. Sandbox lifecycle

### 8.1 Sandbox orgs

Each developer can provision up to 3 sandbox orgs. A sandbox org is a real org flagged `sandbox=true` with:

- 3 synthetic clients (seeded names like "Test Client One").
- 2 cohorts.
- 1 synthetic sub-coach.
- Retention engine emits synthetic events on a 24h cycle.
- Rewards engine has a default rule set.
- No real payments; Stripe test mode.
- No emails/SMS sent externally (captured and viewable in dev portal).

### 8.2 Sandbox -> production path

```
app state: draft
   |
   v (dev uploads version)
sandbox-only
   |
   v (dev clicks "Submit for review")
under-review
   |
   v (reviewer approves)
approved
   |
   v (in marketplace, real coaches can install)
```

### 8.3 Sandbox -> production data semantics

Installs in sandbox orgs cannot be promoted to production. Sandbox data is deleted on uninstall. Sandbox orgs cannot install production-only apps.

## 9. Banned categories

Apps in any of these categories are rejected regardless of execution quality.

| Category | Rationale |
|---|---|
| Multi-level marketing (MLM) recruiting | inconsistent with coaching integrity |
| Cryptocurrency trading advice or signal bots | regulatory risk; scam prevalence |
| Supplements/nutraceuticals sales with unverified health claims | FDA / MHRA / TGA exposure |
| Dark-pattern retention (e.g. "streak shaming", forced engagement loops) | Wave 10 psychology doctrine |
| Deepfake or impersonation tooling | integrity risk |
| Scraping of non-TGP platforms without their written permission | legal risk |
| Gambling or real-money gaming | regulatory |
| Adult content | platform tone |
| Weapons / firearms related | platform tone |
| Political advertising / targeted political outreach | policy |
| Any app that shares PII with a third party without explicit per-coach consent | privacy red line |
| Any app that attempts to take TGP's brand name, logo, or make "Official TGP" claims | impersonation |
| Extreme/fad diet apps (VLCDs, fasting beyond 72h recommended, etc.) that target medically sensitive users without clinical oversight | safety |

Borderline categories (AI coach impersonation, chatbots claiming therapist-equivalent advice, etc.) go to a policy committee for case-by-case review.

## 10. Trust ladder

| Tier | How to reach | What it unlocks |
|---|---|---|
| Unverified | register + email verify | sandbox only; no production installs |
| Verified | identity doc + Stripe Connect live + 1 approved submission | production installs; "Verified" badge |
| Partner | verified + 5+ apps with >= 100 installs + no policy violations in 12 months | fast-path 24h review, featured placement eligibility, direct reviewer channel |
| Platform Certified | partner + security audit + annual compliance review | "Platform Certified" gold badge, access to private APIs (if any), early-preview features |

Trust tier is visible to coaches at install time. Unverified-dev apps are hidden from the default marketplace (Wave 9) and only accessible by direct link.

## 11. Example app walkthrough — "Calendly Sync" from scratch

### 11.1 Day 1: dev account

1. Alice at "Acme Integrations" registers at `/dev/signup`.
2. Email verification.
3. Fills `/dev/account`: legal name, address, tax jurisdiction.
4. Starts Stripe Connect onboarding at `/dev/connect`. Uploads ID, bank info. Connect status: `pending` for 24h.
5. Provisions a KMS signing key at `/dev/keys`. TGP displays public key fingerprint.

### 11.2 Day 2: sandbox build

6. Creates "Calendly Sync" app at `/dev/apps`. App state: `draft`.
7. Writes manifest (see `manifest-spec.md` Example 1).
8. Writes iframe (TypeScript + React) and worker code (TypeScript + `@tgp/apps-sdk/worker`).
9. Uploads bundle + manifest to `/dev/apps/calendly-sync/versions/new`.
10. Manifest validator: passes. Bundle scan: passes.
11. App state: `sandbox-only`. Version: `1.0.0`.

### 11.3 Day 3-7: sandbox test

12. Provisions sandbox org.
13. Installs the app into sandbox from `/dev/apps/calendly-sync/sandbox`.
14. Hits Calendly (dev's own Calendly account) via the worker.
15. Validates: clients list appears, scheduled job runs every 15m, webhook on `client.created` fires.
16. Iterates on copy, screenshots.

### 11.4 Day 8: submit

17. Clicks "Submit for review". App state: `under-review`.
18. Review queue time: 5 business days.

### 11.5 Day 13: review

19. Reviewer Bob works checklist (Section 7).
20. Finds: "support_email not responding to test ping." Rejects with category=Quality, sub-reason=support_email_unresponsive.
21. Alice fixes (verifies her SMTP), resubmits.

### 11.6 Day 14: approval

22. Resubmission state: `under-review`. Fast-path eligible (verified dev, no cap changes? No: verified status still pending for Alice).
23. Reviewer approves. App state: `approved`.

### 11.7 Day 15: first install

24. Marketplace (Wave 9) surfaces the app.
25. Coach "Dana" installs. Install succeeds. App works. Alice sees install in `/dev/apps/calendly-sync/analytics`.

### 11.8 Month 2: bug

26. Calendly API changes response shape. Worker errors.
27. Detection: `/dev/apps/calendly-sync/webhooks` shows DLQ. Alice's support email is paged.
28. Alice releases 1.0.1 patch. Auto-upgrade `patch` is default, so existing installs pick it up within 1 hour.
29. Reviewer fast-path approves within 24h (verified dev, patch version, no cap change).

### 11.9 Month 4: monetize

30. Alice decides to charge $9/mo. Version 2.0.0. New manifest adds `monetization.model=subscription`.
31. Major bump; re-consent for existing installs. Opt-in upgrade.
32. Reviewer approves after price/Connect checks.

## 12. Schema deltas (illustrative)

```prisma
model Developer {
  id                       String   @id @default(cuid())
  user_id                  String   @unique
  display_name             String
  legal_name               String?
  contact_email            String
  stripe_connect_account_id String?  @unique
  state                    String   // "registered" | "onboarding" | "unverified" | "verified" | "suspended" | "banned"
  trust_tier               String   // "unverified" | "verified" | "partner" | "platform_certified"
  verified_at              DateTime?
  created_at               DateTime @default(now())
  updated_at               DateTime @updatedAt
}

model AppSubmission {
  id            String   @id @default(cuid())
  app_id        String
  version       String
  developer_id  String
  state         String   // "submitted" | "under-review" | "changes_requested" | "approved" | "rejected"
  reviewer_id   String?
  reviewer_notes String?
  reject_category String?
  reject_sub_reason String?
  submitted_at  DateTime @default(now())
  decided_at    DateTime?
  sla_deadline  DateTime

  @@index([state, sla_deadline])
  @@index([developer_id, submitted_at])
}

model SandboxOrg {
  id            String   @id @default(cuid())
  developer_id  String
  org_id        String   @unique
  created_at    DateTime @default(now())

  @@index([developer_id])
}
```

GDPR: `Developer` has personal data; on legal request we pseudonymize (`display_name` -> `"Developer <short_hash>"`, legal/contact info purged) while retaining submission + audit history for 7 years (legal/billing).

## 13. Failure modes (>=5)

### 13.1 Reviewer out-of-office, SLA missed

Detection: `sla_deadline < now()` on `submitted`/`under-review` state.
Recovery: auto-escalate to admin director; backup reviewer picks up.

### 13.2 Malicious bundle passes automated scan

Detection: out-of-band (bug bounty, post-install audit).
Recovery: emergency delist; all installs auto-suspended; security incident process.

### 13.3 Developer disputes rejection

Detection: dev files appeal.
Recovery: second reviewer + reviewer director. One appeal per submission.

### 13.4 Submission backlog > SLA for bulk

Detection: queue depth.
Recovery: TGP pauses new-dev signups; staffs additional reviewers; communicates delay publicly.

### 13.5 Sandbox org data bleed to production

Detection: data-feed query returns sandbox data in production context.
Recovery: hard enforcement: sandbox orgs have `sandbox=true` flag and all queries assert non-sandbox context for production APIs. Bleed is a P0 incident.

### 13.6 Developer stops responding; installs break

Detection: DLQ grows, support email bounces, analytics show errors.
Recovery: we notify coaches; app moves to `delisted`; we recommend alternatives; existing installs continue until coach uninstalls.

### 13.7 Developer identity compromised; attacker submits update

Detection: anomaly detection (geo, device, behavior).
Recovery: auto-hold update; verify via side channel (email/phone); rollback if malicious.

## 14. Audit (portal/review slice)

Every submission action is audited: submit, change state, reject (with category + sub-reason), approve, appeal, escalate. 7-year retention.

## 15. Performance budgets (portal/review slice)

| Operation | p50 | p95 |
|---|---|---|
| Manifest upload + validate | 200 ms | 800 ms |
| Bundle scan | 2 s | 10 s |
| Submission queue read (reviewer) | 100 ms | 300 ms |
| Approve | 100 ms | 300 ms |

## 16. Test plan (portal/review slice)

- **Unit**: state machine transitions; reject-category enum; SLA deadline calc.
- **Integration**: upload -> scan -> submit -> review -> approve -> install in sandbox -> install in production.
- **E2E**: run the "Calendly Sync walkthrough" (Section 11) as an automated test harness.
- **Policy**: synthetic malicious bundles must be rejected at the scan stage (yara rules kept fresh).

## 17. Migration / backfill

No backfill. New tables.

## 18. Rollback

Feature flags: `apps.developer_portal.enabled`, `apps.review.enabled`. Disabling freezes submissions but existing apps continue.

## 19. Senior-engineer onboarding (portal/review slice)

- [ ] Can walk a dev through account creation to first sandbox install in 15 minutes.
- [ ] Knows the 5/2 business-day SLAs and how to escalate.
- [ ] Can enumerate the reject-reason taxonomy without looking.
- [ ] Knows why the psychology doctrine (Wave 10) is a first-class reject category.
- [ ] Knows sandbox -> production is re-review, not promote.
