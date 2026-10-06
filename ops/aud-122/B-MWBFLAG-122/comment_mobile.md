FIX ROUND 1 (OPENING, B-MWBFLAG-122, agent 122) — growth-project-mobile#382 @ 695460e76671afcc86a7827e2a0ed311269d83af

What this PR is (new PR on main 300f898fdaf6e0000f3415d0b0b4f0fc3cfa7d0c, 2 files, 9 changed lines, T4 flags):
- `eas.json` `build.production.env` and `build.clinic.env`: `EXPO_PUBLIC_FF_MWB_PROGRAMS` = `"true"` (coach Programs tab; `featureFlags.mwbPrograms`, also the program picker when a coach attaches package contents, ContentAttachForm) and `EXPO_PUBLIC_FF_MWB_AUTOSAVE` = `"true"` (workout builder autosave and undo; `featureFlags.mwbAutosave`). These are the store profiles the 10-07 build uses; clinic extends production and the explicit clinic lines follow how `EXPO_PUBLIC_FF_CLIENT_CALENDAR` was turned on (#365 K1, both profiles). Preview and development unchanged.
- `config/expected-env.json`: the two reasons now say where the flags are on and which backend flag each pairs with.

Order: merge after growth-project-backend#737 is merged and applied in production (it needs the owner's GitHub secret MWB_AUTOSAVE_LOCK_TOKEN_SECRET first), and before the 10-07 build. With the backend flags off the Programs tab reaches 404 routes.
Operator check before the build (not run here, read-only): the EAS production environment must not set either name to `false`; the release-env check fails the build when an EAS variable overrides an eas.json value.

Evidence: PR CI at this head green: CI run https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37395203390 (Typecheck, lint, test: success), CodeQL Advanced 37395203133 success. Local single-file (heavy.sh): scripts/__tests__/releaseEnvProfile.test.js, expectedEnv.test.js, validateAppConfigUpdates.test.js, easUpdateGuard.test.js pass.

READY FOR AUDIT
