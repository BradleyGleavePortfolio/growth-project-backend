FIX ROUND 3 (B-LOCK3-121, agent 121) — growth-project-mobile#353 @ 78ed4e077bcc91d7bbb605510c138931f6b30ad0

New #352 head `da686cea` merged first (merge commit `ea85256e`, clean; its tree `7c57d624` equals `git merge-tree --write-tree 9d47045b da686cea`), then one fix commit `78ed4e07` (4 files, +77 / -24). Size vs #352: +2,732 / -44 = 2,776 changed lines (cap 3,000).

| Finding | Change | Test (fails before -> passes after) |
|---|---|---|
| B-353-8 (Sol 6001849106) = B-353-9 (Opus 6002249515): banner, lockout and Update card say the bank reversed or took back a payment; false for an inquiry | Same L1 wording as B-352-9. `DunningBanner.tsx:30-34`: title "Your plan is paused after a payment dispute or inquiry" (the backend D2c push title), body "Your bank opened a dispute or inquiry about a payment[ of $X][ to Coach]. ..." `DunningLockoutScreen.tsx:73` `lockoutSummary` and `UpdateCardScreen.tsx:92` `updateCardIntro`: "Your bank opened a dispute or inquiry about a payment[ of $X] to Coach." + `disputePauseFacts`. Nothing else changes: Message coach first, no card or End my plan path, no date, no support fix. | `dunningLockoutOwnership.test.tsx` "B-353-8: an inquiry (D2c envelope, no amount) is a dispute or inquiry on every surface" (helpers + mounted lockout, waived banner, Update card; CONTROL failed payment keeps "Update your card") + 4 updated dispute tests |

Operator ruling (13:2x) on Opus B-353-10 (dispute lockout's only way back is Message coach, but the backend `DunningLockoutGuard` blocks `/messages`): the fix is on the BACKEND, owned by B-DUND2D-121 (the guard lets a locked client reach their own coach's messages). Mobile keeps the button and needs no change; B-353-10 closes when that backend head is cited. The backend refusing a waived dispute also goes to B-DUND2D-121. C-353-9 closes with it.

Evidence (runner incident; `_COMMON_121` item 11):
- Failing-before lane on old #354 `68c7f080`: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37370885732 (queued). Locally via heavy.sh (`ops/aud-121/B-LOCK3-121/local_failing_before_r3.log`): `dunningLockoutOwnership` 5/40 fail (the dispute copy tests), Sol `auditSol121InquirySurfaces` 6/7 fail, Opus `aud121OpusL3_353` 4 B-353-9 PROBEs fail.
- After, locally at #354 `be5c74b1` + probes (`ops/aud-121/B-LOCK3-121/local_after_r3.log`): `dunningLockoutOwnership` 40/40, `dunningLockout` 37/37, `rootNavigatorUpdateCardLink` 5/5, `api.lockedDunning` 7/7, `authActions.signOut` 5/5, tsc 0 errors, eslint clean.
- PR CI at `78ed4e07`: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37371187450 (queued).

Probe replay (both lenses, after = local at `be5c74b1`):
| Probe | Before | After |
|---|---|---|
| Opus 121 `aud121OpusL3_353` 4 B-353-9 PROBEs | fail | pass (18/18; VERIFY B-353-2 x3, B-353-6/7, CONTROL pass) |
| Sol 121 `auditSol121InquirySurfaces` 6 B-353-8 + CONTROL | 6 fail | pass (7/7) |
| Opus 119 `aud119OpusL12_353` | pass | pass (9/9) |
| Opus 117 `aud117OpusL12.probe` | pass | pass (12/12) |
| Sol 117 `auditSol117Lifecycle` | pass (FIX ROUND 2) | 11/12: "dispute-only quote still explains unresolved access" throws in the probe's `queryByText(/reversed|disput/i)` because two elements now match (the intro and the saved-card line both say "dispute or inquiry"); the same check with `queryAllByText` passes (2 hits). Harness, not a regression; the lens re-pins it. |

Money list:
- Webhook order and redelivery: none on mobile.
- Concurrency and lock order: unchanged.
- Terminal states: dispute or inquiry = access ended, billing paused, coach restarts; no lock date, card or cancel path.
- Pagination and fail-closed completeness: unchanged.
- Currency and minor units: amounts from integer minor units, shown only when the envelope carries them.
- Copy truth: no surface claims money moved; the three facts kept; no first person, no exclamation marks, no emoji, no generic error.

Follow-up Cs (frozen, in `ops/reports/B-LOCK3-121.md`): C-353-1, C-353-2 (remainder), C-353-4, C-353-5, C-353-6, C-353-7, C-353-8; C-353-9 with B-353-10 (backend).

READY FOR AUDIT
