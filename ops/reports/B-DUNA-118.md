# B-DUNA-118 — dunning D1 #687 + D2 #688 (builder, T4, agent 118 wave)

Started 10:18 PDT 10-04. Lock `dunning` taken 10:19 PDT. Times from `TZ=America/Los_Angeles date`.

## Status
- #687 (D1): FIX ROUND 2 at `38d9b3ab0be5bb39df8eb0986293b9d62f04ba37` (main merged first, merge-only: `51139d5a`).
- #688 (D2): FIX ROUND 3 at `2368d5fa1b5671123e2f6b330137b3ebb90be514` (D1 `38d9b3ab` merged, merge-only). READY FOR AUDIT: [comment 5982966284](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5982966284). All 7 required checks green.
- #687 READY FOR AUDIT: [comment 5982921310](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5982921310). All checks green at 38d9b3ab (CodeQL included; the first push fde7b047 drew one CodeQL test-regex alert, fixed in 38d9b3ab).
- Sizes (adds+dels, tests included; gh pr view = local diff): #687 2,681+/293- = 2,974; #688 2,363+/613- = 2,976. Both in the 1,500-3,000 band.
- D3-D5 (#689-#691) not touched.

## Findings closed (code + test that failed before, CI lane)
Failing-before runs: D1 [37221795789](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221795789) (13 failed / 22 passed, all predicted), D2 [37222199475](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37222199475) (6/6 new cases failed).

| Finding | Change (file:line at the new head) | Commit |
|---|---|---|
| Sol B-687-3 (+ C-687-7, same lines) | `coach-alert.emitter.ts:85-95` verified push through `pushToUser` (Expo ticket read): rejected ticket = failed (retried), no/invalid token = skipped, accepted = sent; display copy instead of the alert type. `dunning-v2.dispatcher.ts:357-368` passes `renderer.coachPush` and maps the code (`push_ticket-error`, `push_no_token`). Legacy callers keep `pushToCoach`. | fde7b047 |
| Sol B-687-4 / Opus B-687-5 (+ main dispute copy, Opus decision 2; C-687-6 same block) | `dunning-v2-client.hbs:9-17` dispute paragraph vs payment paragraph ("Saving a card there charges the amount owed to it, and once that payment goes through, your access stays on."), 2A paragraph only outside dispute cycles, now "access ends right away". `dunning-v2.copy.ts:178-207` dispute copy (what happened, what ends it, lock date, withdraw-with-bank route, reply-to-email support; no card/cancel promise; no amount); payment emails/blockers no attempt counts, no success claim before the payment goes through; coach dispute in-app/push/email. `renderer.ts:198,214` every `lr_*` key renders dispute copy; `dispatcher.ts:288` dispute blocker at every dispute step; `:269,:392` `dispute` flag to the templates. | fde7b047 |
| Opus B-688-7 (D1 part: template fallback) | `renderer.ts:98-117` `applyTokensTruthfully`: a sentence whose token has no value is left out (no `{cardLast4}`, no guessed history); used by renderPair/renderBlocker and the voice-policy push path (`dispatcher.ts`). COACH_EMAIL: four fabricated `({reason})` lines replaced by "Day 0 — {amount} — declined" + "Charge attempts on this invoice so far: {attempts}". | fde7b047, 38d9b3ab (CodeQL regex split) |
| C-688-10 (same lines as B-688-7) | Coach email: the `tgp://` link (not clickable in mail; the https universal link would not open the app because AASA serves only /join and /invite) is replaced by a true route: "The full record is in the app: open Clients, then {clientName}." (tab label `Clients`, mobile CoachNavigator.tsx). | fde7b047 |
| Sol B-688-7 (support) | `test/support/dunning-v2-fake-prisma.ts:291-292` sorts like PostgreSQL (DESC nulls first, ASC nulls last, `nulls` overrides). | fde7b047 |
| Opus B-688-6 | `dunning-v2.service.ts:890` tryLock CAS also fences `step_index: row.step_index` (a v1 reopen keeps entered_at and sets step -1). | 4879e81a |
| Sol B-688-6 (= Opus C-688-8, same lines) | `dunning-v2.service.ts:1308` the marker is written only when `isDisputeCycleOpen(purchase, tx)` under the row lock (an obligation outstanding in THIS cycle); an earlier cycle's replayed closure keeps its old closed_at and marks nothing. `:1232,:1249` optional `closedAt` (event time) for a first closure (D4 must pass it, see HANDOFF). | 4879e81a |
| Sol B-688-7 | `dunning-v2.service.ts:1487-1495` getClientStatus: eligibility in the query (`billing_type`, `amount_cents > 0`, subscription id) and `locked_out_at: { sort: 'desc', nulls: 'last' }`; the in-memory filter stays. | 4879e81a |
| Operator B (1) / W3 | `dunning-v2.service.ts:1659-1663` resolvePurchaseFromCharge rethrows read errors; only a Stripe 404 is a clean miss. D4's runDisputeEffect turns the throw into a redelivery. | 4879e81a |
| Operator B (2) / W4 | `dunning-v2.service.ts:1048-1070` an obligation that is open after the write (new or still open) on a resolved state opens the compressed cycle whatever the dispute's created time; with no dispute id the old time rule stays. | 4879e81a |
| Operator B (3) (B-689-5 rule in #688) | `dunning-v2.service.ts:1525` status `amount_cents: null` for a dispute cycle; `:1580` no `amount` token for dispute-cycle notices (dispute copy carries no amount). `:1582` `attempts` token from `last_attempt_number` (Opus B-688-7 D2 part). | 4879e81a |
| Pinned doc wording | `dunning-v2.service.ts:66` keeps the C-628-12 sentence D5's r3 spec reads (found by the composed D5 run below). | f1ba91fd |
| Type-check | `test/dunning-v2-service-fixes.spec.ts` helper takes `FakeModelName` (CI Type-check failed at f8a1a705). | 2368d5fa |

## Probe replays (every prior probe, both lenses)
- D1 @ 38d9b3ab: [37222815158](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37222815158) — Sol 118 `687-probe` (coach push failed on error ticket; dispute email keeps the button, no "paid with it ... stays on"): pass; Opus 118 `aud-opus-d12-118-687` (payment Day-7 email has button + "your access stays on"; dispute steps 2/3 subject "Your recent payment was reversed", no settle/access promise): pass; Sol 116 `aud-sol-d12-116-d1`: pass. Earlier head fde7b047: [37222330624](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37222330624).
- D2 @ 2368d5fa: [37223188413](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37223188413) (12 suites, 150 passed) — Opus 116 lost-dispute, Sol 116 d2, Sol 118 `688-probe` + `688-probe-v2` (historical lost replay {disputed:false, lifted:true, lock:null, entitled:true}; 10 unlocked + 1 locked = locked under PostgreSQL order), Opus 118 `aud-opus-d12-118-688` parts 1-4, plus the D1 probes. Earlier heads: 4879e81a [37222486072](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37222486072), f1ba91fd [37222718246](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37222718246), f8a1a705 [37222827176](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37222827176) — all pass.
- Opus D34 #690 probe W0-W4 on D4 `06307883` + this D2 (local compose, public-pages conflict taken from D4, never pushed to a PR): [37222543599](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37222543599) — W0, W1, W2, W3, W4 pass.
- Ripple check for B-DUNB-118: D5 `e0afe678` + this D2 (local compose): 13 dunning suites, 287 tests; only failure was the pinned C-628-12 sentence, restored in f1ba91fd; after it the r3 suite passes (70/70).

## Money self-check
- Webhook order and redelivery: W4 gives the same dispute cycle whichever of dispute.created / invoice.paid is processed first (W0 + W4 green); W3 a failed purchase read throws so the dispute event is redelivered, never acknowledged; an earlier cycle's lost closure replayed later is effect-free for the current cycle.
- Concurrency: tryLock CAS fences status, lock, cancel, entered_at and step_index; the dispute marker is decided under the DunningState row lock from a fresh read. Lock order tryLock (DunningState then ClientPurchase) vs invoice.paid is unchanged: C-688-9 below.
- Terminal states: lost before this cycle = not this cycle's; won with a transient read failure = redelivered; 2A copy is not shown in dispute cycles (cancel never resolves a dispute); a coach with no device token = skipped with a code, not sent.
- Pagination/completeness: getClientStatus filters eligibility in the database and orders locks first (NULLS LAST), so `take: 10` cannot hide a lock; fails closed.
- Currency: a dispute cycle shows no amount (the renewal amount is not the disputed charge's); payment amounts still go through formatMinor (minor units, presentment currency of the purchase).
- Copy truth: no surface claims a card update pays or keeps access before the payment goes through; dispute surfaces never offer a card update or a cancel as a fix; no raw token renders (every step × cycle kind × variant tested).

## Open question (operator mail): `no_state`
A dispute on a purchase that never failed a renewal records the obligation and opens no cycle (`dunning-v2.service.ts:1061`). No binding dunning ruling covers it: the D12 rulings (retries Days 1/3/7, Day-10 lock, 1A, 2A, voluntary cancel, free/code grants, cancel during a dispute cycle ends access and never resolves the dispute) and OR-111-1 (refund/chargeback: coach alert with exact amounts, reverse that charge's transfer, forward-only netting) say nothing about locking access on a first-ever dispute. Behaviour unchanged. Note that after W4 the outcome depends on whether the purchase ever had a failed renewal (a resolved state opens a cycle; no state does not). Recommended default: owner rules that a dispute on any cleared payment of an eligible paid subscription opens the compressed cycle (create the DunningState row), built in a later D2 round with its own tests (D2 has 24 lines of headroom, so it needs a size decision).

## Follow-ups (C)
- C-687-4: note only (OR-113-4), unchanged.
- C-688-9 `dunning-v2.service.ts:877` (lockDunningState) then `:896` (ClientPurchase update) vs invoice.paid order (ClientPurchase then DunningState): deadlock possible, both sides retry-safe. Fix rule: lock ClientPurchase first in tryLock.
- Payment-cycle push copy still pinned by the Roman voice policy: `dunning-v2.copy.ts:61` DAY1_PUSH "I attempted it again today without success. Updating your card will settle it.", `:76/:78` DAY3_PUSH "Three attempts" / "tried three times", and the voice-policy LEGACY/ROMAN_V2 constants with `test/_fixtures/roman-voice-legacy.snapshot.json`. Fix rule: same copy-truth rule as B-687-4 (no attempt counts, no settle promise before the payment goes through), snapshot updated in the same PR.
- `dunning-v2.copy.ts:159` LOCKOUT_SCREEN "did not clear after several attempts ... Update your card to restore everything at once" (pinned lockout copy). Fix rule: "access comes back once the new card's payment goes through"; no attempt claim.
- `dunning-v2.dispatcher.ts:302` the blocker body is cut at 160 characters (pre-existing); the new copy fits. Fix rule: never cut mid-sentence (carry the full body in the payload).
- `dunning-v2.dispatcher.ts:310` the dispute blocker deep link is still `tgp://billing/update` (card screen) under the "See details" CTA. Fix rule: route dispute blockers to the dunning status screen.
- `dunning-v2.service.ts` handleLateReversal does not store the disputed charge's amount, so dispute surfaces show none. Fix rule: read the ChargeDispute amount (ledger) when present and show it; otherwise no amount.
- main `notifications.service.ts:689` pushToUser logs `ticket.message` (provider text) on an error ticket. Fix rule: log the ticket code only.
- main `checkout-webhook-handler.service.ts:1176` (v1 recordFailure) stores raw `last_payment_error.message` as the failure reason; no dunning v2 copy uses `{reason}` any more. Fix rule: store a decline code.

## Operator decisions (recommended default first)
1. Size: accept #687 at 2,974 and #688 at 2,976 (both under 3,000, cohesive). D2 comment blocks were condensed to fit the new tests; `git diff 49c50f6e f8a1a705` with comment lines removed shows only the changes listed above.
2. Payment-cycle push and lockout copy (pinned by the voice policy): default, a Roman copy-truth PR before FEATURE_DUNNING_V2 is switched on.
3. `no_state` dispute: default as above (owner ruling; build later).

## HANDOFF
- For B-DUNB-118 (D3/D4): restack onto D2 `2368d5fa1b5671123e2f6b330137b3ebb90be514`. Composed D5 + this D2 passes the 13 dunning suites. In D4 `runDisputeEffect` pass `closedAt: new Date(event.created * 1000)` to `onDisputeClosed` (checkout-webhook-handler.service.ts:325 at 06307883) so a delayed first closure uses its own time. The fake now sorts DESC with nulls first (PostgreSQL); compose run showed no D3-D5 test depends on the old order. Coach dunning pushes now go through `pushToUser` (mocks that only stub `pushToCoach` see a failed coach push).
- Done 11:18 PDT: notify/dunning.txt written ("dunning D2 top: #688 @ 2368d5fa... (B-DUNA-118, 11:16 PDT)"); ci/B-DUNA-118-* and wip/B-DUNA-118-d1 deleted; lock `dunning` released; worktrees wt/B-DUNA-118-1/-2/-3 removed (node_modules unlinked first). Evidence (FIX ROUND texts, PR bodies, CI logs): ops/reports/B-DUNA-118-evidence/.
- Not touched: #689-#691. Waiting on: Opus + Sol re-audit of #687 @ 38d9b3ab and #688 @ 2368d5fa; operator decisions 1-3 above.
