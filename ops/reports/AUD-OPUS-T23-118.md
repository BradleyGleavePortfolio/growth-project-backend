# AUD-OPUS-T23-118 — Claude Opus 5.5 lens, trials T2 #672 + T3 #673 (backend), agent 118 wave

Started 2026-10-04 09:46 PDT (from `date`). Tier T4 (money path).

## Result
| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| backend#672 (T2) | c5e7ed8e35f1e5b88653e5605dded2af8614182d | APPROVE | 0/0/5 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5982465734 |
| backend#673 (T3) | df76889fb862095170498dccb23f35db3d116690 | APPROVE | 0/0/3 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/673#issuecomment-5982465887 |

- Heads were re-read right before posting (10:15 PDT); both unchanged. Both are CLEAN: 10 pass plus deploy-readiness-gate skipped (CI runs 37185673658 and 37186105856). CodeQL, danger, banned-casts and SBOM run only once each piece is based on main.
- Sol (GPT-6.1) posted REQUEST CHANGES on both heads at 09:57 and 09:59 PDT. This lens did not read Sol's findings or notes (independence) and did not copy them. The operator reconciles the split.

## Setup
- Claims: ops/lanes118/claims/backend-672-c5e7ed8e-opus and backend-673-df76889f-opus.
- Sizes:
  - #672: 15 files, +2975/-2 = 2,977 vs T1 c75002c9. Headroom is 23 lines; the round comment said 302.
  - #673: 11 files, +2619/-8 = 2,627 vs T2.
- Evidence reuse:
  - #672: the 6ce54002 Opus APPROVE (issuecomment-5977435585, run 37183472931) applies to the 10 files byte-identical since then. The 5-file delta 6ce54002..c5e7ed8e (+759/-153) was read in full.
  - #673: none. Opus never approved #656 or #673, so this was a full audit.

## Probes (CI lane; probe specs only, on the exact heads)
- #672, run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218788517 (branch audit/AUD-OPUS-T23-118/672-probes, probe commit b8e21c1d).
  - test/audit-opus-t23-118-672.spec.ts: C-672-10 and C-672-11 red as expected. Controls green: C-672-7 ruling label (coach zone and stamped client zone), B-672-3 retire on extension and conversion, B-672-4 abort reaching fetch with the same Idempotency-Key on retry.
  - Replay of test/audit-opus-t12-117-672.spec.ts (unchanged, 3 red by design and 3 green):
    - C-671-4 direct view probe: red. Its input can no longer be written.
    - C-672-7 "not Oct 13": red. Superseded by the ruling; the output is "Oct 13 at 12:30 AM EDT".
    - The exact-copy line of the "unchanged trialing" control: red. The new copy carries time and zone; its send counts pass.
    - C-672-8 probes and the cancelled control: green.
- #673, run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37219356220 (branch audit/AUD-OPUS-T23-118/673-probes, probe commit e4bd5dd3).
  - test/audit-opus-t23-118-673.spec.ts: C-673-2 and both C-673-3 probes (MRR 49 instead of 0; churn 1 instead of 0) red as expected.
  - Controls green: C-671-4 composed (a $0 invoice without a card, then delete, gives `none`; the lost race gives `none`) and B-672-3 composed (shortened trial: `trial_will_end` first, then retired, reopened and sent once).
  - An earlier run of the same spec, 37219271817, had the two C-673-3 assertions combined in one test.
- Probe copies and logs: ops/aud-118/AUD-OPUS-T23-118/ (audit-opus-t23-118-672.spec.ts, audit-opus-t23-118-673.spec.ts, run-*.log).

## Decisions on prior findings
- C-672-7: closed under the operator ruling. The 117 probe is red by design.
- C-672-8 (Sol B-672-3): closed.
- C-672-9 (Sol B-672-4, email side): closed.
- C-671-4: closed at the T3 writer, which is the only ClientPurchase.trial_ends_at writer (checkout-webhook-handler.service.ts:934, gated at :929-933). The direct T1 view probe is red by design.
- Carried open: C-672-3 remainder, C-672-5 remainder, C-672-6(b).

## Follow-ups (C)
1. **C-672-10 (#672): a hung push that really delivers is sent again.**
   - Where: trial-notice.service.ts:971-975 (`done` drops the result) and :1022-1025 (release with `{}` leaves `pending`). Root cause: main's pushToUser has no signal (notifications.service.ts:679).
   - Fix rule: when `done` settles after a timeout, write the definitive late outcome through the fenced complete(), and release only on a non-definitive one.
2. **C-672-11 (#672): a stale trial_will_end writes a "will be charged" in-app row for a converted purchase.**
   - Where: trial-notice.service.ts:317 and :331.
   - Fix rule: recordTrialWillEnd returns null when purchase.status !== 'trialing'.
3. **C-672-3 remainder (#672 / mobile #338): the ClientPackages push route.**
   - Fix rule: mobile #338 maps the trial-ending push to ClientPackages.
4. **C-672-5 remainder (#672): the reconciler's notices carry no tax flag.**
   - Where: trial-notice.service.ts reconcilePage.
   - Fix rule: carry the tax flag on the purchase, or re-read it at delivery.
5. **C-672-6(b) (#672): the in-app row copy is frozen at record time.**
   - Where: recordNotice.
   - Fix rule: update or retire the in-app row when the notice is retired or superseded.
6. **C-673-1 (#673): post-commit trial work is awaited inside the webhook request (worst case about 90 s).**
   - Where: billing.service.ts:674-686.
   - Fix rule: start both jobs without awaiting them (`void ... .catch(log)`); the sweeps retry.
7. **C-673-2 (#673): an older, retried subscription event rewrites an extended trial end and records a notice for the old date.**
   - Where: checkout-webhook-handler.service.ts:930-934.
   - Fix rule: write trial_ends_at only from the newest subscription state: re-read the subscription, or skip an event older than the last one applied.
8. **C-673-3 (#673, outside the diff, binding ruling): coach metrics count never-billed trials.**
   - Where: src/coach-connect/coach-connect.service.ts:281-295 (mrr), :307-314 (clients_churned_30d) and :339-346 (sub_coach_churn_30d).
   - Fix rule: exclude never-billed trials using #676's billed predicate, with a composed test. See operator item 1.
9. **Size note (#672): the FIX ROUND 8 comment states 302 lines of headroom; the real headroom is 23.**
   - Fix rule: correct it in the next round comment. Any further T2 test goes to T3 or replaces lines.

## Recurring-code notes (report only, not on these PRs)
- **R-1.** Out-of-order subscription events also regress `status`, because the recurring webhook writes have no event-ordering guard. This belongs with the #680 "unified webhook writes" integration item, and the same rule should cover trial_ends_at (C-673-2).
- **R-2 (not verified).** applyInvoicePaid's existing swallow try/catch now also wraps applyTrialState. The recurring audit should confirm that a swallowed DB error inside the webhook tx cannot commit an aborted transaction while the event is acknowledged.
- **R-3.** The EmailService `to=` log lines are main's code (FU2 #700).
- **R-4.** #680 (agent115/recur-split-3-webhooks-fixes @ 9621457e) keeps its own `trial_started_at` trial model. The trials integration must keep a single trial_ends_at writer; this is already C-656-1 items 5/6. #680 already sets `payment_settings[save_default_payment_method]=on_subscription` and `missing_payment_method=cancel`.

## Operator decisions (recommended default first)
1. **C-673-3, MRR and churn exclude never-billed trials (binding).**
   - Default: add it to the C-656-1 #680 integration list and fix it in that round, before any trial is sold, using #676's billed predicate and a composed test like the C-673-3 probe.
   - Alternative: a T3 fix round now (about 370 lines of headroom).
2. **Split verdicts on both heads (Opus APPROVE, Sol RC).**
   - Default: the builder answers Sol's B findings in a fix round, and the Opus lens audits only the new delta (evidence reuse for byte-identical code).
3. **#672 headroom is 23 lines.**
   - Default: tests for any T2 fix go to T3, or replace existing T2 lines.
4. **Carried.** The owner enables `customer.subscription.trial_will_end` on the Stripe endpoint (docs/stripe-setup.md). Mobile #338 adds the ClientPackages push route. Trials land after recurring (#678-#701) with the C-656-1 list.

## Progress
- 09:46 PDT: read the rules, the job entry and all comments on #671, #672 and #673.
- 09:58 PDT: #672 delta read in full; CI checked at both heads.
- 09:59 PDT: #672 probe run 37218788517 (as expected).
- 10:06 PDT: #673 probe run 37219271817; 10:09 PDT split rerun 37219356220 (as expected).
- 10:15 PDT: verdicts posted (issuecomment-5982465734, issuecomment-5982465887).
- 10:16 PDT: cleanup done. Remote audit/AUD-OPUS-T23-118/672-probes and 673-probes deleted (ls-remote empty), no local audit branches, worktrees wt/AUD-OPUS-T23-118-672/673 removed and pruned.

## HANDOFF
- Done: one verdict per PR at the exact heads. #672 APPROVE 0/0/5, #673 APPROVE 0/0/3.
- Cleanup: done (the audit branches are deleted remote and local, and the worktrees are removed); see Progress.
- Claims ops/lanes118/claims/backend-672-c5e7ed8e-opus and backend-673-df76889f-opus can be released by the operator.
- Next lens action: only on a new head (delta audit with evidence reuse for byte-identical code).
