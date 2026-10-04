AUDIT GPT-6.1 Sol — growth-project-backend#684 @ 42e9ca13b0b365315fade00f0fce869f5e25834b — VERDICT: REQUEST CHANGES
A/B/C = 0/2/1

Independent **T4** audit of every F4 production/test change, purchase/refund/dispute entry points, scheduled recovery, notices, caller scoping, email rendering, module wiring and post-commit delivery boundaries. Two new acceptance failures are independently reproduced against the exact candidate plus one audit-only spec. [F4 scope/readiness](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/684#issuecomment-5975772634) [Independent executed probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171489417)

### Prior findings and evidence applicability

Sol B-627-6/7 and C-627-8 closures remain on their specifically fixed channel-retry, remaining-open-hold and atomic inbox/receipt boundaries; the later verdict records B-627-9 closed and B-627-10 assigned to the F2 orchestrator, not F4. Do not move F3 defects into this PR's counts; they require a lower-piece fix/restack. [Prior closure record](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/627#issuecomment-5962121921) [Prior Sol approval](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/627#issuecomment-5964131926) [Latest original Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/627#issuecomment-5972047312)

`git diff 7c29d981..42e9ca13` on all 22 F4 paths proves every file byte-identical to the original Sol-approved head except purchase-split handler (formatting and the two charge-locked attempt call-site changes) and four added/one removed sweep-test lines. Those deltas were read fully; prior evidence is reused for the closed invariants only, not to dismiss the new failures below. [Prior Sol approval/evidence](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/627#issuecomment-5964131926) [F4 candidate](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/684)

### B-684-1 — truncated charge refund lists permanently under-recover a fully refunded sale

**File:line:** `src/checkout/refund-dispute-handler.service.ts:228–261,493–511,593–608`. The handler ingests only embedded refund rows, while the new settlement bridge passes only the sum of locally known rows; the charge's canonical cumulative `amount_refunded` is used to revoke access but never supplied to this settled charge's money convergence. Replays then skip the already-marked rows. [Refund and settlement bridge](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/42e9ca13b0b365315fade00f0fce869f5e25834b/src%2Fcheckout%2Frefund-dispute-handler.service.ts)

Stripe embeds only the **10 most recent refunds** on a Charge by default. [Stripe refund-list contract](https://docs.stripe.com/api/refunds/list)

**Counterexample:** an already settled USD 49 sale has eleven dashboard partial refunds: an older USD 9 plus ten recent USD 4 refunds. First delivery after the missed earlier events carries `amount_refunded=4900`, the latest ten rows totaling 4000 and `has_more=true`. After **two deliveries**, access is revoked as fully refunded but the real settlement remains **`refunded_cents=4000` rather than 4900**; its USD 6.30 remaining coach target is wrong and the usual USD 2.70 fee recovery is not reached. The complete-list/full-refund/idempotent replay control passes. [Executed truncation failure/control](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171489417)

**Minimal fix rule / verification:** establish a complete canonical succeeded-refund total independently of the embedded page, and converge once under the charge lock even when all embedded rows were previously marked; preserve per-refund identity and alerts. With the F3 FX fix, normalize actual balance debits to the settlement currency rather than blindly passing presentment cents. Prove more-than-ten refunds, missed/out-of-order deliveries, duplicate pages, refunds racing settlement/admin calls, and late recovery after every embedded row was already applied; keep partial/full entitlement controls.

### B-684-2 — notice-delivery errors export message/body text to centralized logs

**File:line:** `src/checkout/payout-notice.service.ts:297–299,357–360,412–416,449–452`; related newly introduced wrapper/cron catches also append raw messages. The notice dispatcher logs arbitrary notification/DB/email error text rather than a closed diagnostic code; the email path directly appends `res.error` after reading the payee's email/name and constructing the notice message. [Notice failure boundaries](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/42e9ca13b0b365315fade00f0fce869f5e25834b/src%2Fcheckout%2Fpayout-notice.service.ts)

**Counterexample:** make only the in-app notification write reject with a synthetic body/contact canary. The actual refund-to-notice dispatcher correctly leaves `inapp_status=failed`, but emits **`SFEE_NOTICE_INAPP_FAILED ... AUDIT_NOTICE_BODY_contact_at_example_invalid`** verbatim. This is a distinct F4 egress boundary from F2's closed B-627-10 park-failure logger. [Executed notice-log failure](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171489417) [Original F2 fix scope](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/627#issuecomment-5972269313)

**Minimal fix rule / verification:** log IDs and fixed diagnostic codes with a closed unknown fallback, never error message/name, arbitrary provider code, message bodies or addresses. Preserve per-channel retry/receipt behavior and actionable next-step copy; add DB-input and email-recipient/body canaries at these new catches, including returned email provider failures.

### C-684-1 — inexpensive first-person copy cleanup

**File:line:** `src/email/templates/coach-payout-adjustment.hbs:20` says “We take it out…” and `src/checkout/payout-notice.service.ts:543` says “We could not find…”, contrary to the supplied product-copy rule. Reading a held-balance email or triggering a missing/cross-account notice is the concrete path that displays these strings. [Email copy](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/42e9ca13b0b365315fade00f0fce869f5e25834b/src%2Femail%2Ftemplates%2Fcoach-payout-adjustment.hbs) [404 recovery copy](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/42e9ca13b0b365315fade00f0fce869f5e25834b/src%2Fcheckout%2Fpayout-notice.service.ts)

**Minimal fix rule:** neutral wording, e.g. “The held amount comes out of the next payout…” and “Payout notice not found for this account. Refresh Money to see current notices.” Keep the useful next action and add a narrow copy guard; include this cheap C with the required fix round.

### CI and boundary

Independent one-job CI, source = this head plus one probe spec (workflow head `43f0d5dd1c35eb95363234e26ee6e23e8c5713e2`), reports **2 failed acceptance assertions / 31 passed controls** across the new probe and purchase-split, sweep and reconciliation suites; there were no TypeScript/fixture errors. The actual services are exercised with synthetic persistence/Stripe/notification boundaries, not live customer or provider data. [Executed independent CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171489417)

Candidate build passes **716 suites / 12,354 tests**, with 23 skipped suites, 239 skipped tests and five todo not counted as acceptance; all applicable exact-head checks are green, while CodeQL/danger/banned-cast/SBOM contexts remain a main-only assembled-stack gate. [Exact F4 build](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37151663653/job/111286640886) [Operator check/landing contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/684#issuecomment-5975772634)

Caller-owned adjustment listing/acknowledgement and deferred push/email after webhook commit remain intact, and F4 imports only earlier-piece files; this is still a coupled stack, not permission to land/deploy F4 alone. Preserve rule-11 atomic landing and mobile #321 pairing after all material findings and exact-head dual gates close. [F4 landing contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/684#issuecomment-5975772634)
