# B-LOCK-118 — mobile lockout L1 #352 + L2 #353 (+ L3 #354 merge-only restack)

Builder, Claude Opus 5.5, agent 118, T4. Started 10:00 PDT 10-04.

## Status
- 10:00 started; read rules, lens reports (AUD-OPUS-L12-117, AUD-SOL-L12-117), verdict comments, backend #691 contract, production 643817b3 routes.
- 10:20 #352 merged main 7fdb629a (merge commit fe2fa580) + fix ac244d22 pushed.
- 10:30 #353 merged L1 ac244d22 (1fbb7837) + fix 0dce9ed2 pushed.
- 10:31 #354 merge-only restack ea1e0ebd pushed (delta vs new L2 = nativeCardUpdate.test.tsx only, byte-identical). Lock removed, notify line written.
- 10:33 L2 test tightened (retired-provider read must not pass by a later healing read): L2 05d84f27, L3 restacked f084cc0f, notify line rewritten.
- CI lane: failing-before L1 37220096264 (17 fail / 10 pass), L2 37220987724 (30 fail / 39 pass; earlier 37220776092 superseded); after + probe replay L1 37220787955 (27/27), L2 37220800719 (89/89, at 0dce9ed2, source identical to 05d84f27).
- 10:40 PR CI green at all three heads; FIX ROUND 1 + READY FOR AUDIT posted on #352, #353; FIX ROUND 1 (restack, merge-only) + READY on #354. PR bodies: tier header + Fix rounds table.

## Heads
- #352 agent115/lockout-split-1-dunning-data @ ac244d22e107e93209a5e1d206d2951d3392fe38 (2335+6 = 2341 changed lines vs main: 1,500-3,000 band, say so)
- #353 agent115/lockout-split-2-lockout-screens @ 05d84f27261f1f764214be5a379785ba8f690d3e (2476+44 = 2520 vs L1 head: band)
- #354 agent115/lockout-split-3-card-update-tests @ f084cc0f8b1dbd4768d2ca168f0b49a90dc39cfe (1119, byte-identical test file to 37ed3d56)

## Findings -> change
- B-352-1 (Sol): dunningLockoutStore auth generation; retire() on authEvents logout/login, in resetUserScopedStores, and on provider unmount; api request interceptor stamps generation before token await; stale 403 dropped. Tests: api.lockedDunning.test.ts (B-352-1 block), authActions.signOut.test.ts.
- C-352-4 (same lines): LOCKED_DUNNING_MESSAGE neutral for both lock kinds.
- Job truth vs production: machineCode() treats only SCREAMING_SNAKE `error` as a code; production `{error:'Not Found'}` 404 -> BILLING_ROUTE_NOT_AVAILABLE (not reported, "nothing was charged"); bare 503 on confirm -> RESULT_NOT_CONFIRMED. Provider locks only on enabled && locked && !lock_waived. Tests: dunningL1Contract.test.ts, dunningLockoutOwnership.test.tsx "today's production" block.
- B-353-1 (Opus + Sol): provider not seeded from store; reads fenced by alive + generation + seq (latest wins); endPlan retired variant; unmount retires. EntitlementProvider syncs after mount.
- B-353-2 (Sol): UpdateCardScreen claimOwner() per action; isCurrent passed to runNativeCardUpdate/confirmWithBank (new `retired` result; checkpoints before/after every request and native step).
- B-353-2 (Opus) / B-353-3 (Sol) / C-352-5: dispute-aware lockout summary + next step (support primary), intro, banner, outcome copy (confirm plans[].dispute_open + quote disputes), cancel copy; shared endPlanAlertBody (dispute: ends now, not settled; payment: paid-in-the-meantime caveat).
- B-353-3 (Opus) / C-353-3 (Sol): "We charge it right away" and "our payment provider" removed; FIRST_PERSON guard over rendered screens.
- B-353-4 (Opus): accessibilityViewIsModal overlay; app wrapper hidden while lockout shows (always-present flex:1 wrapper).
- C-353-2 (same lines): "declined" only for payment kind before a card is saved. C-353-3 Opus (same lines): banner shows no waived/past lock date.

## Follow-ups (C)
- C-352-1 reference conventions: updateCard.ts (captureError contexts, `request_id` key) and dunningErrorCopy.ts reference handling should use supportReferenceOf/shortReference and the Sentry `reference` tag (rule: one reference helper across support surfaces).
- C-352-2: land #352 -> #354 as one unit (L1 behaviour tests live in L2/L3).
- C-352-3: dunningErrorCopy.ts RATE_LIMITED "Wait a minute" vs Retry-After 3600 (use the header when present); dead `step` branch in the STRIPE_UNAVAILABLE switch.
- C-352-6: #342 duplicate PaymentSheet theme / SDK loader; converge on one module when both land.
- C-353-1: dunningErrorCopy.ts "Tap Update card again" while the buttons read "Add a card" / "Try a different card" (rule: copy names on-screen buttons).
- C-353-1/C-322-4 (Sol): UpdateCardScreen bank-pending continuity across app restart (persist setupIntentId + pending kind, owner-scoped).
- C-353-2/C-322-3 (Sol) = C-353-4 (Opus): ClientPackagesScreen.tsx:237-244,296-303 native UpdateCard route vs #334 ordering (whichever merges second keeps the native route, no hosted portal).
- C-353-2 (Opus) remainder: UpdateCardScreen cardOnFile line reads status.card_last4; on a later visit while a new card's bank step is pending, the "was declined" suffix can still describe the new card (rule: carry a server flag for the declined card, or drop the suffix when a pending setup exists).
- C-353-5 release order: app.json fingerprint -> new binary; backend AASA /billing/update-card (#690) before the universal link ships.
- Docs: src/services/README.md:125 could mention the generation ownership of the lockout signal.

## Comments
- #352 FIX ROUND 1: https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-5982675004
- #353 FIX ROUND 1: https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-5982675120
- #354 FIX ROUND 1 (restack, merge-only): https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/354#issuecomment-5982675257
- Comment sources: ops/reports/B-LOCK-118_fixround_{352,353,354}.md

## HANDOFF
- DONE 10:40 PDT 10-04. READY FOR AUDIT at green heads: #352 ac244d22e107e93209a5e1d206d2951d3392fe38, #353 05d84f27261f1f764214be5a379785ba8f690d3e, #354 f084cc0f8b1dbd4768d2ca168f0b49a90dc39cfe. All mergeStateStatus CLEAN; mobile main still 7fdb629a.
- Next: Opus 5.5 + Sol verdicts at these exact heads (#354 needs a short merge-only delta). Operator SIZE ASSESSMENT for #352 (2,341) and #353 (2,520).
- Operator decisions: (1) size band for #352/#353, recommended accept (most of the growth is new tests: about 340 of 567 added lines on #352, 567 of 790 on #353); (2) land #352 -> #354 as one unit after backend #687-#691 deploy, flag off (recommended, unchanged).
- Cleanup done: ci/B-LOCK-118-* branches deleted; worktrees removed (node_modules unlinked first). Lock `locks/lockout` removed at 10:31; notify/lockout.txt has the top line for f084cc0f.
