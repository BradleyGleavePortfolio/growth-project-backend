# AUD-OPUS-T3E-119 — Claude Opus 5.5 lens: trials T3 #673 FIX ROUND 11 and T4 #706 FIX ROUND 2 (delta), agent 119 wave

- Started Sun Oct 4 14:58 PDT 2026. Verdicts posted 15:08 PDT. Cleanup 15:08 PDT. All times are from `date`.
- Tier T4 (money path). Disk was at 67 percent.
- Claims: `lanes119/claims/backend-673-dcf095b8-opus` and `backend-706-3d95f96e-opus`.

## Result
| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| backend#673 (T3) | dcf095b85f74478f44e1a090f2a93cbbd1c6d496 | APPROVE | 0/0/7 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/673#issuecomment-5984958541 |
| backend#706 (T4, tests only) | 3d95f96e555627d7dd5605a6004c0df633687208 | APPROVE | 0/0/2 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/706#issuecomment-5984958823 |

- I re-read each head right before posting (15:08:39 and 15:08:41 PDT). Neither had moved.
- CI: 10 applicable checks pass at each head, and deploy-readiness-gate is skipped. Both PRs are CLEAN drafts.
- Size: #673 is at 2,999 (+2,991/-8), under its grandfathered ceiling of 3,000. #706 is at 940 (tests only), under the 1,500 limit.
- Verdict texts are in `ops/aud-119/AUD-OPUS-T3E-119/verdict-673.md` and `verdict-706.md`.

## Evidence reuse (G09)
- **#673:** the delta is the single commit dcf095b8 on top of 904b9642, the head I approved last time. It touches 3 files (+67/-15), and I read all of it, along with its callers and the webhook owed-conflict branch at `checkout-webhook-handler.service.ts:958-976`.
- **#706:** the source part of `git diff a3f01163 3d95f96e` is byte-identical to the #673 delta: the diff of the two diffs is empty. The rest is 2 test files (+940), which I read in full.

## Decisions on prior findings
- **Opus C-673-6** (void before cancel): CLOSED.
- **Sol B-673-1** (narrowed paid-conversion race): I agree it is closed.
  - A payment that lands before or between the two reads shows up in the paid list, so the plan is superseded.
  - A payment that lands after the reads makes its void fail, so the worker retries and then supersedes.
  - A voided invoice cannot be paid.
- **Sol C-673-7** (malformed amounts): CLOSED.
- **Builder's failing-before run** 37236196278 has 36 assertion failures. The after-run is 37237173197.

## Probes (CI lane; probe specs only, on the exact heads)
- **#673:** run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37238544583 — 78 pass, 4 fail.
  - The 4 failures are the ruled C reds: C-673-2, C-673-3 (twice) and C-673-4.
  - The new `audit-opus-t3e-119-673.spec.ts` passes 11/11 (Q1-Q10 plus Q2b).
  - The replays of T23D-119, T23-119 and T23-118 behave as ruled, and b-trials-3 is green.
- **#706:** run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37238555246 — 135 pass, 4 fail.
  - The 4 failures are the same ruled reds.
  - b-trials-3, b-trials-4 and b-trials-5 are green.
- What the new probes check:
  - Q1 (pins C-673-8): the void is confirmed, the DELETE returns 503, the worker retries, the plan is superseded, and one alert fires.
  - Q2 and Q2b: the lease budget measured against real elapsed read time.
  - Q3: a null entry in the open-invoice list.
  - Q4: the paid list fails while the open list is fine.
  - Q5: the void path is encoded correctly and the form is empty.
  - Q6: replaying the same event is a no-op.
  - Q7 (pins C-673-9): uncollectible invoices are not listed.
  - Q8: C-673-7 edge cases.
  - Q9: two workers race (the second gets busy; one void and one DELETE).
  - Q10: the Stripe message stays out of Sentry tags.
- Spec and logs are in `ops/aud-119/AUD-OPUS-T3E-119/`.

## Follow-ups (C)
1. **C-673-8 (builder's C; I agree it is a C).**
   - Where: `trial-conflict.service.ts:285-296` and `checkout-webhook-handler.service.ts:966-972`.
   - What happens: a void moves the plan to active. If the DELETE then fails, the next settle supersedes the plan. The client gets one unpaid period, and the coach gets a false refund alert. No client money is taken.
   - Fix rule: record void intent on the row under the lease before the first void. Then active + intent + a complete $0 history counts as never billed.
   - Where to fix: the #680 round, together with C-673-4.
2. **C-673-9 (builder's C; I agree it is a C).**
   - Where: `voidOpen` at `:457-458`.
   - What happens: with 2 or more open invoices the lease always runs out (`lease_exhausted`), and uncollectible invoices are not voided. It fails closed: the worker retries and alerts after 3 attempts.
   - Fix rule: renew the lease by CAS before each void, and list `status=uncollectible` as well.
3. **C-673-10 (new, outside this diff).**
   - Where: `trial-conflict.service.ts:71` and `:119-123`.
   - What happens: `incomplete` is treated as unbilled, so it is cancelled without a void. A trial subscription can't reach this state today.
   - Fix rule: handle `incomplete` like past_due/unpaid (void first).
4. **C-706-2 (new).**
   - b-trials-5 has no regression test for "DELETE fails after a confirmed void", and none for the elapsed-time lease budget.
   - Fix rule: adopt probes Q1, Q2 and Q2b in the #680 round.
5. **Carried unchanged:** C-673-1, C-673-2, C-673-3, C-673-4 and C-706-1. The C-672-* items are also unchanged (see AUD-OPUS-T23D-119.md).

## Operator decisions (recommended default first)
1. **C-673-8 and C-673-9.**
   - Default: ticket them for the #680 integration round, together with C-673-4.
   - Reason: no client money is at risk, and C-673-9 fails closed.
2. **C-673-10 and C-706-2.** Default: ticket them for the same round.
3. **Where the next trials fix goes.** #673 has no headroom left, so the next trials fix goes to a new piece under 1,500 lines or to #680. This lens agrees with the operator's default.
4. **Landing.** Trials land as one (#671, #672, #673, #706) after recurring, once Sol's verdict at dcf095b8 is APPROVE.

## Progress
- 14:58 PDT: read the rules, the entry and the reports; took the claims.
- 15:02 PDT: delta read; probes pushed (2 CI-lane runs).
- 15:06 PDT: both runs finished as expected.
- 15:08 PDT: verdicts posted. Cleanup done:
  - Remote branches `audit/AUD-OPUS-T3E-119/{673,706}-probes` deleted (ls-remote returns 0).
  - Worktrees `wt/AUD-OPUS-T3E-119-{1,2}` removed and pruned.

## HANDOFF
- **Done:** one verdict per PR at the exact heads. #673 @ dcf095b8: APPROVE 0/0/7. #706 @ 3d95f96e: APPROVE 0/0/2.
- **Cleanup:** complete. The operator can release the claims `backend-673-dcf095b8-opus` and `backend-706-3d95f96e-opus`.
- **Next Opus action:** only on a new head. That would be a delta audit replaying `ops/aud-119/AUD-OPUS-T3E-119/audit-opus-t3e-119-673.spec.ts` and the earlier Opus probe files.
