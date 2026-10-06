**Tier: T3** (client-facing pairing copy; linking). M-INV-123, agent 123. Part 1 of 2 for the mobile side of b#658 (SoT M-INV-120). Independent of part 2 (the coach Codes screen); both are based on main.

Story: a coach whose code leaked turns it off; a client who types the old code on Day-1 pairing saw "Invite code not recognized. Double-check with your coach." Now they see "This code was turned off by your coach. Ask your coach for their current code."

The backend (b#658, merged) answers a NEW redemption of a code that exists but cannot take a signup with the envelope `code` `code_revoked`, `code_expired` or `code_exhausted` (`inviteCodeLifecycleRefusal`). These refusals are not behind FEATURE_COACH_CODE_TOOLS, so they reach clients as soon as the backend is deployed.

What changes
- `src/screens/day-one/api.ts` `classify` reads the envelope `code` (before the legacy `reason`): code_revoked -> invite_revoked, code_expired -> invite_expired, code_exhausted -> invite_max_uses, coach_not_accepting_clients -> coach_unavailable, already_attached_to_different_coach -> already_paired. Unknown codes stay invite_invalid; 5xx stays server.
- `CoachPairingScreen.tsx` + `i18n/en.json`: one sentence per kind ("This code was turned off by your coach. Ask your coach for their current code." / "This code has been used up. Ask your coach for a new one." / coach not taking new clients / already connected to a different coach).
- `src/lib/inviteAttachOutcome.ts` (signup paths and role selection): `revoked` no longer maps to the expired copy; it has its own sentence.

Tests (each new case fails on main, passes here; run one file at a time):
- `src/screens/day-one/__tests__/pairWithCoachErrors.test.ts` (new): main 4 failed / 2 passed; here 6/6.
- `src/lib/__tests__/inviteAttachOutcome.test.ts`: main 1 failed; here 7/7.
- `src/screens/day-one/__tests__/day1OnboardingScreens.test.tsx`: new revoked render case fails on main; here 27/27.
- `src/screens/day-one/__tests__/day1OnboardingFlow.test.ts`: 22/22. eslint clean on the changed files.

Size: 8 files, about 128 changed lines. No new dependency, no cast, no empty catch.
