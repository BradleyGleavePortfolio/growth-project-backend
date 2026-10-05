FIX ROUND 2 (B-LOCK2-120, agent 120) — growth-project-mobile#353 @ 9d47045b63a4680d852591ae3b4b2d3bfb1e0d85

#352's new head `c89f719c` merged first (merge commit `b587e20f`, clean), then one fix commit `9d47045b`. Size: +2679 / -44 = 2,723 changed lines vs #352 (grandfathered cap 3,000).

Contract followed: backend D2c #705 @ `279ec167` (read only): a dispute is `locked` (or `past_due` with `lock_waived` when another plan keeps access), `reason: 'dispute_paused'`, no lock date, no card or cancel route, `restart_by: 'coach'`. Older envelopes with no `reason` get the same ruling copy; today's production (no dunning routes) still shows nothing.

| Finding | Change | Commit | Test (fails before -> passes after) |
|---|---|---|---|
| B-353-3 (Sol) / B-353-6 (Opus) dispute banner showed a lock date and "unless it is sorted out"; lockout summary and next step lacked the three facts | Banner: "Your bank reversed a payment of X to Coach." + `disputePauseFacts(coach, 'plan')`; no date, no condition, Message coach only. Lockout: title "Your access has ended"; summary = what the bank did + the ruling sentence (scope 'account' when the dispute locks the app, 'plan' when another plan keeps access); next step "Message Coach to talk about restarting. For any other question, email support." `isDisputeCycle` also reads D2c `reason`. | 9d47045b | `dunningLockoutOwnership.test.tsx` "B-353-2 / B-353-3 (Sol)" (dispute lockout, D2c envelope, banner, closure stays paused) |
| B-353-7 (Opus) support as the fix, "Already paid?" footnote, Update card and future-payment line on dispute surfaces | Dispute lockout: Message coach is primary; no Update card, no End my plan (D2c has no cancel route), no "Already paid? Pull down"; "Email support" stays in the list. Update card intro: the ruling sentence, no "future payments", no support fix; Message coach button; no End my plan. Payment-plan quote naming another plan's dispute uses the same line (`disputeNotSettledLine`). End-plan body for a dispute (no screen offers it): "Access to this plan has already ended and its billing is paused. Your coach decides whether to restart it. If you end it, the plan ends now instead." | 9d47045b | same block (end-plan body, intro + banner, dispute-only save, quote note) |
| B-353-2 (Sol) a retained End my plan confirmation sent a cancel after its screen or provider was gone | Owner bound when the dialog opens on both screens (screen alive + auth generation + the plan shown); `onPress` returns before any state write or dispatch when retired. Provider `endPlan(surface, owner)` checks owner, provider and generation before sending and sends the confirmed `purchaseId`, never one loaded since. A cancel already sent still refreshes the same account's status; a retired screen shows nothing. | 9d47045b | "B-353-2: an End my plan confirmation belongs to..." (5: screen left, account changed (both screens), lockout lifted + confirmed plan sent, sent-then-left, CONTROL live) |

Failing-before (tests only, on `b587e20f`): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37344411159 (10 failed, 29 passed: every finding test fails, controls pass). After, at `9d47045b` + every probe of both lenses for #352 and #353 + `dunningLockout`, `dunningL1Contract`, `rootNavigatorUpdateCardLink`: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37344434190 (145/146; the 1 is Sol 119 Boundaries probe 1 on #352, see that PR).

Probe replay (both lenses, at `9d47045b`):
| Probe | Lens run | Now |
|---|---|---|
| Sol `auditSol117Lifecycle` CONTROL locked status shows the lockout | pass | pass |
| Sol B-353-1 retired provider cannot relock the next account | pass | pass |
| Sol B-353-1 older clear cannot overwrite a newer lock | pass | pass |
| Sol B-353-2 leaving while the quote is pending | pass | pass |
| Sol B-353-2 late native return sends no confirm | pass | pass |
| Sol B-353-3 dispute lockout: no card promise | pass | pass |
| Sol B-353-3 dispute-only save explains the reversal | pass | pass |
| Sol CONTROL paid receipt | pass | pass |
| Sol R-DISPUTE-PAUSE legacy envelope: no lock date, three facts | fail | pass |
| Sol R-DISPUTE-PAUSE lockout + Update card: three facts | fail | pass |
| Sol B-353-2 End plan accepted after unmount sends nothing | fail | pass |
| Sol CONTROL live End plan cancels purchase-A | pass | pass |
| Opus 119 `aud119OpusL12_353` CONTROL payment banner "by Sunday, October 11" | pass | pass |
| Opus 119 dispute banner: no date, no "unless" | fail | pass |
| Opus 119 dispute Update card intro (pre-lock): access ended | fail | pass |
| Opus 119 CONTROL payment next step names Update card | pass | pass |
| Opus 119 lockout summary + next step: the ruling | fail | pass |
| Opus 119 rendered dispute lockout: no "Already paid" | fail | pass |
| Opus 119 dispute Update card intro: coach restart, no support fix | fail | pass |
| Opus 119 dispute End my plan body: coach restart, no support fix | fail | pass |
| Opus 119 dispute banner: coach restart | fail | pass |
| Opus 117 `aud117OpusL12` (12: 3 CONTROL + 9 PROBE incl. dispute end-plan "ends now") | pass | pass (12/12) |

Money list:
- Webhook order and redelivery: no webhooks in the app; a closed dispute changes nothing on screen until the server reports the coach's restart.
- Concurrency and lock order: no client locks; each End my plan confirmation and card run is owned by its screen, the auth generation and (for cancel) the confirmed plan; the provider never takes a new owner.
- Terminal states: dispute = access ended, billing paused, coach restarts, no card or cancel path; payment lock keeps Update card, End my plan and "Already paid?"; canceled (2A) and voluntary copy unchanged.
- Pagination and fail-closed completeness: status and quote normalisers fail closed; a malformed status never clears a lock.
- Currency and minor units: integer minor units from the server; per-currency totals, never summed.
- Copy truth: only server-decided facts; no first person (guard tests), no exclamation marks, no emoji; true on today's production (nothing shown).

Checks at `9d47045b`: Typecheck, lint, test pass (https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37344789490) (the required check on a stacked base).

Follow-up Cs (frozen, in ops/reports/B-LOCK2-120.md): C-353-1 (copy and Sol bank-pending continuity), C-353-2, C-353-4, C-353-5, C-353-6, C-353-7.

READY FOR AUDIT
