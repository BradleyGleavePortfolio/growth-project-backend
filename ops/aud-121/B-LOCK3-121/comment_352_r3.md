FIX ROUND 3 (B-LOCK3-121, agent 121) — growth-project-mobile#352 @ da686ceaa0386f03ac430e01a933a10c95fe369f

Main `b79ca594` merged first (merge commit `2ba29a9d`, clean; its tree `a19407d8` equals `git merge-tree --write-tree c89f719c b79ca594`), then one fix commit `da686cea`. Size: +2,625 / -6 = 2,631 changed lines vs main (grandfathered cap 3,000). Fix commit alone: 5 files, +64 / -19.

Contract followed: backend D2c #705 @ `2a03d7dd` (read only) reports a dispute and an inquiry with the same envelope and its own wording "The bank opened a dispute or inquiry about a payment."; no field says whether money was withdrawn, so all copy is neutral.

| Finding | Change | Test (fails before -> passes after) |
|---|---|---|
| B-352-9 (Sol 6001848621) = B-352-9 (Opus 6002249084): dispute copy says the bank reversed a payment; false for an inquiry | `disputeNotSettledLine` (`dunningErrorCopy.ts:497-498`): "Your bank opened a dispute or inquiry about a payment[ of $X][ to Coach]." / "disputes or inquiries about payments" for several; `disputePauseFacts` unchanged (access ended, billing paused, coach decides). `cancelOutcomeCopy` dispute branch (`:636`): "Your bank had opened a dispute or inquiry about a payment on this plan, ...". Comments in `dunningApi.ts`, `services/api.ts`, README say the same. No "reversed", "took back", "refund", "settle"; no card or support fix. | `dunningL1Contract.test.ts` "B-352-9: an inquiry ... is never called a reversal" + 3 updated strings |
| C-352-11 (Opus; same line as the B-352-9 fix) | The noun counts disputed payments, the scope counts plans: two disputes on one plan read "disputes or inquiries about payments of $50.00 to Avery. For that plan, ..." | same test |

Deferred under the owner edge-case freeze (13:29, `_COMMON_121` item 13; operator confirms):
- B-352-3 (Sol): C (edge, deferred to 10k clients). It needs a second card update to start while a card form is already on screen (the form is modal; only a deep link, push or account switch during the form reaches it). This head keeps the reviewed FIX ROUND 2 latch (owner check between `initStripe` and `initPaymentSheet`, newest session only). A tested native UI lease + operation-session patch is parked, not on this head: `ops/aud-121/B-LOCK3-121/B-352-3-native-ui-lease-deferred.patch`.

Evidence (GitHub Actions runner incident; `_COMMON_121` item 11):
- Failing-before lane (tests + both lenses' L3 inquiry probes on old #354 `68c7f080`): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37370885732 (queued). Same specs locally via heavy.sh (`ops/aud-121/B-LOCK3-121/local_failing_before_r3.log`): `dunningL1Contract` 4 fail (the 4 changed dispute tests), Sol `auditSol121InquiryCopy` 3/4 fail, Opus `aud121OpusL3_352` 3 PROBEs fail (19 VERIFY/CONTROL pass).
- After, locally at the new #354 head `be5c74b1` + probes (`ops/aud-121/B-LOCK3-121/local_after_r3.log`): `dunningL1Contract` 19/19, tsc 0 errors, eslint clean on changed files.
- PR CI at `da686cea`: CI https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37371188513 and CodeQL https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37371188469 (queued).

Probe replay (both lenses, after = local at `be5c74b1`):
| Probe | Before | After |
|---|---|---|
| Opus 121 `aud121OpusL3_352` 3 B-352-9 PROBEs | fail | pass (22/22) |
| Opus 121 `aud121OpusL3_352` "A already inside initPaymentSheet" VERIFY | pass | pass |
| Sol 121 `auditSol121InquiryCopy` (3 B-352-9 + CONTROL) | 3 fail | pass (4/4) |
| Sol 120 `auditSol120PresentationOwner` 2 B-352-3 | fail | fail by design (deferred C edge above); CONTROL passes |
| Sol 120 `auditSol120Boundaries` | pass | pass (5/5) |
| Sol 117 `auditSol117DunningIdentity` | pass | pass (4/4) |
| Opus 119 `aud119OpusL12_352` | pass | pass (5/5) |

Money list:
- Webhook order and redelivery: no mobile webhooks; state comes from the status read or a current-generation 403 only.
- Concurrency and lock order: unchanged from FIX ROUND 2 (newest-session latch); the lease is deferred as above.
- Terminal states: dispute or inquiry = access ended, billing paused, coach restarts; never a lock date, card or support fix.
- Pagination and fail-closed completeness: normalisers unchanged; dispute flags never dropped.
- Currency and minor units: integer minor units; disputed amounts summed per currency only.
- Copy truth: no claim that money moved; the three facts kept; no first person, no exclamation marks, no emoji, no generic error; nothing shows on today's production (no dunning routes).

Follow-up Cs (frozen, file:line and rule in `ops/reports/B-LOCK3-121.md`): C-352-1, C-352-2 (land #352-#354 as one train), C-352-3, C-352-6, C-352-8, C-352-10, C-352-12; B-352-3 as C (edge).

Landing (operator 13:2x): #352-#354 land together after the dunning backend deploys.

READY FOR AUDIT
