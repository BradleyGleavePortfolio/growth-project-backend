AUDIT Claude Opus 5.5 (LB-OPUS-126) — growth-project-backend#811 @ e1d804b7ef36b167b3f4b2ec3aac4d97a484cbbf — VERDICT: APPROVE

A=0 B=0 C=1. CI: __CI__. Size __SIZE__.

**Operator checks**
1. While the flag is unset, the gate cannot leak the v5 offer.
   - The only place the v5 copy is put into `upgrade` is the status builder in `ai-consent.service.ts`. It now reads `upgrade: scope === 'base' && isRomanMemoryEnabled() ? clientAiConsentV5Copy() : null`.
   - GET /me/ai-consent, the POST grant response and the withdraw response all come from that same builder, so all three are covered.
   - `isRomanMemoryEnabled` reads `process.env` on every call and is true only for the string `true` in any letter case. That matches how the memory feature itself turns on, so the offer and the feature cannot disagree. The manifest's closed set allows only `true` anyway.
   - Production state: `FEATURE_ROMAN_MEMORY` is "unset" in .github/fly-env-desired-state.json, and the secrets-list run 37536038425 does not list it. So production `upgrade` becomes null for every v4 holder.
   - The other `clientAiConsentV5Copy()` call (`copy` when `scope === 'memory'`) runs only for someone who already holds a live v5 grant. It is correct, and the PR leaves it alone.
   - Mobile main (950689af) does not read `upgrade` yet, so nothing on the 10-07 build depends on it.
2. Granting v5 still checks against the server copy hash.
   - `grant()` is not changed by this PR.
   - `acceptedClientAiConsent('client-ai-v5')` holds `CLIENT_AI_CONSENT_V5_COPY_SHA256`. A supplied `copy_sha256` that differs gets 409 `CONSENT_VERSION_MISMATCH` and nothing is written.
   - The ledger row always stores the server's hash (`accepted.copy_sha256`), never the client's.
   - See C-811-1: on main a v5 grant with no `copy_sha256` is accepted, because the DTO marks it optional for every version.
- Heads 6fbf9c7c and e1d804b7 add `memory_on: boolean`, plus a docs/ai-consent-ledger.md note. `memory_on` goes into the status (same per-call read as the `upgrade` gate). It is additive, not sensitive and returned only to the user themselves, and it lets the app tell this server from an older one. The spec checks it: true with the flag on, false for unset, empty, "false" or "1", and true for a v5 holder.
3. The tests fail on main where the behaviour changes. `it.each` (unset, empty, "false", "1") expects `upgrade: null` for a v4 holder on both the grant and GET responses, and main returns the v5 copy there. The flag-on case keeps the v5 offer for a live v4 holder only: none with no grant, none after a withdraw, none for a v5 holder. The fields the 10-07 app reads are unchanged (`app1007SeesLiveV4Grant`).

**C (never block)**
- C-811-1 (unchanged main behaviour, not in this diff): POST `{version: 'client-ai-v5'}` with no `copy_sha256` grants the memory scope and records the server hash, because `copy_sha256` is optional for every version (`ai-consent.dto.ts:32-35`, `ai-consent.service.ts` `grant`). A normal user cannot reach this: the app only offers v5 through `upgrade`, and `upgrade` is now null while memory is off. Smallest follow-up, if the operator wants proof of the displayed copy for v5: in `grant()`, return 409 when `dto.version === CLIENT_AI_CONSENT_V5_VERSION && dto.copy_sha256 === undefined`, keeping v4 optional for the 10-07 build. Recommended default: do it in the R11-F1 flip PR, not here.
