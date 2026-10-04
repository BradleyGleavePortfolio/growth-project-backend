# AUD-OPUS-R12D-119 (Claude Opus 5.5 lens, agent 119): recurring R1 #678 + R2 #679, FIX ROUND 7 delta

- **Started:** Sun Oct 4 13:15:48 PDT 2026.
- **Claims:** ops/lanes119/claims/backend-678-09e159d8-opus and backend-679-23d2c04c-opus.
- **Heads:** #678 09e159d83e192e9718bef7a493aa18944022eb0b and #679 23d2c04c3d05cfc5a6594700152a9cf5336f3111. Both are draft, and every required check is green at both.
- **Previous Opus verdicts:** #678 @ 77bce450 APPROVE 0/0/2; #679 @ 8bbf4a41 APPROVE 0/0/1.
- **Notes and probes:** ops/aud-119/AUD-OPUS-R12D-119/. This holds the verdict texts, the Sol and FR7 comment copies, the probe spec audit-opus-r12d-119-pg.spec.ts, and run37231743536.log.

## Progress log
- **13:16** Read the rules, my job entry, my previous report and the B-RECUR7A-119 report.
- **13:17** Read the full delta.
  - **#678** `77bce450..09e159d8`: 3 linear commits, 4 files, +206/-23. Changes:
    - billing.ts: the collector now covers client OR coach, with the key qualified per row.
    - subscription-attempt.ts: the fence takes KEY SHARE on both parties in sorted order, and `coach_user_id` is required at claim, read-back and bind.
    - New spec added; the 6a fixture was adapted.
  - **#679** `8bbf4a41..23d2c04c`: the R1 delta plus eeb23f2e (service +25/-14), plus 2 merges with empty remerge diffs. eeb23f2e makes two changes:
    - `listPlans` is split into an uncapped live list and ended history capped at 50.
    - `attemptSettled` with no SetupIntent now answers settled only when `processing`.
  - **Patch check:** the own patch per file is identical to `77bce450..8bbf4a41`, except the service file, whose difference is exactly eeb23f2e.
- **13:21** Probe lane [run 37231743536](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37231743536). The audit commit is 4d1b4323 = 23d2c04c + probe specs only. It ran:
  - my R12 probe replay;
  - Sol's PostgreSQL fence probe replay;
  - the #701 R2 spec;
  - the R1 7a and 6a specs;
  - new real-PostgreSQL cases.
- **13:28** Result: 35 passed, 2 failed, both expected:
  - C-678-3 acceptance (open C);
  - C-679-4 "evidence" (by design: `prepared()` replays first, so the trial is already ended).
  - Real-PostgreSQL results:
    - `OPUS_COACH_FIRST {closed, creates 0, blockedUntilCommit true}`
    - `OPUS_RECIPROCAL {skipped true, both bound, waiting lock completed}`
    - `SOL_COACH_FENCE {skipped true}`
  - Coach gone before the send: SUBSCRIPTION_ATTEMPT_EXPIRED (timed_out), 0 creates.
- **Builder claims verified:**
  - Failing-before runs 37229770060 (at 7ec88952 = 77bce450 + test) and 37230129006 (at 806b10cb = 8bbf4a41 + spec; byte-identical to the #701 spec) both concluded failure.
  - After run 37230098522 concluded success.
  - The failures in probe runs 37230108455 and 37230205968 match the FIX ROUND lists.
- **13:31** Heads re-read (unchanged). Both verdicts posted.
- **13:31** Branch audit/AUD-OPUS-R12D-119/679-probes deleted on origin (0 remain). Worktree wt/AUD-OPUS-R12D-119-1 removed.

## Verdicts
| PR | Exact head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| backend #678 (R1) | 09e159d83e192e9718bef7a493aa18944022eb0b | APPROVE | 0/0/2 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/678#issuecomment-5984097954 |
| backend #679 (R2) | 23d2c04c3d05cfc5a6594700152a9cf5336f3111 | APPROVE | 0/0/2 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/679#issuecomment-5984098174 |

- **Closed this round:** Opus C-678-4 and C-679-4. I also judged Sol's fixes and found each meets its fix rule: B-678-3, B-678-4, B-679-10 (narrowed) and B-679-11.
- **CI:** every required check emitted at both heads is green:
  - #678: 12 pass, 1 skipping. Its UNSTABLE state comes only from a queued, non-required size-label rerun.
  - #679: 10 pass, 1 skipping.
  - CodeQL, danger, banned casts and SBOM run only after the retarget to main.

## Follow-ups (C)
- **C-678-3 (carried)**
  - **Where:** src/account-deletion/account-deletion.billing.ts:124-132 @ 09e159d8.
  - **Problem:** a Stripe 404 resource_missing on the customer list throws on every nightly run.
  - **Fix rule:** treat it as proven absence and keep every other error fail-closed. Admin force-delete answers a coded, retryable 409/503.
- **C-678-5 (new)**
  - **Where:** billing.ts:93-136 @ 09e159d8.
  - **Problem:** coach finalization does one Stripe list per stale pending, unbound attempt of any of the coach's clients, inside the finalization transaction. Stale `sub-retry-` rows are never swept. Also, every send by the coach's clients waits up to 30 s behind a running coach finalization, each holding a pooled connection.
  - **Fix rule:** bound the rows per run (coded "still finishing" retry), or sweep stale attempts to expired after a proven-absent lookup. Measure pool waits.
- **C-679-5 (builder decision 1)**
  - **Where:** subscription-attempt.ts:65 and subscription-checkout.service.ts:735-741 @ 23d2c04c.
  - **Problem:** a coach deleted mid-send gets the "timed out" copy. It is true (nothing was charged), and the next start sees archived packages.
  - **Fix rule:** return a distinct `coach_gone` result and answer a coded 409: "This coach's plans are no longer offered. Nothing was charged."
- **C-679-6 (builder decision 2)**
  - **Where:** service:349-353 @ 23d2c04c.
  - **Problem:** ended history is capped at 50 with no cursor.
  - **Fix rule:** add `before` cursor pagination for ended history only.
- **Carried from others:**
  - Sol C-679-3 (service:1475-1525).
  - Sol C-678-2 (busy copy; now also when a coach row is held).
  - Sol C-678-3 (pool connection held across the create).

## Notes for other stacks (operator)
- **Dunning R-DISPUTE-PAUSE (B-DUNSPLIT-119).** `listPlans` live = `entitlement_active OR trial_started_at OR status in (past_due, unpaid)`. A dispute-paused plan has access ended and billing paused.
  - If its status is outside that set, it appears only in the capped ended history, and only when its status is `canceled`. In any other status it is hidden.
  - The pause state should either be added to the live set (so the client sees "access has ended, billing is paused, the coach decides on restarting"), or the paused row should keep a status the list already shows.
  - Admission must still refuse a new subscription for it (see my R12 report).
- **R3 #680:** my R12 notes still apply. The trial grant must be gated on the lifted end, and the `setup_intent.succeeded` attach must never lift a client cancel.

## Operator decisions (recommended defaults)
1. Coach deleted mid-checkout shows "attempt expired (timed out)": ACCEPT as C-679-5. No money risk, and the next start is truthful.
2. Ended-history cap of 50: ACCEPT as C-679-6. Every live plan is uncapped.
3. Put all open Cs (C-678-3, C-678-5, C-679-5, C-679-6, Sol C-678-2/3, C-679-3) in one follow-up PR on main after the recurring stack lands. #679 has only 57 lines of headroom.

## HANDOFF
State at 13:31 PDT 10-04 (from date).
- Both Opus verdicts are posted at the exact heads.
- No audit/* or ci/* branch of this job remains, and my worktree is removed.
- My claims stay in place, since verdicts exist at those heads.

Per PR:
- **#678 @ 09e159d83e192e9718bef7a493aa18944022eb0b:** Opus APPROVE 0/0/2. Next: the Sol R12D verdict, then the operator's merge-only restack onto the final fees top.
- **#679 @ 23d2c04c3d05cfc5a6594700152a9cf5336f3111:** Opus APPROVE 0/0/2. Next: the Sol verdict and the same restack. B-RECUR7B-119 restacks #680 -> #696 -> #701 onto this head, which turns #701 green.

**What a merge-only restack onto the final fees top must preserve.** A fresh Opus lens checks this as a short delta.
1. **#678 own patch.** `(final fees top)..(new R1 head)` must equal `13c814f7..09e159d8` per file: 29 files, +2,572/-22. Compare the +/- lines per file. Any difference must sit inside a conflict hunk, and every hunk must be read (`git show --remerge-diff`).
2. **If fees touched `stripe-connect-api.service.ts` or `account-deletion/*`, these must still hold:**
   - `createSubscription` sends `cancel_at_period_end=true` and `missing_payment_method=cancel` with a trial.
   - `setSubscriptionDefaultPaymentMethod` lifts only with `liftTrialEnd`.
   - `finalizeUserDeletion` calls both collectors inside the locked transaction, before the tombstone.
   - `collectUnboundAttemptSubscriptionIds` keeps `OR client/coach`, the per-row key check `sub-<row.client_user_id>-`, the 2-minute fail-closed rule and the `has_more` throw.
3. **`sendFenced`** keeps KEY SHARE on both User rows in sorted id order, then the alive checks (client -> `gone`, coach -> `closed`), then claim, read-back and bind, all requiring `client_user_id` and `coach_user_id`. It must remain the only caller of `createSubscription` (service :701 and :723).
4. **#679 own patch.** `(new R1)..(new R2)` must equal `09e159d8..23d2c04c` per file: 8 files, +2,943. Every restack merge must have an empty remerge diff. Size must stay at or under 3,000.
5. **CI:** every required check is green at both new heads, with no relabelled flakes. After the retarget to main, CodeQL, danger, banned casts and build-sbom must also pass.
6. **Optional rerun:** ops/aud-119/AUD-OPUS-R12D-119/audit-opus-r12d-119-pg.spec.ts, together with the R12 probe and the #701 R2 spec, should reproduce exactly 35 passes and 2 failures (C-678-3 acceptance, and the C-679-4 evidence case). Any other result means behavior changed.
