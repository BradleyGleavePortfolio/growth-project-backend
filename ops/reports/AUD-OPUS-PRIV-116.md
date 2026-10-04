# AUD-OPUS-PRIV-116 (lens: Claude Opus 5.5, agent 116 wave) — backend #611, then mobile #315

Job: JOBS.md "AUD-OPUS-PRIV-116 / AUD-SOL-PRIV-116".
- Notes, the posted verdict text and the probe spec are in `/home/user/workspace/ops/aud-116/AUD-OPUS-PRIV-116/`: `verdict_611_5eac8f21.md`, `audit-opus-611-retention-probe.spec.ts`, `c611.json`.
- The worktree `/home/user/workspace/wt/AUD-OPUS-PRIV-116-1` has been removed.
- The audit branch `audit/AUD-OPUS-PRIV-116/611-retention` has been deleted. Its run URL still works.

## backend #611 @ 5eac8f21bb70460da7dea7be5ce9f84f40870afb (FIX ROUND 7, B-MOB-A agent 115)

- Claim: `claims/backend-611-5eac8f21-opus`.
- **Verdict: REQUEST CHANGES, A/B/C = 0/2/5:** https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/611#issuecomment-5975902540
- **Probe:** https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171843303. It ran on the exact head plus the probe spec only. The control test passed and 4 finding tests failed, as expected.
- **Sol at the same head:** REQUEST CHANGES 0/1/0, B-611-7 ([5975837459](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/611#issuecomment-5975837459)). The policy says crash reports include the email address. My C-611-12 is the same defect, and one fix closes both.

### What was verified
- **Purity.** `d280d73e` is a pure merge of main `0d33c4d4`. Its tree `f369d37e` equals the merge-tree output.
- **Failing-before run.** [37144067930](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37144067930) is genuine: commit `9e383055` is `d280d73e` plus the spec plus the lane workflow, with 6 failed and 1 passed.
- **CI.** All 11 required checks pass at the head. The branch is BEHIND main `d23fa317`.
- **O-611-1.** The approved paragraph is byte-identical. The in-app deletion path exists (mobile #313, `e3986e8`).
- **O-611-2.** Calls go directly through `@anthropic-ai/sdk` with the default base URL, and the code uses no Files API or batches. [Anthropic's retention article](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data) gives 30 days, with exceptions for the Files API, ZDR, Usage Policy enforcement and the law. The sentence is true.
- **O-611-3.**
  - `createDirectUpload` sends only the playback policy and `cors_origin` (`src/video/mux.service.ts:84-103`).
  - Signed playback tokens carry only the playback id, `aud`, `exp` and `kid`.
  - Uploads come from coaches and owners. Devices connect to Mux directly (C-611-13).
- **O-611-4.** Supabase Free has no scheduled backups. Sentry's backups last 30 or 90 days and Resend's 7 days, all inside six months.
- **O-611-5.**
  - Stripe redaction jobs exist.
  - Sentry Team keeps errors 90 days.
  - Resend keeps data 30 days on every plan.
  - PostHog recording is off in code: there is no replay package, and the provider gets only `{ host }`.
- **O-611-6.** The text matches Apple 5.1.3(i). The RCW wording is slightly narrower than the statute (C-611-15).
- **Main merges.**
  - #608's final head `be6b5841` is still consistent with the deletion paragraph. I checked it against `bdadfcb4`: HMAC r2 receipt still drained at 30 days, workspace bans, voice erasure, data-export archives deleted.
  - No new vendor arrived in the merge. Cloud wearables and bloodwork are still off by default.

### Open findings (for the FIX ROUND 8 builder, B-611-116)

**B-611-10.** The "What we keep, and for how long" list on `/help/delete-account` (`help-pages.html.ts:713-721`) is missing four items that `/privacy` (`trust-pages.html.ts:259`) and #608 keep:
- the closed-account record;
- the provider ID while its removal is retried, then the 30-day one-way code;
- Anthropic's 30-day copy;
- de-identified aggregates.

Fix: mirror the Privacy wording through shared constants, plus a spec. Probe tests B-611-10a/b/c fail at `5eac8f21`.

**B-611-11.** The dump step in `docs/deploy-runbook.md:187-202` (§2 step 3) and `:284` (§3 step 1) says "store somewhere durable (1Password, S3 bucket, etc.)" with no deletion rule. That contradicts the published and ADOPTED 30/90-day limits in procedures §1.1. Fix:
- put the §1.1 rules in both steps;
- link §1.1 and drop "S3 bucket, etc.";
- point the business continuity plan's weekly export (lines 97-105) to §1.1, and note that a versioned bucket needs noncurrent-version expiry.

Probe test B-611-11 fails at `5eac8f21`.

**C findings (cheap; should be closed in the same round):**

| ID | Where | Problem | Fix |
|---|---|---|---|
| C-611-12 (= Sol B-611-7) | `trust-pages.html.ts:154` | Says crash reports include the email address | Account ID only; also fix the stale PR-body Sentry row |
| C-611-13 | `trust-pages.html.ts:226` | Mux also receives the uploader's and viewer's IP address and device type | Add one sentence saying so |
| C-611-14 | `trust-pages.html.ts:250` | PostHog clears events asynchronously on weekends, so "removed within 30 days" can slip | Set the owner deadline in procedures §8 to 21 days |
| C-611-15 | `trust-pages.html.ts:51` | RCW 19.373.010(10)(b) says "process"; the text says "keep" | "keep and use it only in de-identified form" |
| C-611-16 | `trust-pages.html.ts:258` | "Your information is kept while your account is open" is absolute | Start with "Unless a shorter period is listed above," |

**How the next lens verifies:**
- B-611-10 and B-611-11: the probe spec is saved here. Re-run it on the FIX ROUND 8 head; all 5 tests must pass.
- C items: read the changed sentences.
- Also check that the owner-approved deletion paragraph is still byte-identical.

### Release gates (operator/owner decisions)

**RG-1: Apple revocation.** `trust-pages.html.ts:259` says "If you used Sign in with Apple, we ask Apple to revoke TGP's access."
- This is false in production until `APPLE_TEAM_ID`, `APPLE_SIGNIN_KEY_ID` and `APPLE_SIGNIN_PRIVATE_KEY` are set. Until then #608 returns `not_configured`, and procedures §9 says the key has not been created.
- **Recommended default:** the owner creates the Sign in with Apple key and sets the secrets before the deploy that publishes #611. App Store 5.1.1(v) requires revocation anyway.
- **Alternative:** make the sentence conditional until the key exists.

**RG-2: unverified rows.** These procedures §9 rows are still unverified: Supabase log retention, Fly log stream, Crisp in the production build, Perplexity flag. None makes a published sentence false.

### Cross-PR note for the operator (not a finding on #611)
- `/terms` "Subscriptions and billing" (`trust-pages.html.ts` around line 500) says "cancellation takes effect at the end of the current billing period" and "Refunds are handled on a case-by-case basis".
- Those sentences will need updating when the dunning stack and the trials stack land:
  - dunning 2A: a cancel during dunning ends access at once;
  - trials: card up front, plus a trial-ending notice;
  - OR-111-1: refund handling.
- Whichever lands after #611 should update `/terms`.

## mobile #315 @ 8fff3f8f3829aab4079973b38428e2d266bc3f3b — not re-audited (no refreshed head yet)
- **Head state:** dual APPROVE at `8fff3f8f`, BEHIND main.
- **Pre-check for the merge-only delta lens:** the links in #315 match the paths #611 serves.
  - #315 `src/screens/trustCenterLinks.ts` uses `PRIVACY_POLICY_URL` = `https://app.trygrowthproject.com/privacy` and `CONSUMER_HEALTH_POLICY_URL` = `https://app.trygrowthproject.com/consumer-health-privacy`, from mobile `src/config/env.ts:69-71`.
  - #611 serves `@Get('privacy')`, `@Get('consumer-health-privacy')` and `@Get('help/delete-account')` (`public-pages.controller.ts:106,190`).
  - `src/main.ts` excludes all three from the `/api` prefix, so they resolve as bare paths on `app.trygrowthproject.com`.
- **At the refreshed head:** confirm `git diff 8fff3f8f <new>` adds only main's commits plus any conflict hunks, and that those constants and paths are unchanged.

## HANDOFF
**backend #611**
- Head: `5eac8f21bb70460da7dea7be5ce9f84f40870afb`.
- Verdicts at this head: Opus REQUEST CHANGES 0/2/5 ([5975902540](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/611#issuecomment-5975902540)) and Sol REQUEST CHANGES 0/1/0.
- Builder B-611-116 is running FIX ROUND 8 (B-611-7, the Opus findings, a main merge).
- **Next:**
  1. B-611-116 closes B-611-10, B-611-11, Sol B-611-7 and C-611-12..16, each with a failing-before test.
  2. A fresh Opus lens audits the FIX ROUND 8 head as a T4 delta from `5eac8f21`, using this report and the saved probe spec.
  3. After a dual APPROVE, the operator refreshes #611 and #315 with main, and the lenses post merge-only delta verdicts.
  4. The operator decides RG-1 before the publication deploy.

**mobile #315**
- Head: `8fff3f8f`, dual APPROVE, BEHIND.
- No verdict from this job; the condition (both lenses APPROVE #611) was not met.
- **Next:** a refresh with main after #611 is dual APPROVE, then merge-only delta verdicts using the pre-check above. #315 and #611 merge together.

**This job ended** after posting the #611 verdict. The STAY condition (both lenses APPROVE at 5eac8f21) cannot be met at this head, and later fix-round heads go to a fresh lens (`_COMMON` §8).
