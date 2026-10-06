Tier: T3
Why: the Connections screen offers a cloud tracker (Oura, Polar, Withings, ...) only when the server lists it as connectable, so trackers light up without a new app build; on an older server it behaves exactly as today (m#421).
T4 trigger scan: none (reads a token-free list of provider ids; no auth, money, PII or credential change on the client).
T3 trigger scan: health-data source connection screen and connect sheet.
Bounded T1: NO (customer-visible health-source flow).
Canonical builder: Claude Opus 5.5 (B-WEARLIST-125, agent 125)
Parent owner: operator agent 125
Acceptance evidence: `ConnectionsScreen.test.tsx` 36/36 (3 new: a listed tracker shows with its benefit line and a working Connect; none listed = no cloud rows; buildRows adds only listed providers), `useConnectableCloudProviders.test.ts` 3/3 (route path, known-cloud-id filter, 404 / network / drifted body = none), `ConnectProviderSheet.test.tsx` 30/30 (1 new: `status=error` return keeps the sheet open with a retry), `ConnectionsScreen.emptyImport.test.tsx` 5/5. Full suite and tsc in this PR's CI.
Promotion triggers: showing a cloud row the server did not list; any change to the OAuth start flow.

Owner 14:30 10-06: "TURN THEM ON AND SHOW THEM PROUDLY!" Pairs with backend growth-project-backend#799 (adds `GET /v1/wearables/connections/providers` and makes the OAuth callback reachable from the provider redirect).

## What changes
- `wearablesConnectionsApi.cloudProviders()` reads `GET /v1/wearables/connections/providers` (`{ providers: [...] }`), keeping only known cloud ids (on-device and unknown ids dropped).
- `useConnectableCloudProviders()` (new hook, 5 min stale time): any failure (today's production backend answers 404, no network, drifted body) means "none listed" and is logged, never shown.
- ConnectionsScreen: `buildRows` also offers a cloud provider when the server lists it (m#421's `connectableHere` gains the server set). Listed trackers show their name and a one-line benefit ("Sleep, readiness and heart rate from your Oura ring"), each naming only data that provider's backend connector really reads. No brand logos exist in the app, so none are added. Connect uses the existing sheet and OAuth start flow.
- ConnectProviderSheet: when the server callback returns `tgp://wearables/connected?status=error`, the sheet stays open with "Oura isn't connected. The sign-in with Oura did not finish. Tap Continue to try again." instead of closing as if connected.

## Against today's production backend
`/providers` is a 404 there, so the list is empty and the screen is exactly m#421: this phone's health source plus existing connections, no cloud Connect that cannot work. The `status=error` branch is never reached (today's callback never redirects).

## B / U fixed
- U1 (owner ask): cloud trackers can be offered only with an app update; now each appears as soon as the server can connect it.
- U2: a failed provider sign-in closed the sheet as if it worked; it now says it did not finish and offers Continue.

## Overlap
No open mobile PR touches `src/screens/client/wearables`, `src/api/wearablesConnectionsApi.ts` or `src/hooks/useWearableConnections*` (checked m#411-m#433).
