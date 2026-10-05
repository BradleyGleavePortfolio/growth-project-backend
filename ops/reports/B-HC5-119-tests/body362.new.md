Split of mobile #317 (S14 Apple Health / Health Connect connect, 30-day import; 11,860 lines at `d0407b62`, already current with main `367e6c48`) under the owner's PR size rule: over 3,000 changed lines is an automatic fail (MODEL_ROUTING.md 8.2, tgp-agent-context). Cut with an import-order check. Stack: H1 -> H2 -> H3 -> H4 -> H5 -> H6, merged back to back; the new connect flow is user-visible from H4. Tree at H6 = #317 head (git diff). #317's earlier verdicts were at its own head; per the T4 rule each piece needs Opus 5.5 and Sol at its exact head (content unchanged, so these should be short). Device verification (HealthKit / Health Connect on hardware) still follows the EAS build the owner approves. `tsc --noEmit` passes at every piece; every existing test importing a changed file was run locally.

**H4 (base H3, 2,284 lines):** connect provider sheet, wearables shell, connections screen, wearable connections hook, health and fitness screens, coach client health tab, community wearable prompts, sign-out cleanup, coach navigator route; their updated tests plus resting heart rate and prompts-route tests. 28 suites, 338 tests locally.


**Re-cut (operator 115):** the Health Connect build config (app.config.js switch, permission delegate plugin, app.json permissions, eas.json clinic flag) and its config tests moved together into H6, so H1 to H5 do not mix #317's config tests with main's config. Known red at H6, inherited from #317's own head: `scripts/__tests__/easUpdateGuard.test.js` (from #305) pins the clinic channel's `TGP_ANDROID_HEALTH_CONNECT` to '0' while #317 sets '1'. A builder resolves it once the owner decides whether the clinic binary ships Health Connect.


**Tier: T4** (health data; max-tier rule, split piece of #317). Fix round 3 (B-HC5-119): READY FOR AUDIT. Parent owner: operator (land as one, rule 11).

**Fix rounds**
| Round | Head | Builder | Change | Comment |
|---|---|---|---|---|
| 1 (restack, merge-only) | `439937c93ca8460aed23daef116aa49e7127efa3` | B-W2-117 | merged the #360 B-360-1 fix upward; this piece's own diff byte-identical (patch-id) | [FIX ROUND 1](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5976975911) |
| 2 | `b3bc0ce4d7e62763671881e6babd60aa518203cc` | B-HC4-118 | closed Sol B-362-1..4, Opus B-362-1/2 (+C-362-1/2/3), H6 B-364-1 + C-364-2 (Samsung row mirrors Health Connect); 2,835 lines | [FIX ROUND 2](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5983281769) |
| 3 | `73dbefbcbe97544710058dcab176ea8713654042` | B-HC5-119 | closed Sol B-362-2 (atomic retirement per grant generation, incl. no-session) and B-362-6 (session fence after every pre-request await and at token attachment); Opus C-362-6 folded; tests in H5; 2,913 lines | [FIX ROUND 3](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5984342112) |

