FIX ROUND 1 (B-ADJB-122 / B-ADJM-122, agent 122) — growth-project-backend#655 @ 2902add5bb9f96c2ea488282ee1e6d727d203044

Merged origin/main 6aff479c (clean), one fix commit 2d356da4, then a merge-only refresh of main a70533d5 (2902add5; brings only #734's 4-line coachless fix, because PR CI at 2d356da4 was red solely on test/coachless/coach-code-redemption.spec.ts, the same 3 failures as main 6aff479c run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37390793076). Size vs main 2,156 lines (grandfathered, cap 3,000). Scope per the owner's RUTHLESS SCOPE rule: only findings with an ordinary-use story are fixed; the rest are proposed C below. FEATURE_ROMAN_ADJUST_ENABLED stays off (default OFF, unchanged). Mobile half m#337 is B-ADJM-122; no response shape change (mobile renders `roman_text` and `volume_pct` as sent; its WORKOUT_CHANGED fallback matches the new server sentence).

**Fixed (each with a failing-before test)**
- Opus B-655-1(a) / Sol B-655-8 (CI red at tsc): the spec's Prisma double no longer references itself (TS7022/TS7024 gone; lane tsc green).
- Opus B-655-1(b) (R2b wiring spec): box-2 reads go through `AiEgressService.consentedClients` (global AiEgressModule); `src/roman-adjust` no longer imports `ai-consent`.
- Opus B-655-1(c) / Sol B-655-7 (erasure): manifest decisions `WorkoutAdjustmentProposal.client_id`, `.coach_id`, `.decided_by_id` delete; `WorkoutAdjustmentEvent.actor_id` delete (events cascade; the append-only trigger refuses UPDATE, so no detach). The applied sets stay in the client's assignment snapshot.
- Opus B-655-2 (coach edits the workout, taps Approve, is told to refresh for a new suggestion that never comes): ADJUSTMENT_WORKOUT_CHANGED now reads "This workout was edited after Roman made the suggestion, so it was not applied. Open the workout to review it."
- Opus B-655-3 (suggestion made Friday evening reads "tomorrow's" on Saturday morning): the sentence names the workout weekday ("Saturday's"), never today/tomorrow, so it stays true whenever it is read.
- Sol B-655-6 (coach approves "by 50%" and the client gets 25% because of the one-set floor): `volume_pct` is the realized reduction in the sentence, the view and the audit row.
- Sol B-655-9 (first person on every card): "Roman suggests trimming Saturday's Lower Body A by 17%, from 18 to 15 sets. Reps and loads stay as you set them. Approve to apply it."
- Sol B-655-5, copy part ("averaged X hours over the last 3 nights" when two nights were tracked): "sleep has averaged X hours on the nights tracked in the last 3 days".
- Sol A-655-1 (a head coach reassigns a client to another team coach; the old coach still sees her HRV and resting heart rate and can approve or undo): list, approve, edit, dismiss and undo require the client to be the caller's current live client (`coach_id` = caller, not deleted); a stale pending row closes as `withdrawn` (reason `client_not_current`); other access is NOT_FOUND as before.

**Evidence**
- Failing-before (old source + the new specs, run one file at a time through ops/heavy.sh): service spec 7 failed (the six new B tests plus the corrected text/percentage expectation); rules spec 4 failed; ai-consent-wiring 1 failed; erasure-manifest-coverage 2 failed. At the fix: service 42/42, rules 13/13, wiring 7/7, erasure coverage 7/7, manifest-fk-order 10/10; eslint clean on the changed files.
- CI lane (5 specs + full `tsc --noEmit`): https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37391752566 — success.
- PR CI at 2902add5: all 10 workflows green, including CI build-and-test (full tsc + full jest) https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37392946592. PR CI at 2d356da4 was red only on the inherited coachless spec (main 6aff479c); the merge-only refresh cleared it.

**Proposed C (edge or scope; for the operator)**
- Sol B-655-1 write fence: needs a completion or edit committed in the same instant as Approve. C (edge, deferred to 10k clients).
- Sol B-655-2 start claim: needs the client mid-workout at the exact moment the coach approves, plus a new start API and mobile wiring. C (edge, deferred to 10k clients).
- Sol B-655-3 undo/dismiss after consent withdrawal: needs withdrawal inside the 10-minute undo window or with the card open; the list already closes withdrawn rows. C (edge, deferred to 10k clients).
- Sol B-655-4 direct approve of a passed workout: needs the card held open past the workout day with no reload; started or finished workouts are still refused. C (edge, deferred to 10k clients).
- Sol B-655-5 rule semantics (average vs count of short nights): needs an unusual input (a one-hour tracked night); the copy is now true. C (edge, deferred to 10k clients).
- Sol B-655-10 / Opus C-655-2 sub-coach suggestions: scope, not a break (the head coach sees and decides everything). Operator decision 1.
- Sol A-655-1 RLS half: SELECT policies still key on `proposal.coach_id`; the API (service role) enforces the current-client boundary and anon is revoked. C.
- ADJUSTMENTS_UNAVAILABLE says "Your workouts are unchanged", which can show after an unconfirmed Approve if the reload also fails (raised by the mobile builder). C.
- Opus C-655-5: an Edit that raises sets shows a negative "% less volume". C.
- Opus C-655-1, -3, -4, -6 to -13 and Sol C-655-1, -2: unchanged.

**Operator decisions (recommended default)**
1. Sub-coach suggestions: defer; head coach only at launch.
2. Sentence voice: now impersonal ("Roman suggests ..."); keep.
3. Migration 20270227000000 sorts before applied migrations but commutes: keep the name (A6.2 precedent).
4. Erasure: delete proposals with the client and with the proposing or deciding coach; keep.

Re-review scope (A2 item 3): the prior Bs above and the changed lines in src/roman-adjust/{service,rules,constants,module}.ts, src/account-deletion/account-deletion.manifest.ts and the two roman-adjust specs.

READY FOR AUDIT
