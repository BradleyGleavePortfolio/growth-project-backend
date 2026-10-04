AUDIT Claude Opus 5.5 — growth-project-backend#679 @ 23d2c04c3d05cfc5a6594700152a9cf5336f3111 — VERDICT: APPROVE
A/B/C = 0/0/2

AUD-OPUS-R12D-119, agent 119. T4 delta audit of FIX ROUND 7 (B-RECUR7A-119). `8bbf4a41..23d2c04c` contains:
- the R1 round (audited in my #678 verdict at 09e159d8);
- one own commit, eeb23f2e, in `src/checkout/subscription-checkout.service.ts` (+25/-14), whose every line I read;
- two R1 merges, e96786eb and 23d2c04c. Both have an empty `git show --remerge-diff` (no conflicts).

The own patch is `09e159d8..23d2c04c`: 8 files, +2,943/-0. Outside eeb23f2e it is byte-identical to `77bce450..8bbf4a41`.

**Evidence reuse (G09):** every line outside eeb23f2e rests on this lens's APPROVE at 8bbf4a41, 0/0/1 ([verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/679#issuecomment-5983747222)). No verdict from the other lens is borrowed.

**Prior findings**
- **Opus C-679-4 is CLOSED.** With no SetupIntent, `attemptSettled` now answers settled only for `setup?.status === 'processing'` (service:1056).
  - `readTrialSetup` returns null only when there is neither a stored secret nor a pending SetupIntent, which means no sheet was ever handed out. In that case `retireAttempt` goes through the guarded `endUnpaid`, and the cancel is confirmed or the answer is retryable.
  - The path that lifts the own card is unchanged (`default_payment_method && !cancel_at_period_end` -> settled).
  - My R12 acceptance case now passes. Its "evidence" case now fails, as expected, because `prepared()` replays first and the trial has already ended.
- **I judged Sol B-679-10 (narrowed) as met:**
  - A bare customer default is never treated as a settled trial.
  - `endUnpaid` re-reads Stripe on a refusal.
  - `cancelSetupIntent` runs first, so a card saved meanwhile counts as settled and nothing is canceled.
- **I judged Sol B-679-11 as met.** `listPlans` (service:329-359) now runs two client-scoped queries:
  - `live`: entitled, trial started, or past_due/unpaid, uncapped.
  - `ended`: canceled, not entitled, no trial, capped at `take: 50`.
  - **Set algebra:** live ∪ ended equals the old filter (`ent ∨ trial ∨ canceled ∨ past_due ∨ unpaid`), and the two sets are disjoint, so there are no duplicates and nothing is lost.
  - The cap now applies only to history. The merged list is sorted newest first.

**Tests (#701 @ 5e8f1ceb holds this round's R2 spec).** test/b-recur7a-119-r2.spec.ts at 5e8f1ceb is byte-identical to the failing-before spec in 806b10cb.
- That spec, run on this exact head, passes 8/8 in my [CI lane run 37231743536](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37231743536) (audit commit 4d1b4323 = 23d2c04c + probe specs only).
- The cases cover:
  - control, two failed-before retire cases, and the C-679-4 acceptance;
  - the own-card control;
  - 50 newer abandoned attempts plus an older paid plan;
  - 60 ended plans plus older active and past_due plans (52 listed);
  - isolation from another client.
- Builder failing-before [run 37230129006](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230129006) concluded failure at 806b10cb (8bbf4a41 + spec only). After [run 37230205968](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230205968): its 12 failures match the FIX ROUND list.
- Same lane: the real-PostgreSQL send-fence cases (coach first, rollback, reciprocal identities, waiting lock) pass, and so does Sol's PostgreSQL probe. 37 tests ran: 35 passed and 2 failed, the expected C-678-3 acceptance and the C-679-4 "evidence" case.

**Money list**
- **Webhook order and redelivery:** not touched.
- **Concurrency:** admission and the advisory lock are unchanged. The send fence now covers both parties through R1, as proven in the #678 verdict.
- **Terminal states:**
  - An unproven trial ends through the guarded end, and is never reported as SUBSCRIPTION_ALREADY_ACTIVE.
  - A canceled plan that keeps access to the period end is `live`, because it is still entitled.
  - An ended trial (`trial_started_at` set) stays `live`, which bounds it at one per client per coach.
- **Lists:** every live plan is listed; ended history is capped at 50.
- **Currency:** not touched.
- **Copy truth:** ALREADY_ACTIVE is no longer claimed without the attempt's own card.

`createSubscription` is still reached only through `sendFenced` (service:701, :723).

**Size:** 2,943+0 against R1 (grandfathered, 57 lines of headroom).

**CI:** every required check emitted at this head is green (10 pass, 1 skipping). CodeQL, danger, banned casts and build-sbom must pass after the retarget to main.

### Builder decisions (operator default: accept both as Cs). Lens view: accept both.
1. **C-679-5**
   - **Where:** subscription-attempt.ts:65 and service:735-741.
   - **Behavior:** if the coach is deleted mid-send, the client is told "This checkout timed out before it was paid. Nothing was charged. Start again to see the current price." (I verified this in the probe: 0 creates.)
   - **Why it is safe:** nothing is charged, and the statement is true. The same finalization transaction archives the coach's packages (manifest CoachPackage `is_sellable: false`, `archived_at`), so the next start gets admission's own coded answer. The only gap is copy precision.
   - **Fix rule:** have `sendFenced` return a distinct `'coach_gone'`. The caller answers a coded `PACKAGE_UNAVAILABLE`-style 409: "This coach's plans are no longer offered. Nothing was charged."
2. **C-679-6**
   - **Where:** service:349-353.
   - **Behavior:** ended history is capped at 50 with no cursor.
   - **Fix rule:** add `before` cursor pagination on ended history once any client has more than 50 ended plans. Live plans must stay uncapped.

Also carried (not this lens's ID): Sol C-679-3 (service:1475-1525, same-key trial replay when both resources are missing).

**Landing:** the merge-only restack needs a short delta check. The own patch must equal `09e159d8..23d2c04c` per file, every restack merge must have an empty remerge diff, the size must stay at or under 3,000, and #701's spec must pass on the restacked R5.
