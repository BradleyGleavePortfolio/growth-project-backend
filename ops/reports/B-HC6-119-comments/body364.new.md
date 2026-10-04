Split of mobile #317 (S14 Apple Health / Health Connect connect, 30-day import; 11,860 lines at `d0407b62`, already current with main `367e6c48`) under the owner's PR size rule: over 3,000 changed lines is an automatic fail (MODEL_ROUTING.md 8.2, tgp-agent-context). Cut with an import-order check. Stack: H1 -> H2 -> H3 -> H4 -> H5 -> H6, merged back to back; the new connect flow is user-visible from H4. Tree at H6 = #317 head (git diff). #317's earlier verdicts were at its own head; per the T4 rule each piece needs Opus 5.5 and Sol at its exact head (content unchanged, so these should be short). Device verification (HealthKit / Health Connect on hardware) still follows the EAS build the owner approves. `tsc --noEmit` passes at every piece; every existing test importing a changed file was run locally.

**H6 (base H5, 2,878 lines, mostly deletions):** retires the Samsung Health client, normalizer, sync service, types, errors and unused Samsung sync hook with their tests; adds the Health Connect build config (app.config.js, permission delegate plugin, app.json, eas.json) with its config and platform tests, and the ingest contract test. 19 suites, 273 tests locally.


**Re-cut (operator 115):** the Health Connect build config (app.config.js switch, permission delegate plugin, app.json permissions, eas.json clinic flag) and its config tests moved together into H6, so H1 to H5 do not mix #317's config tests with main's config. Known red at H6, inherited from #317's own head: `scripts/__tests__/easUpdateGuard.test.js` (from #305) pins the clinic channel's `TGP_ANDROID_HEALTH_CONNECT` to '0' while #317 sets '1'. A builder resolves it once the owner decides whether the clinic binary ships Health Connect.


**Tier: T4** (health data; max-tier rule, split piece of #317). Fix round 4 (B-HC6-119): READY FOR AUDIT. Parent owner: operator (land as one, rule 11).

**Fix rounds**
| Round | Head | Builder | Change | Comment |
|---|---|---|---|---|
| 1 (restack, merge-only) | `a3206441d57ea51130490e6e54cc8228bff40687` | B-W2-117 | merged the #360 B-360-1 fix upward; this piece's own diff byte-identical (patch-id) | [FIX ROUND 1](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/364#issuecomment-5976976245) |
| 2 | `529ba34524844403eb034dc1519ced21d208346c` | B-HC4-118 | restack + B-364-1/C-364-2 (via #362) + B-364-2 Health Connect privacy link opens the privacy policy (plugin); 2,937 lines | [FIX ROUND 2](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/364#issuecomment-5983281999) |
| 3 (restack, merge-only) | `b261f2188f3b6932145f05c45f7763c838bfc6ed` | B-HC5-119 | merged #363 FIX ROUND 3 upward; own diff patch-id unchanged (e50c714e); 2,937 lines | [FIX ROUND 3](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/364#issuecomment-5984342400) |
| 4 (restack, merge-only) | `c084f8dfc40a3c7c473584603bec38c109afd5bf` | B-HC6-119 | merged #363 FIX ROUND 4 upward; own diff patch-id unchanged (e50c714e); 2,937 lines | [FIX ROUND 4](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/364#issuecomment-5984738407) |


