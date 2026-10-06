# B-MWBFLAG-122 — programs on at launch: backend flag PR + mobile build flags (agent 122)

17:31-17:55 PDT 10-05. Status: DONE. Both PRs open, CI green, READY FOR AUDIT posted. Not merged (by order).

## PRs
- Backend growth-project-backend#737, branch `feat/mwb-programs-flags-on`, head f743dc73cf1571527b3059a448a576857e010d65 (base main
  eb2e9e03). `.github/fly-env-desired-state.json`: FEATURE_MWB_TEMPLATES / FEATURE_MWB_AUTOSAVE_UNDO / FEATURE_NAMED_REGIMES
  unset -> "true"; MWB_AUTOSAVE_LOCK_TOKEN_SECRET unset -> "github-secret"; four gate lines rewritten. `docs/runbooks/launch-flags.md`:
  programs sequence + rollback. 2 files, 28 lines. PR body: "Merge only after the owner confirms MWB_AUTOSAVE_LOCK_TOKEN_SECRET exists".
  No flag test needed changing (checked-in-manifest tests already cover the precondition; workflow already passes the secret).
  Comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/737#issuecomment-6006941717
  CI: run 37395174580 green (build-and-test + live-test jobs), all 15 checks success, deploy-readiness-gate skipped.
- Mobile growth-project-mobile#382, branch `chore/mwb-programs-flags-on`, head 695460e76671afcc86a7827e2a0ed311269d83af (base main
  300f898f). `eas.json` build.production.env and build.clinic.env: EXPO_PUBLIC_FF_MWB_PROGRAMS = "true", EXPO_PUBLIC_FF_MWB_AUTOSAVE = "true"
  (same pattern as EXPO_PUBLIC_FF_CLIENT_CALENDAR in #365); `config/expected-env.json` reasons. 2 files, 9 lines.
  Comment: https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/382#issuecomment-6006806726
  CI: run 37395203390 green; CodeQL green.
- Local single-file runs (heavy.sh): fly-env-manifest 67/67, fly-env-sync-behavior 54/54, fly-env-workflows 15/15; mobile
  releaseEnvProfile, expectedEnv, validateAppConfigUpdates, easUpdateGuard pass.

## Owner step for the secret (plain words)
On GitHub, open the growth-project-backend repository, then Settings > Secrets and variables > Actions > New repository secret.
Name: MWB_AUTOSAVE_LOCK_TOKEN_SECRET. Value: a random string of at least 64 characters that uses only the digits 0-9 and the letters a-f
(for example a password manager's random generator in hex mode). Save it, then tell the operator "the MWB secret exists".
It is never pasted into a chat, a file or a PR. (Operator alternative: hand the owner the secure credential form; agents never create it.)

## Merge and apply order (operator)
1. Owner creates the secret (above). 2. Both lenses at the exact heads. 3. Merge b#737; Fly Env Sync plan (secret row must pass the
64-hex shape check), apply with deploy_staged=true, plan again: four rows `Deployed | match | keep`. 4. Merge m#382 before the 10-07 build.
5. Owner device pass on a coach account (create program, autosave + undo, assign).

## Notes for the operator / lenses
- FEATURE_NAMED_REGIMES also turns on partial-refund coach decision rows; a pending row changes nothing until the coach picks one.
- Before the 10-07 build: confirm (read-only) the EAS production environment does not set either EXPO_PUBLIC_FF_MWB_* name to false;
  the release-env check fails the build on an override. Not checked here (EAS is off limits).
- No secret created or set, no env sync / fly-secrets / deploy run, nothing merged.

## HANDOFF
Nothing left to build. Next: lenses review b#737 @ f743dc73 and m#382 @ 695460e7 (T4 flags, tiny diffs). If a lens asks for a change,
the branches are `feat/mwb-programs-flags-on` (backend) and `chore/mwb-programs-flags-on` (mobile); worktrees were removed, recreate with
`git -C /home/user/workspace/growth-project-<repo> worktree add /home/user/workspace/wt/B-MWBFLAG-122-<n> origin/<branch>`. Comment drafts:
ops/aud-122/B-MWBFLAG-122/comment_{backend,mobile}.md.
