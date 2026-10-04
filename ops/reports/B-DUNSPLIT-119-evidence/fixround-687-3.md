FIX ROUND 3 (B-DUNSPLIT-119, agent 119) — growth-project-backend#687 @ c260a849ee31ecc7103d409783464fc1452751dd

**Size:** 2,822 changed lines (2,526+/296-), `gh pr view 687 --json additions,deletions` before push. Grandfathered (open before 12:33); under the 3,000 ceiling.

**Commits this round**
- `21e1deac` merge main `3e9a9a75` (merge-only).
- `6d9e3954` move `test/fixtures/stripe/dunning-v2/*.json` (7 files, 157 lines; only D5 specs read them) up to D2b #704, byte-identical.
- `59f2f851` R-DISPUTE-PAUSE copy: every dispute notice (client push, email, blocker, Day-7 escalation; coach in-app, push, email) says access has ended, billing for the plan is paused, and the coach decides whether to restart. No card button on the dispute email; no promise of payment, access or a charge; no first person.
- `13c008a6` test: the coach line "Restarting is your decision" is asserted on step 3, the step that reaches the coach.
- `c260a849` test(privacy): main's #700 guard lists legacy exception-text counts for `dunning-v2.dispatcher.ts` and `coach-alert.emitter.ts`; the D1 versions print none, so the exact-match list drops them (build-and-test was red on that one assertion).

**Closed:** owner ruling R-DISPUTE-PAUSE (copy half; the pause itself is built in D2c #705, and the copy only goes out after the Stripe pause succeeds there). AUD-OPUS-F3-119 note on dispute copy (client and coach state access ended / billing paused / coach decides).

**Superseded probe line:** Sol 118 `687-probe` line 75 expected `Update card in the app` in the dispute email. R-DISPUTE-PAUSE removes that path (billing is paused, a card update does not restart it). Replayed with `not.toContain('Update card in the app')` plus the pause sentence; every other assertion unchanged.

**Evidence (CI lane)**
- Failing-before: [37229268820](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37229268820) on `6d9e3954` + new tests: 5 failed / 58 passed.
- Passing-after at `13c008a6` (the only later change is the privacy list, covered by the PR build-and-test): [37230710669](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230710669): 113 passed, 0 failed (7 suites).

| Probe | Result |
|---|---|
| Sol 118 687-probe (adapted line 75) | pass |
| Opus 118 aud-opus-d12-118-687 | pass |
| Sol 116 aud-sol-d12-116-d1 | pass |
| dunning-v2-copy, foundation-fixes, coach-alerts-emitters, notification-emitters | pass |

**Money self-check**
- Webhook order/redelivery: copy-only here; send order is in D2c (notices after the Stripe pause). n/a in D1.
- Concurrency: no new writes. n/a.
- Terminal states: dispute copy does not change with won/lost/closed; nothing in the copy says a closure restores. Pass.
- List pagination/completeness: no list reads. n/a.
- Currency: dispute copy shows no amount. Pass.
- Copy truth: client and coach dispute text state exactly access ended, billing paused, coach decides; payment-cycle copy unchanged. Pass.

**Follow-ups (C):** see growth-project-backend#705 body and ops report; carried: LOCKOUT_SCREEN copy and LR_LOCKOUT_SCREEN reuse the card-update text (`src/checkout/dunning-v2/dunning-v2.copy.ts`), rule: dispute lockout text = access ended, billing paused, coach decides; dispute blocker deep link `tgp://billing/update`, rule: open the plan screen.

Stack: #687 D1 -> #688 D2a -> #704 D2b -> #705 D2c -> #689 -> #690 -> #691. FEATURE_DUNNING_V2 must stay off until #705 merges.
