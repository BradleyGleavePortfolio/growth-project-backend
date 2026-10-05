# B-LOCK2-120 — mobile lockout #352, #353 (+ #354 merge-only restack)

Builder, Claude Opus 5.5, agent 120, T4. Started 09:28 PDT 10-05. Stack lock ops/lanes120/locks/lockout taken 09:28.
Worktrees: wt/B-LOCK2-120-352, -353, -354 (local branches wt/B-LOCK2-120-<n>; push with HEAD:<pr branch>).

## Start heads
- #352 agent115/lockout-split-1-dunning-data @ ac244d22e107e93209a5e1d206d2951d3392fe38 (base main cc4ceeed, BEHIND)
- #353 agent115/lockout-split-2-lockout-screens @ 05d84f27261f1f764214be5a379785ba8f690d3e
- #354 agent115/lockout-split-3-card-update-tests @ f084cc0f8b1dbd4768d2ca168f0b49a90dc39cfe

## Open findings (latest verdicts, agent 119)
- B-352-2 (Sol 5983776115): dunningErrorCopy.ts dispute outcome copy; mixed paid/disputed promises "Your plan updates within a few minutes"; dispute-only save omits access ended / billing paused / coach restarts.
- B-352-3 (Sol): updateCard.ts initStripe -> initPaymentSheet with no owner check between; retired A can replace B's native sheet.
- B-352-7 (Opus 5983819724): disputeNotSettledLine / cancelOutcomeCopy dispute say "Email support to sort it out"; must say the three ruling facts; no "sort it out", no "settle".
- B-353-2 (Sol 5983779129): retained End plan alert callback (UpdateCard + lockout) dispatches POST cancel after unmount; provider checks alive only after sending.
- B-353-3 (Sol) = B-353-6 + B-353-7 (Opus 5983819833): dispute banner future lock date / "unless it is sorted out"; lockout/UpdateCard/end-plan/banner copy omits the three facts; support as the fix; "Already paid?" footnote, Update card and "future payments" on dispute surfaces.
- Contract: backend D2c #705 @ 279ec167 getClientStatus dispute = state locked (or past_due + lock_waived), kind dispute, reason 'dispute_paused', access_ended/billing_paused true, restart_by 'coach', lockout_at/amount/update_payment_route/update_card_url/cancel_route null.

## Status
- 09:28 read _COMMON_120/119/118/116, AGENT_RULES, JOBS120 entry. Mobile deps READY present. Disk 61 percent.
- 09:45 read all four verdicts, both lens reports and probe files (ops/aud-119/AUD-{OPUS,SOL}-L12-119), backend #705 contract.

- 09:53 #352 pushed c89f719cd8f5863c4150af1da5b96e273df319d6 (on top of main merge 407065298f9d31648535932d9aa27fbf4f206d85, main cc4ceeed clean, PR files byte-identical). Fix: disputePauseFacts + dispute outcome copy scoped to the paid plan, status `reason` + no lock date for a dispute, native sheet session latch + owner check between initStripe and initPaymentSheet. Size vs main 2,586.
  - Failing-before (tests on 40706529): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37342797540 (11 failed / 7 passed: every finding test fails, controls pass).
  - After + probes (c89f719c + Sol 117/119 + Opus 119 probes): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37342847558 (43/44; the 1 is the Sol anchor below).
- 09:57 #353 pushed 9d47045b63a4680d852591ae3b4b2d3bfb1e0d85 (merge of #352 c89f719c = b587e20f, clean; then fix). Fix: ruling copy on banner/lockout/Update card/end-plan body, dispute lockout leads with Message coach, no Update card / End my plan / "Already paid?" for a dispute, Update card Message coach for a dispute; End my plan confirmation owner bound at alert creation on both screens, provider `endPlan(surface, owner)` checks owner + provider + generation before sending and uses the confirmed purchase id; a sent cancel still refreshes the same account's status. Size vs #352 head 2,723 (cap 3,000).
  - Failing-before (tests on b587e20f): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37344411159 (10 failed / 29 passed).
  - After + all probes both PRs (9d47045b + Sol 117 Lifecycle/119 Boundaries/117 Identity, Opus 117/119 x2, plus dunningLockout, dunningL1Contract, rootNavigatorUpdateCardLink): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37344434190 (145/146; the 1 is the Sol anchor below).
- 09:57 #354 pushed 68c7f080c1e7e7708e7c3b213ae9278b57ba3649 (merge-only of #353 9d47045b, clean; PR diff unchanged 1,119 = nativeCardUpdate.test.tsx only). Local targeted jest nativeCardUpdate 41/41. Notify line written; lock ops/lanes120/locks/lockout removed.
- PR CI: #352 @ c89f719c Typecheck, lint, test pass https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37344285154; Analyze JS/TS + actions pass https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37344285354. #353 @ 9d47045b pass https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37344789490. #354 @ 68c7f080 pass https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37344796375. All mergeable_state clean.
- 10:02 comments posted (READY FOR AUDIT): #352 https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-5999207160 ; #353 https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-5999207763 ; #354 https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/354#issuecomment-5999208351 . PR bodies: tier header (builder, evidence head, size) + Fix rounds row 2.
- Cleanup: all seven worktrees removed (node_modules unlinked first), local wt/* branches deleted, ci/B-LOCK2-120-1..4 deleted on origin. Comment sources in ops/scratch-B-LOCK2-120/.
- Decision D1 (copy anchor): Sol probe auditSol119Boundaries "mixed paid/disputed" asserts the old anchor "Saving a card does not settle that"; Opus B-352-7 fix rule says no "settle". Followed Opus and R-DISPUTE-PAUSE ("It does not restart on its own or with a new card."). That one assertion fails by design; its substantive checks (paid amount kept, no "Your plan updates within a few minutes") pass. Recommended default: accept; Sol re-pins the anchor.
- Decision D2 (Opus 117 probe "dispute end-plan says ends now"): kept satisfied ("If you end it, the plan ends now instead.") while the body leads with the ruling facts; no screen offers End my plan for a dispute.

## Follow-ups (C) (frozen, not fixed)
- C-352-1 updateCard.ts / dunningErrorCopy.ts reference conventions. Rule: follow repo reference style when next touched.
- C-352-2 land #352 -> #354 together (release order). Rule: merge as one train.
- C-352-3 dunningErrorCopy.ts RATE_LIMITED ignores Retry-After; dead step branch. Rule: read Retry-After; remove dead branch.
- C-352-6 #342 duplicate theme/SDK loader. Rule: one loader after both land.
- C-352-8 dunningLockoutStore.ts:114-115 'login' listener never fires (authEvents emits no 'login'). Rule: emit 'login' at sign-in or drop the listener.
- C-353-1 "Tap Update card" vs button labels (payment copy). Rule: copy names the visible button.
- C-353-1/C-322-4 (Sol) UpdateCardScreen.tsx bank-pending restart continuity. Rule: keep the pending SetupIntent across restarts.
- C-353-2 ClientPackagesScreen.tsx:239-244,290-302 native route vs #334; remainder "was declined" on a later visit. Rule: align with #334; declined only for this cycle.
- C-353-4 (Sol) ClientPackagesScreen.tsx:284-287 "our servers" (first person). Rule: no first person.
- C-353-5 release order fingerprint / AASA. Rule: ship AASA with the build.
- C-353-6 DunningLockoutScreen.tsx dunningSupportBody "after a failed payment" also for a dispute. Rule: kind-specific body.
- C-353-7 src/screens/client/README.md:165 "Stripe Billing Portal". Rule: describe the native Update card.

## HANDOFF
- Done. Final heads: #352 c89f719cd8f5863c4150af1da5b96e273df319d6 (base main cc4ceeed), #353 9d47045b63a4680d852591ae3b4b2d3bfb1e0d85, #354 68c7f080c1e7e7708e7c3b213ae9278b57ba3649. Fix round 2 (merge-only on #354). All required checks green at each exact head. READY FOR AUDIT on all three.
- Closed: A 0; B 6 (B-352-2, B-352-3, B-352-7, B-353-2, B-353-3, B-353-6/B-353-7 as one dispute-copy fix). Cs frozen: 12 listed above.
- Next: both lenses re-audit #352 and #353 at these heads (#354 merge-only check). Sol re-pins its probe-1 anchor if D1 accepted.
- Operator decisions: D1 accept the ruling sentence over the old "does not settle" anchor (recommended default: accept). D2 none needed (Opus 117 end-plan probe kept passing).
- Lock released; notify line written to ops/lanes120/notify/lockout.txt.
