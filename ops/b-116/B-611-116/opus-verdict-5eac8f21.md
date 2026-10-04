AUDIT Claude Opus 5.5 — growth-project-backend#611 @ 5eac8f21bb70460da7dea7be5ce9f84f40870afb — VERDICT: REQUEST CHANGES
A/B/C = 0/2/5

Lens AUD-OPUS-PRIV-116 (agent 116 wave). T4 audit of FIX ROUND 7 ([5972222465](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/611#issuecomment-5972222465)). I read every changed line in `1af96efa..5eac8f21`, then re-checked the rest of the public text against code and vendor terms at this head. My findings below were formed before I read Sol's RC at this head ([5975837459](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/611#issuecomment-5975837459)). Where they overlap, I say so.

**Two B findings, both cheap copy and doc fixes.**
- B-611-10: the account-deletion help page lists less retained data than the Privacy Policy.
- B-611-11: the runbook step that creates database dumps does not carry the 30/90-day limit now published.

All six owner answers (O-611-1..6) are otherwise true as written.

Probe: [run 37171843303](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171843303) ran on the exact head plus one probe spec (`audit/AUD-OPUS-PRIV-116/611-retention`). The control test passes and the 4 finding tests fail.

### Prior findings (this lens)
- None open. C-611-8 and C-611-9 are closed (my APPROVE at `1af96efa`, [5964262236](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/611#issuecomment-5964262236)).
- Sol's B-611-2..6 closures still hold at this head.

### B-611-10 — `/help/delete-account` "What we keep, and for how long" is incomplete
**Where:** [help-pages.html.ts:713-721](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5eac8f21bb70460da7dea7be5ce9f84f40870afb/src/public-pages/help-pages.html.ts#L713-L721).

**Counterexample.** This page is the web deletion resource for Google Play. Under the heading "What we keep, and for how long", it lists only:
- Stripe records;
- one deletion record;
- the coach's clients;
- backups;
- security logs.

The Privacy Policy published at the same time ([trust-pages.html.ts:259](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5eac8f21bb70460da7dea7be5ce9f84f40870afb/src/public-pages/trust-pages.html.ts#L259)) and #608 as merged also keep two things the help page leaves out:
1. The closed-account record: internal id, account type and dates, with no expiry. This is the tombstone `User` row in `account-deletion.service.ts`.
2. The sign-in provider's account ID while its removal is retried, then a one-way code for 30 days. This is `deletion-receipt.ts`, keyed r2 since C-608-7 and still drained by the cron after `DELETION_RECEIPT_DAYS = 30`.

Round 7 added two more post-deletion facts to both policies but not to this page:
3. Anthropic's copy is kept up to 30 days, or longer for Usage Policy enforcement or the law.
4. De-identified, aggregated information may be kept.

A person who deletes and reads this page is told less is kept than actually is. This is the same class of defect as Sol's B-611-2, which was fixed on `/privacy` only.

**Fix rule:**
- Add these items to the help list in the Privacy Policy's wording. Share the strings as exported constants so the pages cannot drift; `DEIDENTIFIED_TEXT` already exists.
- Optionally add the vendor windows: Sentry 90 days, Resend 30 days, PostHog within 30 days.
- Do not edit the owner-approved Privacy paragraph.

**Verify:** add a spec asserting that the help page's "What we keep" section contains every item `/privacy` says is kept. Probe tests B-611-10a/b/c fail at this head.

### B-611-11 — the dump step in the deploy runbook contradicts the published dump limits
**Where:** [deploy-runbook.md:187-202](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5eac8f21bb70460da7dea7be5ce9f84f40870afb/docs/deploy-runbook.md#L187-L202) (§2 step 3) and :284 (§3 step 1). Both say "Store the dump somewhere durable (1Password vault attachment, S3 bucket, etc.)". There is no deletion rule, and any number of locations is allowed.

**Counterexample.** Round 7 publishes on three pages: "Copies of the database made before an update to the service are deleted 30 days after the update is verified, and never kept beyond 90 days." Those pages are `trust-pages.html.ts:247`, `help-pages.html.ts:719` and the consumer-health Deletion section.

Procedures §1.1 is now marked ADOPTED. It requires one owner-controlled location, deletion at 30 days, a 90-day maximum and a monthly check. But §1.1 itself quotes the runbook's "S3 bucket, etc." line as the current fact. Someone who takes a dump by following the runbook gets none of these rules. A published retention promise has to appear in the procedure that creates the copy.

**Fix rule:**
- Make §2 step 3 and §3 step 1 state the §1.1 rules:
  - one owner-controlled location, each dump named with its date;
  - delete it 30 days after the deploy is verified;
  - never keep it more than 90 days;
  - check the stored dumps monthly.
- Link `docs/privacy/vendor-deletion-and-backups.md` §1.1 and drop "S3 bucket, etc.".
- Point the weekly export in `docs/soc2/policies/business-continuity-plan.md:97-105` to §1.1 as well. A versioned S3 bucket also needs noncurrent-version expiry, or old versions outlive the 90-day lifecycle rule.

**Verify:** probe test B-611-11 fails at this head because the dump step has no "30 days" or "90 days".

### C (optional; cheap ones should be closed in the same round)
- **C-611-12: Sentry "and email address"** ([trust-pages.html.ts:154](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5eac8f21bb70460da7dea7be5ce9f84f40870afb/src/public-pages/trust-pages.html.ts#L154)).
  - Mobile main `367e6c48` `src/services/sentry.ts:169` sends `setUser({ id })` only. The backend sets no Sentry user (`src/observability/sentry-config.ts`), and `sendDefaultPii` stays at its default, which is off.
  - The sentence overstates, which is the safe direction. Fix: "that include your account ID".
  - This is the same defect as Sol's B-611-7, and one fix closes both. Also correct the PR-body vendor row that still shows `setUser({ id, email })`.
- **C-611-13: Mux also receives viewer IP and device** ([trust-pages.html.ts:226](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5eac8f21bb70460da7dea7be5ce9f84f40870afb/src/public-pages/trust-pages.html.ts#L226)).
  - The upload API call is clean. `mux.service.ts:84-103` sends only the playback policy and `cors_origin`, and the tokens carry only the playback id.
  - But devices upload straight to the Mux upload URL and play from `stream.mux.com` (mobile `src/utils/workout/exerciseMedia.ts:44`). So Mux receives the uploader's and the viewer's IP address and device type.
  - Fix: add "When a video is uploaded or played, the device connects to Mux directly, so Mux also receives its IP address and device type."
- **C-611-14: PostHog "removed within 30 days"** (`trust-pages.html.ts:250`; procedures §8 gives the owner 30 days).
  - PostHog clears event data asynchronously, "weekends on PostHog Cloud" ([PostHog: data storage](https://posthog.com/docs/privacy/data-storage)). A deletion run on day 28-30 can finish after day 30.
  - Fix: set the owner deadline in §8 to 21 days and keep the public wording.
- **C-611-15: RCW 19.373.010(10)(b) wording** (`trust-pages.html.ts:51`).
  - The statute requires a public commitment "to process such data only in a deidentified fashion" ([RCW 19.373.010](https://app.leg.wa.gov/RCW/default.aspx?cite=19.373.010)). The text says "keep it only in de-identified form", and "keep" is narrower than "process".
  - Fix: "to keep and use it only in de-identified form".
- **C-611-16: "Your information is kept while your account is open."** (`trust-pages.html.ts:258`).
  - The sentence is absolute. The list just above it gives shorter periods: food search 24 hours, Sentry 90 days, Resend 30 days. The person can also delete Roman conversations or specific data at any time.
  - Fix: "Unless a shorter period is listed above, your information is kept while your account is open."

### Checked and true at this head
- **Purity.** `d280d73e` is a pure merge. Its tree `f369d37e` equals `git merge-tree --write-tree 1af96efa 0d33c4d4`.
- **Failing-before run.** [37144067930](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37144067930) is genuine: commit `9e383055` is `d280d73e` plus the spec plus the lane workflow, with 6 failed and 1 passed.
- **O-611-1.** The approved paragraph is byte-identical; only a new paragraph is placed before it. The in-app path exists (mobile #313, `e3986e8`, `DeleteAccountScreen`), and the email path is on `/help/delete-account`.
- **O-611-2.** Calls go directly through `@anthropic-ai/sdk` with the default base URL (`src/ai-egress/provider-clients.ts:14`). The code uses no Files API and no batches.
  - [Anthropic's retention article](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data) says "within 30 days ... except" for the Files API, ZDR, Usage Policy enforcement and the law. The sentence matches.
- **O-611-3.** Mux is live (fly-env-truth 37143727833). Uploads send no metadata, and #608 deletes Mux assets. The README vendor rule is updated.
- **O-611-4.** Supabase Free has no scheduled backups. Sentry's own backups last 30 or 90 days and Resend's 7 days, all inside six months. "Rolling schedule" and "overwritten" are gone from all three pages, and a test pins that.
- **O-611-5.**
  - Stripe redaction jobs exist ([Stripe docs](https://docs.stripe.com/privacy/redaction)).
  - Sentry Team keeps errors 90 days ([Sentry docs](https://docs.sentry.io/security-legal-pii/security/data-retention-periods/)).
  - Resend keeps data 30 days on every plan ([Resend GDPR](https://resend.com/security/gdpr)).
  - PostHog recording is off in code: `App.tsx` `PostHogProvider` takes only `{ host }`, and there is no session-replay package.
- **O-611-6.** The health-use sentence matches [Apple 5.1.3(i)](https://developer.apple.com/app-store/review/guidelines/). Mobile analytics events carry no health values.
- **Main merges.**
  - #608's final head `be6b5841` is still consistent with the deletion paragraph. I checked it against `bdadfcb4`, my last check: HMAC r2 receipt, ban rows, voice erasure, data-export archives deleted by the storage service.
  - The erasure-manifest coverage spec runs green in build-and-test.
  - `53b6d472..0d33c4d4` adds no new vendor; `appleid.apple.com` is already named. Cloud wearables and bloodwork are still off by default.
- **CI.** All 11 required checks pass at this exact head.
- **Evidence reuse (G09).** Text unchanged since `1af96efa` rests on this lens's APPROVE there, except where facts outside the PR moved (#608 final, mobile #330). I re-checked those above.

### Release gates (operator/owner; not code findings)
- **RG-1 (decide before the publication deploy).** `trust-pages.html.ts:259` says "If you used Sign in with Apple, we ask Apple to revoke TGP's access."
  - #608 returns `not_configured` unless `APPLE_TEAM_ID`, `APPLE_SIGNIN_KEY_ID` and `APPLE_SIGNIN_PRIVATE_KEY` are set (`apple-token-revocation.service.ts:69-73`). Procedures §9 says the key is not created.
  - Recommended: the owner creates the key and sets the secrets before the deploy that publishes these pages. App Store 5.1.1(v) requires revocation anyway.
  - Otherwise the sentence is false for every Apple user until the key exists.
- **RG-2.** These §9 rows are still unverified: Supabase log retention, Fly log stream, Crisp in the production build, Perplexity flag. None of them makes a published sentence false; at most the policy discloses more than happens.
- **Branch.** The branch is BEHIND main `d23fa317`. The operator runs update-branch after the fix round, and mobile #315 is refreshed with it.

No push to the PR branch, merge, dispatch outside the CI lane, or production action by this lens.

