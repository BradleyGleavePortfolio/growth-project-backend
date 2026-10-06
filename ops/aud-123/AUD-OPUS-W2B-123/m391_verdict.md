AUDIT Claude Opus 5.5 — growth-project-mobile#391 @ 914b3ed37b98f0755f19069e6b80c488036af23a — VERDICT: REQUEST CHANGES

Lens AUD-OPUS-W2B-123 (agent 123), queue R3C item 3b (READY FOR AUDIT comment 6009926320). Full review of the 898-line diff at the exact head against main. Required checks green at this head (Typecheck, lint, test; CodeQL). No new casts to any/unknown/never, no empty catch. Operator ruling applied: the featured coach stays coach-role only.

**A: 0 | B: 1 | C: 2**

### B-391-1 — the owner account cannot reach the editor in the app
**Normal-user story:** Bradley follows the setup in the PR: he signs in to the app with his owner account to open Settings > Owner > Featured coach. After sign-in the app goes back to the sign-in screen, because the app only opens the coach app for `role === 'coach'` and the client app for `role === 'student'`. Every other role falls through to "Token exists but no role yet" and gets `setAuthState('unauthenticated')` (`src/navigation/RootNavigator.tsx` bootstrapAuth, lines 666-806 at this head; there is no `'owner'` branch, and `readUserCache` does not map roles). LoginScreen skips role selection for the owner (`isCoachLikeRole`), so the owner just sees sign-in again. The only entry to `FeaturedCoachEditor` is the coach `SettingsScreen` row shown only when `currentUser.role === 'owner'`, so no real session can reach it. The tests render SettingsScreen with an owner user directly, so they do not catch this.
**Fix (one change plus a test):** in `bootstrapAuth`, send `role === 'owner'` to the coach navigator (`setAuthState('coach')`, without the coach onboarding wizard check, since the owner has no coach onboarding). Add a RootNavigator test: a cached owner user mounts CoachNavigator and Settings shows "Featured coach". Other coach screens already handle the owner role (CoachHomeScreen `isOwner`, RiskBoard, PendingAiDrafts), so the coach app is the intended home. If the operator does not want owners in the coach app, the editor needs a different entry the owner can reach. Either way, the job is to make it reachable.

### Checked (fine)
- API: GET/PUT `/admin/featured-coach` and GET `/coaches` (b#749) are zod-parsed. Refusals are mapped by code and status only, never the server message, with one line per refusal under its field and a request reference for 5xx. The PUT sends every field (the server replaces the whole row). Caps are range-checked against the server limits, and the code shape is checked the same way as the DTO.
- Preselection uses the configured coach, else the coach account with the owner's name. Without b#749 deployed (404), the configured coach stays editable. The pitch follows code and price until it is edited. "you're" is correct in the suggested pitch (owner D1). The live preview reuses the real Banner and RomanCard and says why the Roman card is hidden. After a save, the app warns when clients still cannot see the offer.

### C (one line each)
- C-391-1: with the coach list missing (404) and no configured coach, the screen shows both "The coach list arrives with the next server update" and "No coach accounts yet. Create the coach account first", which is contradictory.
- C-391-2: "Create the code if it is new" defaults on, so a mistyped code is created as a new code. The save line names the created code, so the owner can see it.
