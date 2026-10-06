# AUD-SOL-W1A-123 — independent review evidence

Started 2026-10-05 18:32:23 PDT; deadline 19:17:23 PDT. No Opus lens comments, notes, or reports read.

## Backend #737

The full PR diff is exactly two files, +20/-8 = 28 changed lines, below the 1,500-line cap. ([PR #737](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/737))

Manifest rows 38–40 change only `FEATURE_MWB_TEMPLATES`, `FEATURE_MWB_AUTOSAVE_UNDO`, and `FEATURE_NAMED_REGIMES` to `true`; row 46 changes the secret reference to `github-secret`. ([Manifest](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f743dc73cf1571527b3059a448a576857e010d65/.github%2Ffly-env-desired-state.json))

The three backend readers accept the exact value `true` and read the exact same environment names. ([Templates reader](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f743dc73cf1571527b3059a448a576857e010d65/src/workout-builder/mwb-templates.feature.ts), [autosave reader](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f743dc73cf1571527b3059a448a576857e010d65/src/workout-builder/workout-builder-autosave.feature.ts), [named-regimes reader](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f743dc73cf1571527b3059a448a576857e010d65/src/regimes/named-regimes.feature.ts))

Manifest validator lines 83–91 require a managed/present lock secret when autosave is enabled; lines 131–132 require at least 64 hexadecimal characters for the GitHub-sourced value; workflow lines 167 and 291 pass that same-named secret to plan and stage. ([Validator](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f743dc73cf1571527b3059a448a576857e010d65/scripts/fly-env/fly-env-manifest.js), [workflow](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f743dc73cf1571527b3059a448a576857e010d65/.github/workflows/fly-env-sync.yml))

W1A operator instruction confirms the owner's secret-creation condition is satisfied. Performed a read-only metadata lookup only; no secret value was accessed. Format validation remains the existing plan gate. ([Validator](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f743dc73cf1571527b3059a448a576857e010d65/scripts/fly-env/fly-env-manifest.js))

All 11 required checks are green; the authenticated jobs API returned exact head `f743dc73cf1571527b3059a448a576857e010d65` for successful build-and-test, including lint/type-check/build/test. ([Head CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37395174580/job/112049323333))

## Mobile #382

The full PR diff is exactly two files, +7/-3 = 10 changed lines, below the 1,500-line cap. ([PR #382](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/382))

Only production and clinic env rows gain the two intended flags; clinic extends production and uses the production environment, while development/preview stay unchanged. ([Build profiles](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/695460e76671afcc86a7827e2a0ed311269d83af/eas.json))

Literal Expo env reads at lines 56–57 feed the existing `mwbAutosave` and `mwbPrograms` switches at lines 369 and 380; the Programs switch chooses ProgramsStackNavigator at CoachNavigator line 653. ([Flag readers](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/695460e76671afcc86a7827e2a0ed311269d83af/src/config/featureFlags.ts), [navigation](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/695460e76671afcc86a7827e2a0ed311269d83af/src/navigation/CoachNavigator.tsx))

The existing release-env comparison covers every resolved profile env value, rejecting overrides before building; defaults in expected-env stay off and only explanatory reasons change. ([Release guard](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/695460e76671afcc86a7827e2a0ed311269d83af/scripts/check-expected-env.js), [env manifest](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/695460e76671afcc86a7827e2a0ed311269d83af/config%2Fexpected-env.json))

All three required checks are green; the authenticated jobs API returned exact head `695460e76671afcc86a7827e2a0ed311269d83af` for successful CI including the env guard, lint, typecheck, and tests. ([Head CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37395203390/job/112049414025))

## Backend #725

The full PR diff against main is five files, +141/-25 = 166 changed lines, below the 1,500-line cap. ([PR #725](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/725))

Verified merge `fbcfb74b03c809927ef87661f6153d705ff7fcce` parents: approved `1dbc59b690119f03f010e406f9f1e0e43d1e6556` and main `eb2e9e038a4cc6e2b8b20fb0d37d251a91162350`; reviewed the remerge diff and final commit `b3caa5b18baa20ecca125efa2d51326f37dc5ee2`, which modifies tests only. ([Builder refresh](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/725#issuecomment-6006932096))

The union table retains the five intended mounted message method/path pairs and leaves main's recovery, billing, auth, Roman, AI consent, data export, and deletion carve-outs unchanged. ([Guard](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/b3caa5b18baa20ecca125efa2d51326f37dc5ee2/src%2Fcheckout%2Fdunning-v2%2Fdunning-lockout.guard.ts))

Read the real client messaging and report controller methods at the head to confirm table methods, authentication, and request-user scoping; the controller paths have not changed in this PR. ([PR #725](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/725))

The fixed stub now reaches effectiveLock with no other live grant, so refuse tests no longer accidentally fail open; fixtures carry a request method and the route-inventory reachable filter includes the table. ([Coach-thread tests](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/b3caa5b18baa20ecca125efa2d51326f37dc5ee2/test%2Fdunning-v2-lockout-coach-thread.spec.ts), [route-table test](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/b3caa5b18baa20ecca125efa2d51326f37dc5ee2/test%2Fdunning-v2-lockout-allowlist-route-table.spec.ts))

All 11 required checks are green; the authenticated jobs API returned exact head `b3caa5b18baa20ecca125efa2d51326f37dc5ee2` for successful lint/type-check/build/test. ([Head CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37395321509/job/112049803201))

## Review limits

Independent code reading and existing exact-head CI only. No local npm/Jest/tsc/eslint/build commands, new lane runs, worktrees, commits, branch pushes, merges, production operations, or EAS/Expo/Fly/Supabase/Stripe access. No deferred edge probes.

## Posted and verified

Completed 18:36:53 PDT. Revalidated each exact head immediately before posting, then fetched only the three own comment IDs to verify their exact first lines.

- Backend #737 — APPROVE, A/B/C 0/0/0. ([Posted verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/737#issuecomment-6007531441))
- Mobile #382 — APPROVE, A/B/C 0/0/0. ([Posted verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/382#issuecomment-6007532120))
- Backend #725 — APPROVE, A/B/C 0/0/0. ([Posted verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/725#issuecomment-6007530548))
