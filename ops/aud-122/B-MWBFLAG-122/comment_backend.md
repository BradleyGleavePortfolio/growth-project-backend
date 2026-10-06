FIX ROUND 1 (OPENING, B-MWBFLAG-122, agent 122) — growth-project-backend#737 @ f743dc73cf1571527b3059a448a576857e010d65

What this PR is (new PR on main eb2e9e038a4cc6e2b8b20fb0d37d251a91162350, 2 files, 28 changed lines, T4 flags):
- `.github/fly-env-desired-state.json`: `FEATURE_MWB_TEMPLATES`, `FEATURE_MWB_AUTOSAVE_UNDO`, `FEATURE_NAMED_REGIMES` `unset` -> `true`; `MWB_AUTOSAVE_LOCK_TOKEN_SECRET` `unset` -> `github-secret` (the autosave flag's precondition, same PR). Gate lines for the four names rewritten: what is deployed, what must be true, emergency kill.
- `docs/runbooks/launch-flags.md`: programs sequence (owner creates the secret, merge, plan, apply with `deploy_staged=true`, plan shows `Deployed | match | keep` on all four, mobile flip merged before the 10-07 build, owner device pass) and rollback.
- No code, no test change needed: the checked-in-manifest tests already cover the precondition and the workflow already passes `secrets.MWB_AUTOSAVE_LOCK_TOKEN_SECRET` to plan and stage.

Merge gate: **merge only after the owner confirms the GitHub Actions secret MWB_AUTOSAVE_LOCK_TOKEN_SECRET exists on this repository** (64+ hex characters). If it is missing or short, the Fly Env Sync plan fails closed with `not-64-plus-hex-characters` / a blank-source error and writes nothing. No secret was created or set by this job; no env sync or fly-secrets workflow was run.

For the lenses: `FEATURE_NAMED_REGIMES` also turns on partial-refund coach decision rows (`PartialRefundDecisionService.onPartialRefund`); a pending row changes nothing until the coach picks Keep or Unassign. Backend programs code is in main (MWB-3, #733).

Evidence: PR CI at this head green: CI run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37395174580 (build-and-test, mwb-3-live-tests, rls-live-tests, community-live-tests, rls-floor-guard: success), codeql 37395174469, R100 Quality Gate, Danger, Schema parity, SBOM, Dependency Audit, H4 deploy readiness: success (deploy-readiness-gate skipped as usual on PRs). Local single-spec (heavy.sh): test/ci/fly-env-manifest.spec.ts 67/67, test/ci/fly-env-sync-behavior.spec.ts 54/54, test/ci/fly-env-workflows.spec.ts 15/15; prettier clean.
Mobile pair: growth-project-mobile#382 (EXPO_PUBLIC_FF_MWB_PROGRAMS + EXPO_PUBLIC_FF_MWB_AUTOSAVE on in production and clinic profiles).

READY FOR AUDIT
