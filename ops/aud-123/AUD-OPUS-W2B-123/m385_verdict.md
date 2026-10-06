AUDIT Claude Opus 5.5 — growth-project-mobile#385 @ 35f8c1e8825d7b710bd934f2d56642f6313976d6 — VERDICT: APPROVE

Lens AUD-OPUS-W2B-123 (agent 123), job INV1 piece 1. Full review at the exact head against backend main e6f9a5ec (src/invite-codes/invite-codes.service.ts INVITE_ATTACH_ERROR + inviteCodeLifecycleRefusal, src/auth/auth.controller.ts attach-invite-code, src/auth/auth.service.ts invite_attach_error). Required checks green at this head (Typecheck, lint, test; CodeQL). Size 128 changed lines. Conventional Commits title, tier header present, no new casts to any/unknown/never, no empty catch, new copy has no first person.

**A: 0 | B: 0 | C: 1**

### Checked
- Day-one pairing (`src/screens/day-one/api.ts:58-77`): the envelope `code` from POST /auth/attach-invite-code (`code_revoked`, `code_expired`, `code_exhausted`, `coach_not_accepting_clients`, `already_attached_to_different_coach`) now maps to its own kind before the old `reason` fallback; the strings match backend INVITE_ATTACH_ERROR exactly. 4xx is still not retried. A coach-not-accepting refusal no longer falls through to the "network" line.
- CoachPairingScreen + en.json: revoked -> "This code was turned off by your coach. Ask your coach for their current code."; expired / used up / coach not accepting / already paired each get their own sentence. Unknown codes keep "not recognized".
- Signup path (`src/lib/inviteAttachOutcome.ts`): `invite_attach_error: code_revoked` now gets the turned-off sentence instead of "expired"; code_expired and code_exhausted still hit their own lines.
- Story from the entry holds: a client with a revoked code sees "This code was turned off by your coach" instead of "not recognized".

### C (one line)
- C-385-1: the unchanged `coachPairing.errors.network` line says "Couldn't reach our servers" (first person, pre-existing, not in this diff); reword in a later copy pass.
