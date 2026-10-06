Tier: T4
Why: adds the route the app reads to decide which cloud trackers to offer, and makes the wearable OAuth callback public so a provider redirect can finish a connect (an auth-surface change).
T4 trigger scan: auth: `GET /v1/wearables/connections/oauth/callback` becomes `@Public()` (no JWT). The owning user still comes only from the single-use, server-minted CSRF `state` that `oauth/start` issued to the signed-in user; it is consumed before any token exchange, exactly as before. No token, secret or credential value is returned or logged. Credentials (names only): the new route reads env presence, never values.
T3 trigger scan: health-data source connection flow (wearables); new authenticated read route.
Bounded T1: NO (auth surface change).
Canonical builder: Claude Opus 5.5 (B-WEARLIST-125, agent 125)
Parent owner: operator agent 125
Acceptance evidence: `test/wearables/cloud-providers.spec.ts` (18 tests: availability rules, service + registry, route metadata, callback redirect ok/error/declined, query validation under the global forbidNonWhitelisted pipe); `src/wearables/connections/connections.controller.spec.ts` updated (16 pass, run with `--roots src/wearables/connections`; that folder is not in the default jest roots); `test/privacy/no-pii-in-logs.spec.ts` 11/11 (the rejected-callback log goes through `describeFailure`); `test/roles-enforced.spec.ts` 2/2. Full suite and tsc in this PR's CI.
Promotion triggers: any change to how `state` is minted or consumed; returning anything beyond provider ids from `/providers`.

Owner 14:30 10-06: "TURN THEM ON AND SHOW THEM PROUDLY!" The app (mobile PR, same job) lists a cloud tracker only when this route names it, so Oura, Polar, Withings and the rest light up the moment their keys are set, with no new app build.

## What changes
1. `GET /v1/wearables/connections/providers` (JWT, student/coach, own 60/min bucket) returns `{ providers: WearableProvider[] }`: the cloud providers connectable now = `FEATURE_WEARABLES_CLOUD_CONNECTORS` on AND `WEARABLES_OAUTH_REDIRECT_BASE_URL` + `KMS_MASTER_KEY` present AND that provider's `<P>_CLIENT_ID`, `<P>_CLIENT_SECRET`, `<P>_REDIRECT_URI` present (the exact names its OAuth start and code exchange `requireEnv`) AND its cloud connector registered. Production today: `[]` (switch off, no keys).
2. OAuth callback fixes, without which no cloud tracker can ever finish connecting:
   - `@Public()` (and its `@Roles('student')` removed): the provider redirect into the in-app browser carries no bearer token, so the callback was a 401 for every person.
   - Redirects (302) to `tgp://wearables/connected?status=ok&provider=<P>` or `?status=error`, the app's existing auth-session return URL, so the in-app browser closes by itself and the app re-reads the list. A bad state / failed exchange / declined consent all go back as `status=error` (error message never echoed; logged only through `describeFailure`).
   - `OauthCallbackDto` declares the optional `scope`, `error`, `error_description` that providers add (Strava, WHOOP and Oura echo `scope`), so the global `forbidNonWhitelisted` pipe no longer 400s a normal callback; `code` is optional so a declined consent reaches the handler. Unknown params and a missing `state` are still rejected.

## B / U fixed
- B1 (core flow dead end): a client taps Connect on a cloud tracker, signs in on the provider's page, and lands on a 401 page; nothing connects, ever, because the callback demanded the app's JWT that a browser redirect never has.
- B2 (core flow dead end): a Strava/WHOOP/Oura client who approves access is sent back with `scope=...` and the callback answers 400 (forbidNonWhitelisted), so the connection is never saved.
- U1: after connecting, the in-app browser shows raw JSON and never closes by itself; now it returns to the app.
- U2 (owner ask): cloud trackers can be offered only by an app update; now the server decides.

## Overlap
No open PR touches `src/wearables` (checked b#762, b#776-b#798).

## Operator notes
- When keys are added per provider, also set `<P>_REDIRECT_URI` to `https://api.trygrowthproject.com/api/v1/wearables/connections/oauth/callback` (and register the same URL in that provider's developer portal), `WEARABLES_OAUTH_REDIRECT_BASE_URL=https://api.trygrowthproject.com/api`, and confirm `KMS_MASTER_KEY` is set on Fly. Until all are present the provider stays hidden.
- Strava: its API agreement forbids showing a user's data to anyone else (coaches); recommended default: never set Strava keys, so it never lists.
