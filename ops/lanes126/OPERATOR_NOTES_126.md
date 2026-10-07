# OPERATOR_NOTES_126 (agent 126 running log for the handoff)
- 18:00 Fly logs (run 37555057997) confirm double scheduler: NudgeScheduler logs twice same second at 00:45:00Z and 01:00:00Z;
  SettlementSweepCron at 01:00:00Z: one copy SFEE_SWEEP_DONE, other SFEE_SWEEP_SKIPPED_LOCK_HELD (single machine); drip skip each minute.
- 18:0x Production read-only counts (all-time): ClientPurchase 0, Invoice 0, ChargeSettlement 0, ChargeRefund 0, ConnectTransfer 0,
  DunningAttempt 0, DunningNoticeDelivery 0, PaymentReminder 0, SplitLedgerEntry 0, Notification 0, PushOutbox 0, EmailSendLog 0,
  NudgeLog 0, WorkoutReminderDelivery 0, CoachSubscription 1, NotificationDigestLog 6 (one per day/kind, no duplicates, all failed:
  Resend 403 domain not verified, last 2026-10-06 06:00Z = before owner's Resend fix 12:02 PDT 10-06). auth.users 5. ScheduledDrop 0.
- 18:07 b#808 merged by merge loop (dual APPROVE @ 9487faa2).
- 18:13 AUD-MJ-SETTLE-126: SAFE 23 / UNSAFE 0. Q0 run: all 14 unique indexes it relies on exist in production. Q1-Q11 trivially 0
  (all settlement/ledger/transfer/refund tables empty).
- TODO operator: check NotificationDigestLog after 2026-10-07 06:00Z (23:00 PDT) for status=sent (Resend fix).
- 18:16 AUD-MJ-DUNNING-126: 12 SAFE / 0 UNSAFE but assumed FEATURE_DUNNING_V2 off (stale line in _COMMON_126 copied from 125; fixed).
  v2 is ON in production (b#762 merged; env-sync apply run 37532040631 at 21:11Z). Auditor re-queued for the v2-on paths.
- 18:20 SAFE-AIB-PRE-126: b#808 clean (merged 2df556b7). m#439 B1 (approve response parsed as error) + B2 (shorten/explain/reorder
  fail) -> B-AIB5P-126 (hard stop 19:15). b#809 B3 (model-marker hash mismatch after DB round trip; head coach w/ sub-coach refused)
  + U1 -> B-AIB2-126. B4 (sub-coaches can never use Ask AI) -> OWNER DECISION (default: status+propose 404 for sub-coaches on 10-07,
  full support v1.1). LM lenses told not to approve m#439 @ 63417260.
- 18:17 AUD-CRONX-126: 39 timed jobs; money all guarded; U1 nudges (deferred quiet-hour nudge delivered twice at 08:00), U2 coach
  red-risk alert twice; both vanish with B-CRON. Production: Q3 canary = CoachEffectivenessScore 2 rows/night for 1 coach on all 30
  nights (09-07..10-06) -> double run proven in history. CoachAlert 0 rows, Notification 0, NudgeLog sent 0, PtmPrediction 0 ->
  zero duplicate user-facing notifications actually sent. Canary rows are internal scores (C; no customer data changed).
- 18:15 FU-COPY-126: m#440 READY @ 48348a62 (364 lines, CI green) -> LF lenses.
- 18:18 AUD-MJ-PAYOUT-126: 15 SAFE / 0 UNSAFE; payout tables empty -> its Q1-Q6 trivially 0. B-CRON PR = b#810.
- 18:20 AUD-MJ-DUNNING-126 redo (v2 on): 10 SAFE / 0 UNSAFE. Dunning tables all 0 rows; StripeProcessedEvent 0 (no Stripe webhooks processed yet) -> Q8-Q13 trivially 0.
- 18:21 AUD-MJ-BILL-126: 15 SAFE / 2 UNSAFE (guest welcome email can send twice; no money). Outside scope: guest charged w/o account on slow pay/decline retry (unverified). GuestCheckout 0 rows in prod. -> B-GUEST-126 launched.
- 18:24 FU-CHECKIN-126: m#442 READY @ 4ecb5e4b (579 lines, CI green), U=5 fixed. Post-launch T4: check-ins.service.ts:379 authorise mark-reviewed by client ownership (pre-coach check-ins, sub-coaches).
- 18:28 merged-today recount from GitHub (mergedAt >= 07:00Z, base main): backend 54 + mobile 45 = 99; none to other bases. Agent 125's 95 was 3 low.
- 18:28 FU-BOOK-126: m#445 READY @ 559999b2 (448 lines, CI green), U=3. B-AIB5P-126: m#439 READY @ 030e5721 (798 lines, CI green), B1/B2
  fixed with real b#809 shapes; accepts old+new. b#809 now 8b82ead8; subset approve + lock_token reply moved to stacked draft b#815
  (b83e0357). RULE: merge b#809 and b#815 together before FLIP (else unticked changes still apply). Sub-coach B4 still owner decision.
- 18:30-18:34 merged (dual APPROVE + green): b#810 (scheduler), b#812 (Day-1 saves backend), m#440 (copy), m#442 (check-ins),
  m#444 (workout logging), m#445 (booking). Deploy of 27b1c8c8 (b#808+b#810) FAILED the release evidence gate at 18:31: main CI run
  2975 still 'queued' (known 20-40 min drain). Re-dispatch when main CI completes. Background merge loop died silently at 18:13 (token
  env expired in the detached process) -> replaced with ops/lanes126/sweep.sh, run inline from an operator bash call with the github
  credential every few minutes.
- 18:32 WAVE 2 launched (9 agents): B-EMAILFROM-126, AUD-MONEY-E2E-126, FU-FOODLOG2-126, FU-WORKLOG2-126, AUD-E2E-CLIENT-126,
  AUD-E2E-COACH-126, B-AIBFUN-126, LX-OPUS-126, LX-SOL-126.
- 18:36 OWNER: sub-coach Ask AI hidden on 10-07 (status+propose 404), full support = v1.1 scope. B-AIBSUB-126 launched.
- 18:40 B-GUEST-126: b#816 READY @ 16d16028 (316L, CI green). B1 guest charged w/o account FIXED; U1 double welcome email FIXED. Follow-up after launch: recurring-package welcome email may send before payment (billing.service.ts:706-722, :808-816).
- 18:45 FU-FOODLOG-126 B2 (real launch B): non-owner coaches see nothing for food/workouts/weights/habits (consent.service.ts:328-336; no app surface grants FITNESS_* scopes; owner role bypasses, so owner never saw it). B-SHARE-126 launched to build explicit-consent screen + settings toggles; HELD for owner approval. Also device-pass item: iPhone portion picker may open behind Add Food sheet.
- 18:47 B-AIB2-126 split done: b#809 @ 8b82ead8 (785L, green, Opus APPROVE, needs Sol) + b#815 @ b83e0357 (171L, stacked; carries B3
  fix + subset approve + lock_token). MERGE ORDER: b#809 first, then retarget b#815 to main. Both before FLIP.
- 18:48 B-R11C-126: b#811 @ e1d804b7 (75L) + m#446 (merged 18:37). Backend adds memory_on so the v5 offer only shows when
  FEATURE_ROMAN_MEMORY=true; accepted. m#447 (food logging) merged 18:43.
- 18:56 OWNER: 32k/45k used, "stop-and-drain to 6 agents", then "DO NOT CANCEL AGENTS / LET THEM FINISH AND THEN DO NOT START NEW
  WORK". So: nothing cancelled, no new workers launched from here; fleet drains by attrition. Lens pairs told to finish their queues
  (verdicts are what unblock merges), everything else finishes on its own. Operator does the remaining work directly.
- 18:56 AUD-MONEY-E2E-126 B1 (coach approved by Stripe still shows as unable to take payments) -> B-CONNECT-126 building. Production
  read-only: zero Connect/payout events ever processed (StripeProcessedEvent has no account.updated/capability.updated/payout.*), and
  zero ConnectAccount rows with charges/payouts disabled, so no coach is affected today - the fix is pre-launch insurance.
- 18:56 AUD-E2E-CLIENT-126 B-1 (launch blocker): client taps Start on a coach-assigned workout and nothing happens
  (WorkoutAssignmentDetailScreen.tsx:110 expects one navigator level too many; both tests pass only because their fake navigator has
  that extra level). Operator builds it with U-1/U-2/U-3 copy fixes as one small mobile PR before the APK.
- 19:10 LAUNCH BLOCKER found by AUD-E2E-COACH-126 (B3), verified by me: production HAS BILLING_ENFORCEMENT set (read-only Fly Env
  Truth run 37559943231: registered/present/non-empty, bucket 1-7), left from the 2026-04-30 fly-secrets-set run. Only 1
  CoachSubscription row exists (tier free, status active, role coach). In enforce mode SubscriptionGuard 403s every non-owner coach on
  /coach/ai/* , /v1/coach/ai/draft/* and /workout-programs/* (fork, clone, clone-to-client, PROGRAM ASSIGNMENTS). Owner bypasses, so
  the owner never saw it. deploy-runbook 3.2 says it must stay unset during the Stripe rollout. -> operator PR b#822 manages it in the
  manifest as "unset" + ENV_RULES closed set + removes it from fly-secrets-set.yml + runbook kill row. Spec 69/69. NOT applied yet:
  owner is told before the fly-env-sync apply.
  Also from env truth: EMAIL_FROM_ADDRESS and RESEND_FROM_EMAIL are both PRESENT and non-empty (32-63) and EMAIL_DIGEST_*_ENABLED are
  present (duplicate group D8) -> tonight's 23:00 digest may actually send, so AUD-E2E-COACH B2 (console/unsubscribe links point at
  hosts that do not exist: digest.service.ts:48-49 CONSOLE_URL default console.thegrowthproject.app) is live-relevant. B-EMAILFROM-126
  is building the from-address single-source fix.
  Operator pushed the B-814-1 fix himself (b#814 @ b6e40ad8): workout_assigned now maps to the workout_reminder prefs prefix, so the
  assignment push AND its inbox row are no longer dropped for a client with default preferences. New spec 5/5 (3 fail at e27aa237).
- 19:21 mobile #450 (fun layer) and #443 (week actions/history/client entry) merged through merge_if_dual at exact dual-approved green heads. Current mobile main 357663d5c6ade2e0c8fba3b6e177840bd7bf2e8d.
- 19:22 owner APK build started from that exact application SHA, throwaway ci/APK-126-1 (workflow-only commit 6d7ba5d0), run 37561702685. Never merge this branch. New APK is not yet delivered and does not fix AUD-E2E-CLIENT B-1 (assigned Start navigation). No accounts created/reset; owner will send Roman's test message himself.
- 19:24 DEPLOY 17 succeeded, run 37561522514, exact production image SHA 111b0ad6c6290209ce50390643326ad67d1c8b11; /health ok and /readyz db up checked 19:25. Contains scheduler #810, AI status #808, Day-1 backend #812, Roman consent #811, guest money #816, sub-coach AI restriction #817 and same-day workout ordering #818. No prisma delta, migrations input empty, no customer data writes approved or performed.
- Post-deploy log read 37561902787 produced no NudgeScheduler or drip-dispatcher samples. Do NOT infer one execution from silence; post-release timed-job execution-count proof remains pending.
- 19:19 owner approved sharing wording. 19:20 then questioned a separate prompt as implied by coaching relationship. Kept #820/#451 held; #451 additionally has Sol REQUEST CHANGES at 06570f13: current-production missing owner_access falsely promises the owner can't see unshared logs. No new builder started. Suggested join-time notice is a proposal, not built or approved implementation.
- 19:21 credits 37.5k/45k (owner). 19:23 owner: "yes please remove any coach subscription teirs for now. We have the white label service, thats the only thing thats even implied to use the gate right?" Generic coach-tier restriction removal authorized; client package billing/dunning/payouts unchanged; separate custom-domain Pro gate is independent and untouched.
- 19:27 #821 merged (Stripe readiness refresh); 19:28 #814 merged at 7275acd4 (assignment notification preference fix + committed real-service regression), #822 merged at b4f48a76 (billing observe-only manifest). All via merge_if_dual with current-head dual approval and green checks.
- 19:29 flag read-only plan started: fly-env-sync run 37562180086, main b5b546629191fc68e7c9329317d65f116b30feef. Apply authorized ONLY after plan proves BILLING_ENFORCEMENT unset is the sole change and no other staged names would be deployed. Not yet applied.
- Corrections to earlier owner updates: #443 was NOT merged at the 19:10 update (it merged 19:21); the flag PR had not been reviewed at that update; presence of BILLING_ENFORCEMENT does not establish its value is enforce; prior digest failures preceded domain verification and do not establish a current wrong sender. Current EMAIL_FROM_ADDRESS and RESEND_FROM_EMAIL both present per Env Truth; delivery at 23:00 remains unverified.
- White-label status (read-only, no new work): coach-branded web landing/invite pages exist; custom-domain claim + DNS verification exist, direct Pro check remains. Certificate provisioning/verification automation is explicitly deferred in CustomDomainService. Current mobile remains one The Growth Project app (app.json on main). No finished white-label app or live custom-domain customer has been verified. Record a separate white-label entitlement follow-up, never silently tie ordinary coach tools back to Pro.
- 19:32 approved configuration change APPLIED and VERIFIED: run 37562398593, sole unset BILLING_ENFORCEMENT, 0 names set, 0 other staged changes. Every declared value/absence proven on the sole started machine. Generic coach SubscriptionGuard is now observe-only, with customer billing/payouts/dunning unchanged. /health and /readyz passed again 19:33.
- 19:30 post-release tick PROVEN in Fly log run 37562451242: exactly 1 NudgeScheduler row and exactly 1 SettlementSweepCron SFEE_SWEEP_DONE at 02:30:00Z, machine 860311cee0d008, PID 643; contrasted with pre-release doubled rows. No drip sample: no separate claim about its observed count.
- 19:34 all overflow/Opus lenses reported drain complete. B-EMAILFROM-126 corrected its report: B=0 U=2, no current wrong sender claimed; final head 1fcd9330 has full CI green, exact READY and both lenses approved.
- 19:35 b#819 merged at exact dual-approved green head, completing the unblocked existing queue. No new sender/secret flag PR was started; both sender env names remain present. Existing EMAIL_FROM_ADDRESS is used after deployment, and RESEND_FROM_EMAIL is NOT unset in this drain. Release 18 must deploy the final backend main once CI/CodeQL/SBOM complete. No migration delta.
- 19:42 arm64 owner APK delivered as asset "TGP Android test build — October 06": artifact 11456679547, successful job 112600202794, app source 357663d5. APK proof passed and downloaded SHA-256 matched. Universal variant still running. No claim of device-tested UX or live AI engine.
- 19:47 final backend main b59ccb3e CI passed all five jobs; CodeQL and SBOM complete. 19:48 deploy 18 dispatched at exact current main through fly-deploy only, run 37563690500; evidence gate passed and production environment approved. No prisma delta, migrations acknowledgement empty. Await rollout verification and health.
- 19:51 DEPLOY 18 VERIFIED successful: run 37563690500, current main and sole Fly machine b59ccb3e539376f67e98a5399df1dfadf257f92f, image digest f45c269e6e71643fc6ab60bd0a04c327c81e75703e1b2a704785cd3363dbe70a. /health ok and /readyz db up at 19:53. No prisma delta from release 17. Source fixes #814/#821/#819 are now live; approved generic coach gate remains unset. No new sender/credential change or operator customer-data write.
- Final recount 19:53: backend 64 + mobile 57 = 121 PRs into main today; 8 successful Fly Deploy runs, excluding config restarts. Five existing held/blocked PRs: b#809, b#815 (stacked), b#813, b#820, m#451. All workers finished naturally; no active replacements or new tasks. Universal APK still builds externally; arm64 already verified/delivered.
