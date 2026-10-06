MAIN REFRESH (B-TR12-123, agent 123) — growth-project-backend#671 @ fca4018be43d57805c5c06c5a18c359800a1a22b

Old head 4315136a05685e0420a511fd7f05bb333a77e484 (the whole trials train #672 -> #673 -> #706 -> #707 landed, tree = audited TD1 top). Two pushes:
- **Push 1** (18:52 PDT) went to `2a6dfd987af9081471d928f0c179b39b7f37df0d` and carried items 1-3 below.
- **Push 2** (19:03 PDT, merge-only, authorised by the operator) went to `fca4018be43d57805c5c06c5a18c359800a1a22b`, item 4.

The commits:
1. `bf2c97da` merge of origin/main `0521b393` (parents 4315136a + 0521b393). Two conflicts, both sides kept.
2. `462a5e7a` R75 cast fix (tests only).
3. `2a6dfd98` fix for a merge clash git did not flag: both sides added a method named `listOpenInvoices` (TS2393, found by lane tsc).
4. `fca4018b` merge of origin/main `d5177b31` (includes b#738 proxy-addr 2.0.8 for the required npm audit check). It merged clean, and the rule-12 checks hold against 2a6dfd98:
   - Parents are 2a6dfd98 and d5177b31.
   - All 51 PR file blobs are byte-identical.
   - Every non-merge commit in 2a6dfd98..fca4018b is on main.
   - Main changed only `package-lock.json`, `.github/fly-env-desired-state.json`, `docs/runbooks/launch-flags.md`, `src/checkout/dunning-v2/dunning-lockout.guard.ts` and 4 dunning lockout specs; none of these are PR files.

### Conflict hunks and their resolution
- **H1 `src/checkout/checkout.module.ts` imports.** Trials imports `TrialConflictService`; main imports `ClientBillingController`, `ClientBillingReconciler` and `ClientBillingService`. All four imports are kept. Controllers and providers merged without conflict and list both sides (`TrialConflictService` and the ClientBilling* entries).
- **H2 `checkout-webhook-handler.service.ts` applyInvoicePaid, the locked block.** Main's R-DISPUTE-PAUSE line is kept: `entitled = subscriptionGrantsAccess(fresh, live) && !(await this.disputePaused(client, fresh.id))`. Trials' name `start` for `trialStartPatch(...)` is also kept, because trials declares `trial = await this.trialState(...)` further down and reads `!start.trial_started_at`. `trialState()` now gets main's dispute-aware `entitled`. It can only return `entitled: true` when that input is true (`isTrialStart` needs it), so the trial path never lifts a dispute pause.
- **H3 same file, function tail.** Git lined the trials return up against main's new helper block. Main's `resolveDunningOnPaid` and `inUnpaidGrace` are kept whole. The trials return (`trialConflictSubscriptionId`, `deferredTrialNoticeId`) now sits at applyInvoicePaid's own return, after `await this.resolveDunningOnPaid(updated.id, tx)`. Main's dunning and dispute handling and the trials webhook handling both run; nothing was dropped.
- **Proof at bf2c97da.** For all 51 PR files, the PR's +/- lines against main 0521b393 match the PR's +/- lines against the old base 5cde6253 exactly (51/51). The changed-file set against main is exactly the 51 PR files.
- **Auto-merged files checked:** `prisma/schema.prisma` (trial models, User relations and columns only), `account-deletion.manifest.ts` (the 3 trial rows), `ci.yml` (live trials spec registration), `.env.example` (trial_will_end line), `email.service.ts` / `email.types.ts` (TRIAL_ENDING and the provider idempotency key), `stripe-connect-api.service.ts`. In each, only the PR's lines changed and all of main's lines are intact.
- **Merge clash, fixed in 2a6dfd98.** Main's dunning work added `StripeConnectApiService.listOpenInvoices(): StripeInvoiceObject[]`, which follows the cursor and throws on a partial list. Trials had its own one-page `listOpenInvoices(): {data, has_more}`. The trials one is renamed `listOpenInvoicePage`, and its 2 callers in `src/packages/trials/trial-conflict.service.ts` and the one trials mock (`test/b-trials-3-fix-round.spec.ts:221`) follow. Main's method and every dunning caller are unchanged, and trials behaviour is unchanged. Only 5 PR files differ from the audited +/- lines: these 3 and the 2 cast-fix tests.

### R75 cast fixes (462a5e7a)
- `test/b-trials-trial-ending-push-prefs.spec.ts`: `prisma as never` is replaced by `stub<ConstructorParameters<typeof NotificationsService>[0]>(prisma)` (the typed helper in `test/utils/trial-fakes.ts`). `(svc as unknown as {expo}).expo` is replaced by `jest.spyOn(Expo.prototype, 'sendPushNotificationsAsync')` with typed tickets, plus a receipts spy, restored at the end.
- `test/b-trials-4-fix-round.spec.ts:8`: a comment matched the `as never` token ("read as never billed") and now reads "read as unbilled".
- `node scripts/check-r75.js --mode=range --base=origin/main --head=HEAD` passes with no positive token change. The PR's R75 check is SUCCESS.

### Migration order
- Trials adds `20270228000000_package_free_trials` and `20270313000000_package_trial_truth`. **Both are older** than main's newest, `20270318122000_coach_booking_options`, and older than several main migrations production has already applied. No main migration after 20270228 touches trial columns or the PackageTrial* tables.
- Lane job migration-order ([run 37400421633](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37400421633/job/112066146042), at 462a5e7a; migrations are identical at 2a6dfd98):
  - It first deployed main's chain up to 20270318122000 with the trials migrations held back, the same state as production. It then ran `prisma migrate deploy` again: it applied exactly `20270228000000_package_free_trials` and `20270313000000_package_trial_truth`, with no refusal, and `migrate status` reported "Database schema is up to date".
  - Compared with a fresh database deployed in name order, `prisma migrate diff --from-url --to-url` found no difference. The pg_dump definition sets are identical; only the column position of `checkout_terms` differs.
- **No rename needed.** The release that carries this PR must use migrations=apply-migrations.

### CI
- **Lane:** [run 37400905487](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37400905487) at 7d69ac33, which is 2a6dfd98 plus the lane files only.
  - Full `tsc --noEmit` is green.
  - 82 suites / 1,517 tests pass (all trials specs, checkout webhook specs, dunning/dispute/client-billing specs and the 57 TD1 lane specs).
  - The first lane run's tsc is what found the `listOpenInvoices` clash.
- **PR CI at fca4018b (final head):** all 11 required checks green (20 success, deploy-readiness-gate skipped). [CI run 37402275477](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37402275477): build-and-test passed 853 suites / 14,681 tests (30 suites / 305 tests skipped, 5 todo). [Dependency Audit run 37402275521](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37402275521) and [R100 Quality Gate run 37402275531](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37402275531) are green.
- **PR CI at 2a6dfd98 (push 1):** everything was green except the required npm audit check, which failed on the critical GHSA-jqcg-44mw-7w3h (proxy-addr 2.0.7). That failure was also red on main and was cleared by b#738 in push 2. build-and-test passed there too ([CI run 37401401441](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37401401441), 853 suites / 14,681 tests).

READY FOR AUDIT (lens scope: H1-H3, 2a6dfd98's rename, the two test files; the other 46 PR files' +/- lines are identical to the audited TD1 top).
