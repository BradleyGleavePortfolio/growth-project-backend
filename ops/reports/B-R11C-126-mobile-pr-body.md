Tier: T4
Why: AI consent surface: lets a client grant the client-ai-v5 (Roman memory) permission from Settings with the exact server copy and sha256.
T4 trigger scan: consent / PII processing (POST /me/ai-consent/roman with client-ai-v5). No auth, money, RLS, credentials or destructive data change.
T3 trigger scan: none (no navigation, storage, dependency or flag change; zod is already a dependency).
Bounded T1: NO (consent surface is T4 by rule).
Canonical builder: Claude Opus 5.5 (B-R11C-126, agent 126)
Parent owner: agent 126 (operator)
Acceptance evidence: new `src/screens/settings/__tests__/RomanAiMemoryOffer.test.tsx` 13/13 locally (fails on main: main's parseStatus drops `upgrade` and has no offer); existing `RomanAiConsentScreen.test.tsx` 33/33 and `consultationPrivacy.test.tsx` 66/66 unchanged; targeted eslint clean. Full suite and tsc in this PR's CI.
Promotion triggers: any change to the v4 first-consent flow, the grant body, or the copy shown.

## What
- `src/api/aiConsentApi.ts`: `parseStatus` reads `scope`, `upgrade` (zod; null when absent on older servers or malformed; kept only with a version, non-blank paragraph and box label, and a 64-hex sha256) and `memory_on` (false unless exactly true).
- `src/screens/settings/RomanAiConsentScreen.tsx` (Settings > Privacy > Roman and AI):
  - `upgrade` null, or `memory_on` not true (production today, and always while backend FEATURE_ROMAN_MEMORY is off): the screen is exactly as on main.
  - `memory_on` true and `upgrade` is a client-ai-v5 copy on a live v4 grant: a separate "Notes and summaries" card shows the server's v5 paragraph verbatim and an "Allow notes and summaries" button. A confirmation (server box label, Cancel / Allow) comes first; then POST `{ version: 'client-ai-v5', copy_sha256: <server sha256>, platform }`, matching backend `GrantClientAiConsentDto` and the ACCEPTED map (sha256 of paragraph + "\n\n" + box_label). 409 CONSENT_VERSION_MISMATCH re-reads and says the wording changed. Other failures use the existing specific notices.
  - A live v5 grant (server `current_version` client-ai-v5 with its copy) reads Allowed, shows the v5 text it covers, and keeps Withdraw. Before this, it read "update the app".
  - The offer is hidden during a pending onboarding "no".
- `src/lib/consultation/consentVersion.ts`: `AI_CONSENT_MEMORY_VERSION = 'client-ai-v5'`. `AI_CONSENT_VERSION` stays client-ai-v4, so onboarding and the v4 Allow button are unchanged.
- Privacy policy not touched (that sentence ships with the memory flip).

## Fixes
- B (core consent flow dead end for v1.1): when Roman memory ships, a client on the 10-07 build opens Settings > Privacy > Roman and AI and has no way to give the memory permission, because this build drops `upgrade`. Memory would then stay off for every 10-07 client until a new store build. With this PR the offer appears as soon as the server sends it.
- U: a client whose live grant is client-ai-v5 (granted on another device or a later build) sees "This choice has been updated since this version of the app. Please update the app" instead of Allowed. Now it reads Allowed with the v5 text.

## Works against current production (capability check)
Production backend (f71bb9a4) sends `upgrade` to every live v4 holder and has no `memory_on`. This build requires `memory_on === true`, so against current production nothing new is shown (test: "the 10-06 server (upgrade for everyone, no memory_on): nothing new is shown"). Backend PR growth-project-backend#811 adds `memory_on` and returns `upgrade: null` unless FEATURE_ROMAN_MEMORY is "true". No deploy-order dependency: the offer appears only after b#811 is deployed AND the memory flag is flipped.

Overlap: none. No open mobile PR touches these files.
