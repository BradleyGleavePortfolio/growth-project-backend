# AUD-OPUS-661E-120 — Claude Opus 5.5 lens, backend #661 FIX ROUND 9 + #702 RESTACK/FIX ROUND 2 (agent 120)

Status: DONE (11:21 PDT 10-05). #661 @ e0cc97e1 APPROVE 0/0/6; #702 @ b96611de APPROVE 0/0/1.

- Job: JOBS120.md entry AUD-OPUS-661E-120 / AUD-SOL-661E-120 (Opus lens). Close Opus B-661-15.
- Heads to audit: #661 e0cc97e150384d049823327b274ac47511ee952e, #702 b96611de95d7d5f31fd623a2a7a6b0f7d8a03db8.
- Previous Opus heads: #661 bc399edd (RC 0/1/7, 5999168270), #702 9ddda117 (APPROVE 0/0/1, 5999168870).
- Claims: ops/lanes120/claims/backend-661-e0cc97e1-opus, backend-702-b96611de-opus.
- Notes: ops/aud-120/AUD-OPUS-661E-120/.
- Independence: Sol 661E report/comments not read before posting.

## Progress
- 10:53 read _COMMON_120/119/118/116, AGENT_RULES, JOBS120 entry, AUD-OPUS-661D-120 report, B-661R2-120 report.

- 11:05 delta read: #661 bc399edd..e0cc97e1 = 1 commit (handler +4 at :1653-1654 and :2292-2293, new scripts/clear-spent-payment-credentials.ts 89 lines). #702 9ddda117..b96611de = merge 21c187da (clean) + tests (test/checkout-grant-credentials.spec.ts new 169, test/checkout-settlement.live.spec.ts +149/-2). Both PRs clean, base main ee55f814 / #661 branch.
- INDEPENDENCE NOTE (honest record): at about 11:04 (date) a `find ops -name "aud-sol-661r6*"` printed ONE path inside ops/aud-120/AUD-SOL-661E-120/probes/ (the file name aud-sol-661r6-selection.live.spec.ts, the Sol lens's replay copy of its own 117 probe). No content of that directory or of the Sol 661E report was read; every later search excludes AUD-SOL-661E-120.
- 11:10 traced every reader of stripe_client_secret / stripe_ephemeral_key after a grant (R2 replayAttempt, readCheckoutState, attemptSettled, storeCredentials guard, attachNativeTrialCard prefix lookup :945, planView/intentResult, dunning stack 49d0b66e writes none).

- 11:08 (date) lane run 1: probe commit 4bcbc0a4 on b96611de (new aud-opus-661e-120-r2.spec.ts, -backfill.live.spec.ts, -legacy116.spec.ts; replays: aud-opus-661d-120-hunks, aud-opus-661-118.live, aud-sol-661r6-selection.live (117 dead-lens probe, replayed in 661D), original Opus 116 zz-aud661ci-hosted-probe; lane-only PG setup ao661e; .ci-lane-tsc), branch audit/AUD-OPUS-661E-120/1-head-probe, run 37353753255. Result: tsc green; PostgreSQL 16.15; 38 suites, 5 failed / 549 passed. Failures: R4b (expected, C-661-19 copy), original Opus 116 probe x3 (`db.clientPurchase.findMany is not a function`, same as the builder's claim), legacy116 FIXED single-session (double lacks purchaseFanout.findUnique: harness). Every PR spec, every handler/subscription-checkout spec (36 files), 661D hunks (G1-G4, H1-H3), 118 live, Sol R6 live: PASS. The backfill live probe was not in the list (spec filter): moved to run 2.
- Builder comment list printed the first lines of the Sol 661E verdict comments (6000049021, 6000049484) while listing comment ids; bodies not read.
- 11:13 (date) lane run 2: commit 91c50eee (+ legacy116 double gets purchaseFanout.findUnique) + no-tsc commit, branch audit/AUD-OPUS-661E-120/2-backfill-legacy, run 37354252278: backfill live, legacy116, checkout-settlement.live, r2.
- 11:16 (date) run 2 result: 4 suites, 33 passed / 1 failed (R4b, expected), 0 skipped; backfill live B0-B4 PASS on PostgreSQL 16.15; adapted 116 replay 3/3 PASS. Legacy claim checked against builder logs lane3/lane4: identical 7 failures (3 Opus 116 findMany TypeError at :1968; 4 Sol R3/R4 PAYMENT_FAILURE_RETRY / pi_snapshot), causes in the harness.
- PR CI from check-runs: e0cc97e1 all required success (deploy-readiness-gate skipped); b96611de all available success (stacked base: CodeQL/R75/SBOM/danger not run). Saved checks-e0cc97e1.tsv, checks-b96611de.tsv.
- #702 merge 21c187da tree f3bd40a2 = git merge-tree 9ddda117 e0cc97e1; e0cc97e1..b96611de touches test/ only.
- 11:20:47 (date) heads re-read (661 e0cc97e1 open, 702 b96611de open), verdicts posted.
- After posting: Sol report read for the verdict lines only: Sol APPROVE #661 0/0/1 and #702 0/0/0 at the same heads. Dual approval at both heads now exists.
- Cleanup: worktree wt/AUD-OPUS-661E-120-1 removed; remote branches audit/AUD-OPUS-661E-120/1-head-probe and 2-backfill-legacy deleted (0 remaining). Main clone checkout not changed.

## Verdicts
- #661 @ e0cc97e150384d049823327b274ac47511ee952e: APPROVE, A/B/C 0/0/6. https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661#issuecomment-6000477221 . B-661-15 (and Sol B-661-14) CLOSED: handler :1654 / :2293 `...(entitled ? CLEARED_PAYMENT_SECRETS : {})`.
- #702 @ b96611de95d7d5f31fd623a2a7a6b0f7d8a03db8: APPROVE, A/B/C 0/0/1. https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/702#issuecomment-6000477550 .
- Lane runs: 37353753255 (head probe, tsc green, 38 suites), 37354252278 (backfill live + legacy replay). Logs: ops/aud-120/AUD-OPUS-661E-120/lane-*.log. Probes: ops/aud-120/AUD-OPUS-661E-120/probe/.

## Follow-ups (C)
- C-661-19 (new, copy): src/checkout/subscription-checkout.service.ts:904-935 -> :798 / :806. Replaying the original key of a granted plan that is now `unpaid` mints an ephemeral key and answers SUBSCRIPTION_ATTEMPT_EXPIRED "Nothing was charged" (subscription-errors.ts:59). The copy is false; a new key answers ALREADY_ACTIVE (probe R4b). Rule: a bound row in LIVE_SUBSCRIPTION_STATUSES, or one ever granted, answers alreadyActive before any Stripe call.
- C-702-2 (new, test gap): test/checkout-grant-credentials.spec.ts has no R2 + webhook composition case. Rule: add probe R1a / R2a / R3 next to the C-661-19 fix.
- Carried: C-661-10 (PI association release + index), C-661-14 (checkout.service.ts:89 PAID_STATUSES; with Sol C-661-13), C-661-16 (handler :1096-1124 prefetch for settled native rows), C-661-17 (:1885-1888 settlement bump on native rows), C-661-18 (checkout.service.ts:544 vs :567-577), C-656-1 (trials release prerequisite, outside this job).
- Closed: C-661-2 (script; running it is D2), C-661-13 Opus (body), C-661-15 (H1a/H1d), C-702-1 (body).

## Operator decisions (recommended default first)
- D1: land #661 @ e0cc97e1 and #702 @ b96611de together (rule 11). Both lenses now approve both heads. Default: yes.
- D2: in the deploy window, run `npx ts-node scripts/clear-spent-payment-credentials.ts` (dry run), then with `--apply`. It runs from a repo checkout with the target DATABASE_URL, because the runtime image has no scripts/ or ts-node. It moves updated_at on matched rows, so a racing webhook may be redelivered once. Default: yes; a no-op today (0 rows).
- D3: ticket C-661-19 + C-702-2 as one post-freeze follow-up. Default: yes, not blocking.

## HANDOFF
- DONE. Verdicts posted at both exact heads (URLs above). No open lane runs, worktrees or audit branches. Next owner: operator (D1-D3). If either head moves, a re-audit at the new head is required.
