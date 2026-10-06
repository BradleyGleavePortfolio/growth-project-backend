## What

One manifest PR (W3-07, agent 123). In `.github/fly-env-desired-state.json`:

| Name | Before | After | Kill |
|---|---|---|---|
| FEATURE_COACH_CODE_TOOLS | unset | true | unset: every /coach/codes route 404 coach_code_tools_disabled, app falls back to the legacy invite-codes screen |
| FEATURE_COACH_BROADCASTS | unset | true | unset: every A4 route 503 broadcasts.disabled, Broadcasts entry hides, dispatcher parks in-flight deliveries |
| FEATURE_COACHLESS_HOME | unset | true | unset: every /coachless route 404 coachless_disabled, Home slot renders nothing |

Gate text for all three is rewritten to say what is deployed, what ships in the 10-07 build, and the kill.

- Closed value sets: already `values: ['true', 'false']` and `unsetIs: 'off'` in `src/common/env-validation.ts` (FEATURE_COACH_CODE_TOOLS L1932, FEATURE_COACH_BROADCASTS L1949, FEATURE_COACHLESS_HOME L2077). No change needed.
- Runbook: I ran `node scripts/fly-env/fly-env-manifest.js kill-switches ...` and the output matches the table in `docs/runbooks/launch-flags.md` exactly. The emergency kill for an unset-is-off flag is `unset` whatever the current value, so the doc does not change.
- `node scripts/fly-env/fly-env-manifest.js validate`: OK (34 flags, 17 declared with a value; sha256 9ad9cd50...).
- Local runs (heavy.sh, one file at a time): test/ci/fly-env-manifest.spec.ts 67/67, fly-env-sync-behavior.spec.ts 54/54, fly-env-workflows.spec.ts 15/15.

Backend code for all three is on main = production (deploy 8, 5230306c): b#658 (code tools), b#721/#722/#723/#734 (coachless), b#726 (broadcasts). Mobile screens are merged on mobile main a727eb49: m#385 + m#387 (Codes), m#386 (coachless Home), m#388 (Broadcasts). All are server-gated (no EXPO_PUBLIC flag), so they ship in the 10-07 build.

## Proof 1: the store build ff6bd4b sees no change

ff6bd4b (10-01) has no code for any of these routes. `git grep` at ff6bd4b over src/ finds no `coach/codes`, `/coach/broadcasts`, `saved-replies`, `client-tags`, `cards/validate`, `/coachless` or `coachless_home`. The only server effects ff6bd4b can see:
- Code tools: the flag gates only `CoachCodeToolsController` (`@Controller('coach/codes')`, `assertCoachCodeToolsEnabled` at coach-code-tools.controller.ts:57/65/81/98/114). ff6bd4b uses the legacy `/coach/invite-codes` routes, which the flag does not gate. The signup ledger is written whether the flag is on or off.
- Broadcasts: `CoachBroadcastsEnabledGuard` sits on the A4 `coach/*` controller only (broadcasts.controller.ts:46). The one shared path is `MessagingService.listThread` (messaging.service.ts:635). While the flag is on, thread rows also `include` a `card` relation, which is null on ordinary messages. ff6bd4b reads `/messages` and `/coach/clients/:id/messages` as plain JSON with no strict schema (services/api.ts:556, :655), so it ignores the extra key. Cards and broadcasts can only be created through the A4 routes, and ff6bd4b has no screen for those.
- Coachless: `CoachlessFeatureGuard` sits on `@Controller('coachless')` only. `/admin/featured-coach` is not gated by this flag. `GET /me/feature-flags` returns `coachless_home: true` for students (feature-flags.service.ts:72). ff6bd4b validates that response as `flags: z.record(z.string(), z.boolean())` and reads only its four community keys (featureFlagsApi.ts SERVER_FEATURE_FLAG_KEYS), so a boolean that changes value has no effect there.

## Proof 2: coachless clients before the featured config exists

The banner is NOT hidden. Here is what a coachless student on the 10-07 build sees when the flag is on and no featured config row exists:
- `FeaturedCoachService.resolveRow(null)` returns `configured: false, accepting_clients: false, code: null, offer_text: null, roman_enabled: false`, with banner_title set to the default "Enter coach code for coaching and programs" (featured-coach.service.ts:130-143).
- `CoachlessHomeService.home` returns `banner: { title: <default>, offer_text: null, code: null }`, `roman_card: null`, `featured_coach: null` (coachless-home.service.ts). `decideRomanCard` returns `offer_off`.
- Mobile `CoachlessHomeSlot` (a727eb49) shows only the title and the "Enter a coach code" link. The offer line, featured-coach card and "Use code" button need `offer_text && code`. The Roman card needs `roman_card`. All are absent.
- Accounts with a coach, and every coach or owner account, get `eligible: false`, so nothing renders for them.

So until the owner saves the offer (PUT /admin/featured-coach with accepting_clients true), the only coachless surface is the quiet code-entry banner. Codes typed into the sheet resolve through `CoachCodeLookupService` (coach profile link or invite code), which does not depend on FEATURE_COACH_CODE_TOOLS.

## Apply

Merging changes nothing on Fly. The operator applies only after the owner says go: Fly Env Sync plan (expect these 3 to set, 0 to unset), then apply.
