Split of mobile #317 (S14 Apple Health / Health Connect connect, 30-day import; 11,860 lines at `d0407b62`, already current with main `367e6c48`) under the owner's PR size rule: over 3,000 changed lines is an automatic fail (MODEL_ROUTING.md 8.2, tgp-agent-context). Cut with an import-order check. Stack: H1 -> H2 -> H3 -> H4 -> H5 -> H6, merged back to back; the new connect flow is user-visible from H4. Tree at H6 = #317 head (git diff). #317's earlier verdicts were at its own head; per the T4 rule each piece needs Opus 5.5 and Sol at its exact head (content unchanged, so these should be short). Device verification (HealthKit / Health Connect on hardware) still follows the EAS build the owner approves. `tsc --noEmit` passes at every piece; every existing test importing a changed file was run locally.

**H5 (base H4, 982 lines, test-only):** connect sheet import epoch, attempt fence and account switch suites (46/46 locally).


**Re-cut (operator 115):** the Health Connect build config (app.config.js switch, permission delegate plugin, app.json permissions, eas.json clinic flag) and its config tests moved together into H6, so H1 to H5 do not mix #317's config tests with main's config. Known red at H6, inherited from #317's own head: `scripts/__tests__/easUpdateGuard.test.js` (from #305) pins the clinic channel's `TGP_ANDROID_HEALTH_CONNECT` to '0' while #317 sets '1'. A builder resolves it once the owner decides whether the clinic binary ships Health Connect.


**Tier: T4** (health data; max-tier rule, split piece of #317). Fix round 4 (B-HC6-119): READY FOR AUDIT. Parent owner: operator (land as one, rule 11).

**Fix rounds**
| Round | Head | Builder | Change | Comment |
|---|---|---|---|---|
| 1 (restack, merge-only) | `38ea0f81fd88ea343ac2279097e8d24f08ef3cc5` | B-W2-117 | merged the #360 B-360-1 fix upward; this piece's own diff byte-identical (patch-id) | [FIX ROUND 1](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/363#issuecomment-5976976095) |
| 2 (restack, merge-only) | `2858bac5cdced8ba4941be50b471f4d53908eb42` | B-HC4-118 | merged #362 FIX ROUND 2 upward; own diff unchanged (982) | [FIX ROUND 2](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/363#issuecomment-5983281889) |
| 3 | `f62f1bbe5d41332db403fd4e598f6ab864550dc1` | B-HC5-119 | merged #362 FIX ROUND 3 upward; added the B-362-2 / B-362-6 tests (Sol H46 probes + token attachment, progress, no-session, dialog); 1,385 lines | [FIX ROUND 3](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/363#issuecomment-5984342255) |
| 4 | `51a8dc330ca100df82ee64e2725842b1ff9b93c6` | B-HC6-119 | merged #362 FIX ROUND 4 upward; added the native-order tests (Sol retireNativeOrder.sol119 probe + serial-queue suite); 1,626 lines | [FIX ROUND 4](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/363#issuecomment-5984738125) |


