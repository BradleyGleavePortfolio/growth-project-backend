FIX ROUND 2 (M-COACHLESS-123, agent 123) — growth-project-mobile#386 @ 64c5bde0f20f3a39d76961e7eb9838dc515fa2d3

Delta from 0a1bc0bd: one commit (64c5bde0), 4 files, +157/-2. PR size now 1,344 changed lines (478 test), under 1,500.

**B-386-SOL-1 (Sol 6008549315) — fixed.** `CoachCodeSheet.tsx` join success now calls the shared `refreshEntitlement()` from
`useEntitlement()` (the same refresh the plan screens use after checkout), so a code with a free or prepaid plan unlocks the gate
right away instead of on the next foreground. Integrated regression `src/components/coachless/__tests__/CoachlessEntitlement.test.tsx`
mounts the real EntitlementProvider + ProtectedScreen + CoachlessHomeSlot: starts inactive (paywall shown, Workout hidden), redeems a
code with `grant.status: created`, taps Done, Workout content renders with no AppState event; getEntitlement called twice. It fails
with the fix reverted (checked locally) and passes with it.

**B-386-OPUS-1 (Opus 6008571221) — fixed.** `CoachlessHomeSlot.tsx` onChoosePlan: when `nonP2PPurchasesHidden()` (iOS builds),
navigate to `MoreTab > ClientPackages` (the labelled "1:1 coaching with <coach>" screen); Android keeps the Day 1
PackageSelectionSheet with the featured package selected. Tests: iOS case (navigate to ClientPackages, plan sheet never mounts) and
the Android story now also asserts no navigation.

Cs unchanged: C-386-SOL-1 / C-386-a (pending-consent recovery, contracts out of launch scope), C-386-SOL-2 / C-386-b
(C (edge, deferred to 10k clients): plan-sheet 24 h suppression).

**Evidence:**
- PR CI at this head: CI run 37409208185 (Typecheck, lint, full test suite) success; CodeQL 37409208559 success.
- Local heavy.sh, one file at a time: CoachlessEntitlement.test.tsx 1/1 (fails without the fix), CoachlessHomeSlot.test.tsx 12/12,
  copyVoice.guard 8/8, quietLuxuryDoctrine 10/10, iosStorePackagePurchasePosture 10/10; eslint src/components/coachless 0 problems.

READY FOR AUDIT
