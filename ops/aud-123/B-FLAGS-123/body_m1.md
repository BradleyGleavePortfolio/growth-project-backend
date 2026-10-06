**Tier: T3** (store-build flags). B-FLAGS-123, agent 123. Matrix: FLAGS-D1-123 (b). Merge before the 10-07 build.

`eas.json`:
- `production` adds `EXPO_PUBLIC_FF_ROMAN_CHAT`, `EXPO_PUBLIC_FF_COMMUNITY_TAB`, `EXPO_PUBLIC_FF_COMMUNITY_HALL`, `EXPO_PUBLIC_FF_COMMUNITY_COHORTS` = `"true"`.
- `clinic` adds `EXPO_PUBLIC_FF_ROMAN_CHAT` = `"true"` (clinic already had the three community flags and keeps `EXPO_PUBLIC_FF_COMMUNITY_DM` = `"false"`).

Owner rulings: live Roman chat in v1.0 (10-02 16:34), Roman flags flip after the stacks land (10-05 09:57), community core live on day 1 (10-01 11:32). Community DM and voice notes stay off (production has no DM key; the code default is off). Every Roman sub-flag stays off.

Backend pair: growth-project-backend#740 turns on FEATURE_ROMAN_CHAT_ENABLED and the community core server-side. Until that is applied the Roman screens answer 404 and the community screens answer 503 community.disabled, the same as the clinic binary today.

All four names are declared in config/expected-env.json. Local single-file runs (heavy.sh): scripts/__tests__/expectedEnv.test.js 38/38, releaseEnvProfile.test.js 95/95, validateAppConfig.test.js 31/31, validateAppConfigUpdates.test.js 38/38, easUpdateGuard.test.js 74/74. 1 file, 9 changed lines.
