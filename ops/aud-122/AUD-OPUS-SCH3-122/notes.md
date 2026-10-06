# AUD-OPUS-SCH3-122 notes (Opus lens, agent 122), started 17:21 PDT 2026-10-05
Heads verified 17:23: #365 cd546a43d0d90f1e032fdf1d8520dfc9ccdc2821 (base main), #366 4936257bded6034fe9bda6eebd1783b9ecf1f526, #367 2699b4b10f4a5370a8d44121f7b8c18331a712b0. origin/main 3c315e40.

## Merge commits (git merge-tree --write-tree <p1> <p2> == commit tree, exit 0 = no conflicts)
- cd546a43 parents cceeb33a (approved) + 2c88eae5 (main): auto 0edfef7a == actual 0edfef7a MATCH
- 4936257b parents fa7744cc (approved) + cd546a43: auto f74e238c == actual f74e238c MATCH
- 8f35d777 parents 6418e759 (approved) + 4936257b: auto 88542eed == actual 88542eed MATCH
## PR's own patch (git diff | git patch-id --stable), approved vs new
- #365 367e6c48..cceeb33a vs 2c88eae5..cd546a43: 6ea486bf == 6ea486bf
- #366 cceeb33a..fa7744cc vs cd546a43..4936257b: 86dd9df3 == 86dd9df3
- #367 fa7744cc..6418e759 vs 4936257b..8f35d777: 9ab2bcda == 9ab2bcda
## Main-side hunks in PR files (independent additions)
- app.json (Health Connect permission list, plugin), eas.json (TGP_ANDROID_HEALTH_CONNECT clinic), expected-env.json + featureFlags.ts (WEARABLE_AI_INSIGHTS), JSON valid at cd546a43
- CoachNavigator (wearable prompts, consultation, Roman conversations, bloodwork gate), coach SettingsScreen (Roman conversations row)
- ClientNavigator (Roman conversations, backOnlyHeader, bloodwork gate); Calendar tab/stack intact
## Fix 2699b4b1 (+90/-9): schedulingApi.ts 'expired'; calendarUi statusLabel; CalendarSessionScreen Pick another time (expired only, LIVE_STATUSES excludes expired so no Cancel/Reschedule); CalendarBookScreen bookingWelcome + inbox copy. Tests added.
## Current main 3c315e40: merge-tree clean for all three heads; overlapping files expected-env.json, featureFlags.ts (MWB_PROGRAMS), CoachNavigator (Programs tab) = independent additions.
## CI: all green (#365 Typecheck/lint/test + CodeQL + Analyze x2; #366 run 37391976817; #367 run 37392190307).
