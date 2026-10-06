# B-WEARLIST-125 — server-driven cloud tracker list (agent 125 builder, Claude Opus 5.5)

Started 14:31 PDT 10-06. Owner 14:30: "TURN THEM ON AND SHOW THEM PROUDLY!"

## Scope traced
- Mobile: ConnectionsScreen (m#421 `connectableHere` / `buildRows`), ConnectProviderSheet cloud path (`useStartOauth` -> `WebBrowser.openAuthSessionAsync(url, 'tgp://wearables/connected')`), `wearablesConnectionsApi`, `useWearableConnections`.
- Backend: `ConnectionsController` (oauth/start, oauth/callback, list, on-device, disconnect) -> `ConnectionsService` (startOauth, handleCallback, callbackRedirectUri) -> ConnectorRegistry; the eight connectors' `requireEnv` names; `cloud-connectors.feature.ts`; global guards (JwtAuthGuard, RolesGuard) and ValidationPipe (`whitelist`, `forbidNonWhitelisted`); fly-env-desired-state.json (switch off, all *_CLIENT_ID/SECRET unset).

## B list
- B1 (core flow dead end): a client taps Connect on a cloud tracker, approves on the provider's page, and lands on a 401; nothing ever connects, because `GET oauth/callback` required the app's JWT and a provider redirect into the in-app browser never carries one (`src/wearables/connections/connections.controller.ts:88-99` on main; global JwtAuthGuard). FIXED in b#799 (`@Public()`, owner from the single-use state as before).
- B2 (core flow dead end): a Strava, WHOOP or Oura client who approves is sent back with `scope=...`, and the global `forbidNonWhitelisted` pipe 400s the callback, so the connection is never saved (`dto/oauth-callback.dto.ts`). FIXED in b#799 (declares optional `scope`, `error`, `error_description`).

## U list
- U1 (owner ask): cloud trackers could be offered only with an app update. FIXED: b#799 `GET /v1/wearables/connections/providers` + m#436 server-driven rows with benefit lines.
- U2: after a provider sign-in the in-app browser showed raw JSON and never closed by itself. FIXED in b#799 (302 to `tgp://wearables/connected?status=ok|error`).
- U3: a failed provider sign-in closed the sheet as if it worked. FIXED in m#436 (`status=error` keeps the sheet open with a retry).

## C one-liners
- C: data after connect arrives through each provider's webhook; webhook secrets / subscriptions are per-provider portal setup (operator step when keys are added), not checked by `/providers`.
- C (edge, deferred to 10k clients): `/providers` is cached 5 min in the app, so a newly keyed provider appears within 5 min or on next app open.

## Covered by open PRs
- None. No open backend PR (b#762, b#776-b#798) touches `src/wearables`; no open mobile PR (m#411-m#433) touches wearables files.

## PRs opened
- backend b#799 `agent125/b-wearlist-125-providers` @ 5fa5e8a9d37620a332d35157aef44cfcdab1b43f — 463 lines (439+/24-), T4 (callback made public). CI: all green at this head; READY comment posted 15:11 (issuecomment-6026388595).
- mobile m#436 `agent125/b-wearlist-125-providers` @ 1356b8d425ab604e39c723080c5910e3119dd33e — 259 lines (252+/7-), T3. CI: all green at this head; READY comment posted 15:03 (issuecomment-6026271747).
- Local targeted runs: backend `test/wearables/cloud-providers.spec.ts` 18/18, `src/wearables/connections/connections.controller.spec.ts` 16/16 (run with `--roots`; `src/wearables` is NOT in the default jest roots, so the new behaviour tests live in `test/wearables/`). Mobile ConnectionsScreen 36/36, ConnectionsScreen.emptyImport 5/5, ConnectProviderSheet 30/30, useConnectableCloudProviders 3/3. Backend also test/privacy/no-pii-in-logs 11/11, test/roles-enforced 2/2.

## Not fixed (needs operator)
1. To light up a provider (owner, through the secure form; never Strava, see 2): set `FEATURE_WEARABLES_CLOUD_CONNECTORS=true`, `WEARABLES_OAUTH_REDIRECT_BASE_URL=https://api.trygrowthproject.com/api`, confirm `KMS_MASTER_KEY` is set, and per provider `<P>_CLIENT_ID`, `<P>_CLIENT_SECRET`, `<P>_REDIRECT_URI=https://api.trygrowthproject.com/api/v1/wearables/connections/oauth/callback` (same URL registered in the provider portal). Until all are present the provider stays hidden. Needs b#799 deployed first (otherwise the callback 401s).
2. Decision: Strava's API agreement forbids showing a user's data to anyone else (coaches). Recommended default: never set Strava keys, so it never lists.
3. b#799 is T4 (auth: public callback): needs both lenses at the exact head.

## HANDOFF
- Branch agent125/b-wearlist-125-providers in both repos (worktrees removed after push). PR bodies: ops/reports/B-WEARLIST-125-{backend,mobile}-pr-body.md.
- Done 15:12: both PRs green and READY FOR AUDIT. Worktrees removed (all work pushed). No ci/* branches were created.
- Next (operator): route b#799 (T4) and m#436 (T3) to both lenses at the exact heads; m#436 is safe to merge before b#799 deploys (it shows nothing new until the route exists).
