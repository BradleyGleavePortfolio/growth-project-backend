AUDIT Claude Opus 5.5 — growth-project-mobile#386 @ 0a1bc0bd7d18348742184a2e5dcac1a1c961748d — VERDICT: REQUEST CHANGES

Lens AUD-OPUS-W2B-123 (agent 123), job CL1. Full review at the exact head against backend main e6f9a5ec (src/coachless, src/feature-flags, src/invite-codes, src/filters/http-exception.filter.ts). Required checks green at this head (Typecheck, lint, test; CodeQL). Size 1,189 changed lines (under 1,500). Title Conventional Commits, tier header present, no new `as any` / `as unknown as` / `as never`, no empty catch, copy has no first person.

**A: 0 | B: 1 | C: 3**

### B
- **B-386-1 — iOS: the coachless hand-off opens the Stripe "Choose your plan" sheet, the purchase surface every iOS build hides (App Store 3.1 posture).** `src/components/coachless/CoachlessHomeSlot.tsx:124-137` (onChoosePlan -> `<PackageSelectionSheet visible ...>`), no `nonP2PPurchasesHidden()` check anywhere in `src/components/coachless/*`. The app's store package P0 rule (operator 2026-09-30; `src/lib/packagePromptGate.ts:15-20`, `src/entitlements/PaywallSheet.tsx:15-25`) is that on iOS the only purchase surface is the clearly labelled 1:1 coaching screen (ClientPackages, `oneToOneCoachingLabel`, "1:1 coaching with <coach>"), and both existing openers of PackageSelectionSheet (Day1WinScreen, RootNavigator `package_prompt`) suppress it on iOS via `shouldOfferPackagePrompt()`. `nonP2PPurchasesHidden()` is true on every iOS release build (native build >= 6). The sheet's copy is "Choose your plan / Start with a plan that fits your goals", which does not name the coach or the 1:1 service (decision 09-30 11:48: "the purchase copy names the individual coach").
  Normal-user story: an iPhone user with no coach taps "Use code GP-XXXX" on Home, joins, taps "Choose a plan" and is shown the unlabelled Stripe plan sheet that App Review is told does not exist on iOS, which puts the 10-07 iOS submission at risk of a 3.1.1 rejection once coachless_home is on.
  Fix rule (small): when `nonP2PPurchasesHidden()` is true, "Choose a plan" navigates to the labelled 1:1 coaching screen (`navigation.navigate('MoreTab', { screen: 'ClientPackages' })`, as RootNavigator's onOpenPlans does) instead of opening PackageSelectionSheet; Android keeps the sheet with `initialPackageId`. One test with `nonP2PPurchasesHidden` mocked true asserting the navigate and no sheet.

### Builder deviation (a code that already includes a plan never goes to pay): agreed
`grantState` maps grant `created` / `already_active` -> Done and `pending_consent` -> message the coach; only `grant === null` (or `revoked_not_regranted` / `package_unavailable`, which grantState returns null for) with `packages_available > 0` offers a plan. This matches the backend AttachGrant statuses (src/invite-grant/invite-grant.service.ts:56-70) and prevents asking a client to pay for a plan the code already gave them. Correct.

### Checked and fine
- Flag off: `coachless_home` is false from /me/feature-flags unless FEATURE_COACHLESS_HOME is on and role is student (feature-flags.service.ts:72); the slot returns null and the query is disabled, so nothing renders and no request is sent.
- Contract: zod schemas match CoachlessHomeResponse, the check union (extra `message` is stripped) and RedeemResponse (grant, replayed); refusal `code` reaches the client through the global filter (http-exception.filter.ts:61-64,102); every COACHLESS_ERROR code has specific copy.
- Idempotency-Key: one UUID per normalised code, reused on retry, dropped on success and on idempotency_key_reused/_required; backend lets a failed key be retried (claim reclaim), so redemption_failed + same key is not a dead end.
- Roman card: server text verbatim, shown only while roman_card and banner.code are set, one /seen per displayed card, Not now hides and persists.
- "Message coach" -> HomeStack `Messages` route exists (ClientNavigator.tsx:406).

### C (one line each)
- C-386-1: pending_consent grant routes to the coach thread; mobile has no POST /consent/grant `onboarding.agreement` surface (builder's C-386-a; contracts off at launch).
- C-386-2 C (edge, deferred to 10k clients): PackageSelectionSheet 24 h Skip suppression can close the hand-off sheet for a user who skipped a previous coach's sheet in the last 24 h.
- C-386-3: Join stays enabled while the live check shows a refusal; the server answers with the same specific refusal, so it is cosmetic.

Re-review scope: B-386-1 and the changed lines only.
