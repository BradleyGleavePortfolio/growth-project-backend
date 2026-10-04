AUDIT Claude Opus 5.5 — growth-project-backend#672 @ c5e7ed8e35f1e5b88653e5605dded2af8614182d — VERDICT: APPROVE
A/B/C = 0/0/5

Job AUD-OPUS-T23-118 (agent 118). Tier T4 (money path). Trials T2, base T1 #671 `c75002c9eef3ebc4dd7c41d537fc38028635e4dc` (unchanged, dual APPROVE). Size: 15 files, +2,975 / -2 = 2,977 changed lines, under the 3,000 cap. The headroom is 23 lines, not the "302 lines" stated in the [FIX ROUND 8 comment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5977736892). Any further T2 test has to go to T3 or replace existing lines. CI at this head: 10 checks pass, deploy-readiness-gate skipped ([CI run 37185673658](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37185673658)). CodeQL, danger, banned-casts and SBOM run only once this piece is based on main.

### Evidence reuse decision

Reused only for code that is byte-identical to code this lens approved. The 10 files untouched by `6ce54002..c5e7ed8e` are byte-identical to the head this lens approved ([Opus APPROVE 0/0/6 at 6ce54002](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5977435585), [probe run 37183472931](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37183472931)), so that audit carries over to them. The round-8 delta got a fresh full read: every line of `src/packages/trials/trial-notice.service.ts` (+348 / -138; the whole file was re-read), `src/email/email.service.ts`, `src/email/email.types.ts`, `test/b-trials-t2-fix-round-6.spec.ts` and `test/b-trials-t2-fix-round-8.spec.ts`. The prior Opus probe was replayed unchanged at this head.

### Prior findings of this lens

- **C-672-7 closed under the operator ruling.** `trialEndLabel` / `trialNoticeCopy` (`trial-notice.service.ts:163-179`, zone source `:1088-1094`) use a bare date only in the client's own (stamped) zone. Every other zone gets the time and zone. Control (green): with only the coach zone known, the in-app row, push and email read "Your free trial ends on Oct 13 at 12:30 AM EDT. Your card will be charged $49 then." With a stamped Los Angeles zone, the push keeps "ends on Oct 12." The replayed 117 probe is **red by design**. It asserts "not Oct 13", which the ruling replaced with "Oct 13 at 12:30 AM EDT". The run prints exactly that string. The 117 control "an unchanged trialing purchase is delivered on both channels" is also red only on its exact-copy line, because its world has no stamped zone and now gets "Oct 12 at 1:00 PM EDT". Its one-push / one-email assertions pass. Evidence: [probe run 37218788517](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218788517).
- **C-672-8 closed** (Sol B-672-3). `trialNoticeSkipCode` (`:141-153`) runs in `prepare()` for each channel and again before the email (`:496-532`). `claim()` needs `trial_ends_at > now` (`:866`, `:873`), and `reopen()` covers only `REOPENABLE_SKIPS` (`:131-135`, `:943-959`). The replayed 117 probes for extension and conversion are green, and so is a new control: both channels are retired with `skip:trial_superseded` / `skip:trial_ended`, and the sweep never retries them. A composed control through the real T3 webhook (shortened trial, `trial_will_end` before the update: retired, then reopened and sent once) is cited on #673.
- **C-672-9 closed** (Sol B-672-4 for email). `bounded()` (`:966-986`) aborts at the timeout and gives a 5 s grace. `holdLease` (`:993-1029`) keeps and renews the lease while the send runs. `EmailService` passes the signal to `fetch` and sends a stable `Idempotency-Key` (provider key plus a sha256 of the payload, `src/email/email.service.ts:254-265`). Per the [Resend idempotency docs](https://resend.com/docs/dashboard/emails/idempotency-keys), the same key deduplicates for 24 h. Control (green): the abort reaches the Resend `fetch`, the row stays `pending` with the lease released, and the retry sends the same key and settles `sent` with 2 attempts.
- **Carried, unchanged code (still open, report follow-ups):**
  - C-672-3 remainder: the mobile ClientPackages push route belongs to mobile #338.
  - C-672-5 remainder: notices recorded by the reconciler carry no tax flag.
  - C-672-6(b): the in-app row copy is frozen at record time.
- **C-671-4** (a #671 finding; its writer is T3) is decided on #673. The direct T1 view probe in the replayed file stays **red by design**: T1 is unchanged, and the row it builds (never started, `trial_ends_at` set) can no longer be written by T3.

### C-672-10 — a hung push that really delivers is sent again

- **File:line:** `src/packages/trials/trial-notice.service.ts:971-975` (`done` drops the late result) and `:1022-1025` (the lease is released with `{}`, leaving `push_status` `pending`). The root cause is outside this diff: main's `pushToUser` calls `expo.sendPushNotificationsAsync` with no abort signal (`src/notifications/notifications.service.ts:679`).
- **Counterexample (probe, red as expected):** the push hangs past the 30 s timeout plus the 5 s grace, then Expo accepts it (`delivered`). The next `deliver()` (the sweep) sends the same push again, so `pushToUser` is called 2 times instead of 1. [Probe run 37218788517](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218788517).
- **Why C:** the result is one duplicate informational push, and only when Expo hangs for over 35 s and then succeeds. No money, email or privacy effect.
- **Minimal fix rule:** when `done` settles after a timeout, write the late outcome through the fenced `complete()` (definitive `delivered` / `no_token` set the status). Release to `pending` only on a non-definitive result.

### C-672-11 — a stale trial_will_end writes "will be charged" for a converted purchase

- **File:line:** `trial-notice.service.ts:317` (`recordTrialWillEnd` checks only `entitlement_active`) and `:331` (cancel flag read from the payload). The delivery gate (`trialNoticeSkipCode`) is not applied when the in-app row is written.
- **Counterexample (probe, red as expected):** the purchase is `active` (trial converted), and a delayed `trial_will_end` still says `trialing`. `createNotification` is called once with "Your card will be charged $49 then." [Probe run 37218788517](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218788517).
- **Why C:** push and email are retired correctly; only the in-app row is wrong. Reaching it needs a trial that ends early or an out-of-order event, and no product path ends a trial early. This is part of carried C-672-6(b).
- **Minimal fix rule:** in `recordTrialWillEnd`, return `null` when `purchase.status !== 'trialing'`. This is the same rule `trialNoticeSkipCode` applies at delivery, and the reconciler records any notice that becomes current later.

### Checked and sound

- **Abort placement.** `EmailService` checks the abort before it writes the log row and before the transport (`email.service.ts:142-143`, `:214-217`, `:225-226`). Other callers can leave out `signal` and `providerIdempotencyKey` (`email.types.ts`).
- **Copy.** All three T1 copy variants contain "ends on <date>.", so the label replacement applies to each of them.
- **Lease timing.** `admit()` refuses a send whose lease cannot cover the timeout plus the grace (`:905-927`). A renewal is fenced on the token, so a lost lease writes nothing.
- **Per-process guard.** `running` stops a second send of a key that is still running (`:966-979`).
- **Size and copy rules.** Both hold.
- **Other outside-the-diff items.** The `to=` email log lines are main's code (FU2 #700), so they are a report item only.

Probe branch `audit/AUD-OPUS-T23-118/672-probes` (probe specs only, on this head). Specs: `test/audit-opus-t23-118-672.spec.ts` (2 probes red as expected, 4 controls green) and the unchanged replay `test/audit-opus-t12-117-672.spec.ts` (3 red by design as explained above, 3 green).
