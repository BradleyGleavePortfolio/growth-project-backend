Ingest flag flip for the on-device wearables lane (job B-HC12-121, agent 121). Base main 5da537d6. Draft: the operator applies it later through Fly Env Sync; merging changes nothing in production.

- `.github/fly-env-desired-state.json`: `"FEATURE_WEARABLES_INGEST_POST": "true"` (one line) and its gate entry.
- `docs/runbooks/launch-flags.md`: apply sequence (apply with `deploy_staged=true`, plan row `Deployed | match | keep`, owner device pass) and roll back with `unset`.

Order: mobile #378 (C-370-2 refresh paced under the 60 per minute ingest limit; C-370-3 one sleep session per night) is approved and merged first, then this applies, then the owner device pass on Apple Health and Health Connect.

Local evidence on this head (heavy.sh): `test/ci/fly-env-manifest.spec.ts` 67/67, `test/ci/fly-env-sync-behavior.spec.ts` 54/54, `test/ci/fly-env-workflows.spec.ts` 15/15.

No workflow was run.
