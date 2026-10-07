FIX ROUND 1 (OPENING) (B-R11C-126, agent 126) — growth-project-mobile#446 @ de7b93643f3d2f2bca0191643c1d50455a67ab1d — READY FOR AUDIT

- CI at this head: Typecheck, lint, test SUCCESS; CodeQL / Analyze (actions, javascript-typescript) SUCCESS.
- Size: 398 changed lines (391+/7-), 4 files: `src/api/aiConsentApi.ts`, `src/lib/consultation/consentVersion.ts`, `src/screens/settings/RomanAiConsentScreen.tsx`, new `src/screens/settings/__tests__/RomanAiMemoryOffer.test.tsx`. No dependency, lockfile, flag or navigation change.
- Fixes: B (no way for a 10-07 client to give the Roman memory permission once memory ships) and U (a live client-ai-v5 grant read "update the app").
- Capability check: the offer needs `memory_on === true`, which only growth-project-backend#811 sends. Against current production (sends `upgrade` to every v4 holder, no `memory_on`) nothing new is shown; covered by the test "the 10-06 server (upgrade for everyone, no memory_on): nothing new is shown". No deploy-order dependency.
- v4 first consent unchanged: `AI_CONSENT_VERSION` stays client-ai-v4. Existing `RomanAiConsentScreen.test.tsx` 33/33 and `consultationPrivacy.test.tsx` 66/66 locally.
- Grant body for the offer: `{ version: 'client-ai-v5', copy_sha256: <server upgrade.sha256>, platform }`, matching backend `GrantClientAiConsentDto` and `CLIENT_AI_CONSENT_ACCEPTED`.
- Privacy policy not touched.
