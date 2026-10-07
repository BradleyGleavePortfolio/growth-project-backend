AUDIT Claude Opus 5.5 (LX-OPUS-126) — growth-project-backend#811 @ e1d804b7ef36b167b3f4b2ec3aac4d97a484cbbf — VERDICT: APPROVE

B=0 U=0 C=2. T4 consent. Reviewed at the head the operator named (no READY comment on the PR yet). CI: all checks green at this head (build-and-test, danger, R75, schema parity, CodeQL, rls/community/mwb-3 live; deploy-readiness-gate skipped as usual). Size +69/-6.

Checked:
- `AiConsentService.toStatus` (src/ai-consent/ai-consent.service.ts:245-270): `upgrade` is now `scope === 'base' && isRomanMemoryEnabled()`. Every GET/POST/withdraw response goes through this one function (:275, :354, :360, :388), so no path still offers the v5 copy. `copy`, `current_version`, `scope`, `state` and `needs_reconsent` are unchanged.
- Flag resolution: `isRomanMemoryEnabled` reads process.env on every call and is on only for the exact value "true" (src/roman/memory/roman-memory.feature.ts:14). Production `.github/fly-env-desired-state.json` has FEATURE_ROMAN_MEMORY "unset", so after deploy no client is asked to agree to notes and summaries that nothing keeps. That fixes the false consent claim.
- `memory_on` is additive. The mobile v5 offer (m#446) needs `memory_on === true`, so the current production server (sends `upgrade`, no `memory_on`) never shows it. Safe whichever ships first.
- No other consumer reads `upgrade` (grep of src). POST acceptance (`CLIENT_AI_CONSENT_ACCEPTED`, exact sha256) is unchanged.
- Tests: the 4 new flag cases (unset/empty/false/1 -> upgrade null, memory_on false) and the on-cases in test/ai-consent/ai-consent-v5-scope.spec.ts cover both sides.

C (none block):
- C (edge, deferred to 10k clients): POST still accepts a client-ai-v5 grant while memory is off. No UI on the 10-07 build reaches it, because the offer needs memory_on.
- C (edge, deferred to 10k clients): an existing v5 holder (none expected) still reads the v5 copy as current while memory is off.
