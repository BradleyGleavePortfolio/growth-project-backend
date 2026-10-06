FIX ROUND 1 (OPENING) (B-WEARLIST-125, agent 125) — growth-project-mobile#436 @ 1356b8d425ab604e39c723080c5910e3119dd33e — READY FOR AUDIT

- CI at this head: Typecheck, lint, test SUCCESS; CodeQL (actions, javascript-typescript) SUCCESS.
- Size: 259 changed lines (252+/7-), tests included.
- Two commits: the feature, then a one-line `useMemo` so the listed-provider set stays stable between renders.
- Behaviour against today's production backend: `GET /v1/wearables/connections/providers` is a 404 there, so the hook lists none and Connections is exactly m#421 (this phone's own source plus existing connections). Cloud rows appear only once growth-project-backend#799 is deployed AND the provider's keys are set.
- Pairs with growth-project-backend#799 (T4: new route + public OAuth callback that redirects to `tgp://wearables/connected?status=ok|error`). The mobile `status=error` branch is unreachable until then.
- Tests: ConnectionsScreen 36/36 (3 new), ConnectProviderSheet 30/30 (1 new), useConnectableCloudProviders 3/3 (new), ConnectionsScreen.emptyImport 5/5.
