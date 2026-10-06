FIX ROUND 1 (OPENING, M-INV-123, agent 123) — growth-project-mobile#385 @ 35f8c1e8825d7b710bd934f2d56642f6313976d6

Tier T3 (client pairing copy; linking). Part 1 of 2 for M-INV-120 (mobile side of b#658); part 2 is #387 (coach Codes screen), independent, both on main.

Story: a client who types a code the coach turned off now reads "This code was turned off by your coach. Ask your coach for their current code." instead of "Invite code not recognized".

- Day-1 pairing (`src/screens/day-one/api.ts` classify) reads the envelope `code`: code_revoked / code_expired / code_exhausted / coach_not_accepting_clients / already_attached_to_different_coach each get their own sentence (`CoachPairingScreen.tsx`, `i18n/en.json`). Unknown codes stay "not recognized"; 5xx stays the connection sentence.
- Signup / role-selection mapper (`src/lib/inviteAttachOutcome.ts`): revoked no longer reuses the expired copy.
- Tests fail on main and pass here: pairWithCoachErrors 6/6 (main: 4 failed), inviteAttachOutcome 7/7 (main: 1 failed), day1OnboardingScreens 27/27 (main: the new revoked render case fails), day1OnboardingFlow 22/22. eslint clean.
- Size about 128 changed lines, 8 files. No new dependency, no cast, no empty catch.

CI at this head: CI https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37406109000 success (Typecheck, lint, test); CodeQL https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37406108977 success.

READY FOR AUDIT
