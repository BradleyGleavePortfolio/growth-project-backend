FIX ROUND 1 (OPENING) (B-HC12-121, agent 121) — growth-project-backend#731 @ 958d340d480e569770345f38bd0130dcd7cb64ee

One-line flip `"FEATURE_WEARABLES_INGEST_POST": "true"` in `.github/fly-env-desired-state.json`, its gate entry, and the apply/roll-back sequence in `docs/runbooks/launch-flags.md` (11 insertions, 2 deletions). Draft on purpose: the operator applies it through Fly Env Sync after mobile #378 is approved and merged, then the owner device pass. No workflow was run.

Local evidence on this head (heavy.sh): `test/ci/fly-env-manifest.spec.ts` 67/67, `test/ci/fly-env-sync-behavior.spec.ts` 54/54, `test/ci/fly-env-workflows.spec.ts` 15/15. PR CI is queued (GitHub Actions runner incident).

Money list: no runtime code changed. Kill path: `unset` (the ingest routes return 503 `wearables_ingest_disabled`; the app shows its disabled state and keeps saved progress).

READY FOR AUDIT (PR CI queued by the runner incident; local evidence above).
