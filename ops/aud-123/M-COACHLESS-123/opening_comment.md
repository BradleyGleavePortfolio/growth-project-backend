FIX ROUND 1 (OPENING, M-COACHLESS-123, agent 123) — growth-project-mobile#386 @ 0a1bc0bd7d18348742184a2e5dcac1a1c961748d

Tier T4 (attaches a client to a coach, hands off to paid checkout). Lenses: Opus + Sol at this exact head.

**What:** client Home for a person with no coach, gated by the server flag `coachless_home` (backend FEATURE_COACHLESS_HOME,
b#721-#723 + #734 on main): server banner (title, owner offer, featured coach + package while accepting), code sheet with live
validation (POST /coachless/coach-code/check) and Join (POST /coachless/coach-code/redeem, Idempotency-Key UUID per code, reused on
retry), welcome moment from the redeem answer, hand-off to the existing Day 1 `PackageSelectionSheet` with the featured package
selected (`initialPackageId`, new optional prop), scripted Roman card (server text verbatim; /roman-card/seen once per displayed card,
/roman-card/not-now persisted; shown only while the server returns it and the featured coach accepts). Specific copy for all 14
server refusal codes plus no connection / 429 / 400 / unexpected (request reference). A code that grants a plan never leads to
checkout (active -> Done; pending_consent -> message the coach).

**Story:** a person signs up without a code, sees the banner, taps Use code <featured code>, sees "Coach: <name>", taps Join, sees
"<name> is now your coach." and "Next, start the plan: <package>, <price>.", taps Choose a plan and lands on the plan sheet with the
featured package selected.

**Size:** 1,189 changed lines (339 test), under 1,500. No lockfile, no eas.json change, no `as any` / `as unknown as` / `as never`,
no empty catch.

**Evidence:**
- PR CI at the first head 28a77608 (run 37406619503): Typecheck, lint, test (full suite) success; CodeQL success.
- PR CI at this head 0a1bc0bd (run 37407056784): Typecheck, lint, test (full suite) success; CodeQL success (run 37407056724). The only delta from 28a77608 is the pending_consent next step + 1 test.
- Local heavy.sh, one file at a time: CoachlessHomeSlot.test.tsx 11/11, PackageSelectionSheet.subscription.test.tsx 37/37 (+2),
  useFeatureFlags.test.tsx 7/7, HomeScreen.macroMode 3/3, copyVoice.guard 8/8, quietLuxuryDoctrine 10/10.

**Owner config note:** Roman's pitch is FeaturedCoachConfig.roman_pitch_text; mobile renders it verbatim. Text to save with the
spelling fixed: "Sir/Ma'am, just so you're aware, TGP's top coach has available slots. Enter code <featured code> and join for
<price>. Interested?"

READY FOR AUDIT
