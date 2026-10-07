Tier: T4
Why: AI consent ledger (client-ai-v5 memory scope): what GET /me/ai-consent offers a client to agree to.
T4 trigger scan: consent / PII processing (AI consent ledger GET response). No auth, money, RLS, credentials or destructive data change.
T3 trigger scan: none (no schema, migration, route or DTO change; one response field becomes null while a flag is off).
Bounded T1: NO (consent surface is T4 by rule).
Canonical builder: Claude Opus 5.5 (B-R11C-126, agent 126)
Parent owner: agent 126 (operator)
Acceptance evidence: `test/ai-consent/ai-consent-v5-scope.spec.ts` 27/27 locally; the 4 new `FEATURE_ROMAN_MEMORY unset/empty/false/1 -> upgrade null, memory_on false` cases fail on main (4 failed, 23 passed with the src change stashed). `ai-consent.service.spec.ts` 49/49 and `ai-consent.controller.spec.ts` 30/30 unchanged. Full suite and tsc in this PR's CI.
Promotion triggers: any change to the v4/v5 copy, the ACCEPTED map, POST acceptance, or the flag resolution.

## What
`AiConsentService.toStatus` (`src/ai-consent/ai-consent.service.ts`) returned `upgrade` (the client-ai-v5 copy) to every live v4 holder. It now returns it only when `isRomanMemoryEnabled()` (`src/roman/memory/roman-memory.feature.ts:14`, exact "true", case-insensitive) is true. Production has `FEATURE_ROMAN_MEMORY` "unset" (`.github/fly-env-desired-state.json`), so production GET returns `upgrade: null` for everyone after this deploys.

It also adds one field, `memory_on: boolean` (= `isRomanMemoryEnabled()`), to every status. This is the capability check for the mobile PR: the current production server sends `upgrade` to every v4 holder and has no `memory_on`, so the app (which requires `memory_on === true`) never shows the v5 offer against it. The app is therefore safe whichever ships first.

Nothing else changes: `copy`, `current_version`, `scope`, `state` are byte-identical; POST still accepts v4 and v5 with their exact sha256. The 10-07 build ignores unknown fields (its parseStatus copies only known keys).

## Fixes
- B (false customer-facing claim, consent): a client with Roman allowed opens Settings > Privacy > Roman and AI on the next app build (mobile PR agent126/r11c-126-mobile reads `upgrade`) and is asked to agree that Roman keeps notes and summaries about them, although no code on main keeps any (B-R11F-126 rows 2-3: `isRomanMemoryEnabled` has zero callers). With this PR the offer appears only once memory is actually switched on.

## Pairing
Mobile PR: growth-project-mobile#446 (agent126/r11c-126-mobile). Settings > Privacy > Roman and AI shows the v5 offer only when `memory_on === true` and `upgrade` is a well-formed client-ai-v5 copy on a live v4 grant. No deploy-order dependency in either direction.

Overlap: none. No open PR touches `src/ai-consent`.
