# AUD-OPUS-W1A-123 — Opus lens, W1A (flags + lockout) + add-on AV3 (m#381)

Agent 123 lens, Claude Opus 5.5. Started 18:32 PDT 10-05. Read-only on code. Sol comments and notes were not read before posting.

## W1A results (posted 18:38-18:39 PDT)
| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| backend#737 (MF2 flags) | f743dc73cf1571527b3059a448a576857e010d65 | APPROVE | 0/0/1 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/737#issuecomment-6007557635 |
| mobile#382 (MF2 flags) | 695460e76671afcc86a7827e2a0ed311269d83af | APPROVE | 0/0/2 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/382#issuecomment-6007557791 |
| backend#725 (LA1 lockout delta) | b3caa5b18baa20ecca125efa2d51326f37dc5ee2 | APPROVE | 0/0/1 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/725#issuecomment-6007557926 |

Comment bodies: /home/user/workspace/ops/aud-123/AUD-OPUS-W1A-123/c737.md, c382.md, c725.md.

Key evidence:
- #737: the flags match the backend readers (mwb-templates.feature.ts, workout-builder-autosave.feature.ts, named-regimes.feature.ts). The secret is mapped in fly-env-sync.yml plan and apply (lines 167 and 291). The GitHub secret MWB_AUTOSAVE_LOCK_TOKEN_SECRET exists (created 2026-10-06T01:01:36Z). Fly Deploy 37399364660 succeeded at main 0521b393, which contains #733. All checks are green.
- #382: only the production and clinic env change (2 flags each). Dev and preview are untouched. Main has not touched eas.json or expected-env since base 300f898f, and the PR is mergeable clean. The 3 required checks are green.
- #725: the merge gives one METHOD + PATH table, which equals main's 4 paths plus #725's own-coach entries. The mounted methods match the controllers. The test-only commit touches only tests. Checks are green and the size is 166 lines.

Cs: C-737-1 / C-382-1 (operator order: apply the #737 env-sync before the 10-07 build), C-382-2 (read-only `eas env:list` on production for overrides), C-725-1 (block-user stays locked while locked, the same as on main).

## Add-on AV3 m#381 @ 5c13f14428c9d541996287f5869a92c72834e4c4 (operator mail 18:38)
| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| mobile#381 (booking options delta feab0c3b..5c13f144) | 5c13f14428c9d541996287f5869a92c72834e4c4 | APPROVE | 0/0/1 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381#issuecomment-6007580670 |

- B-381-1 is closed. The editor refuses a notice of 14 days or more (`NOTICE_UNDER_MINUTES` comes from `OPEN_SLOTS_RANGE_DAYS = 14`) with a plain sentence, and the input stops at 13 days, 335 hours or 20159 minutes. 2 days saves.
- The merge 413974bd is clean (empty remerge-diff). The CoachNavigator Money routes and the BookingOptions route are both present, and the SettingsScreen Money row and BookingOptionsEntry are both present.
- 5c13f144 is test-only. b#735 is in the deployed main 0521b393. Required checks are green.
- C-381-3: the clamp sentence stays on screen until the next save (cosmetic). The prior C-381-1 and C-381-2 stay follow-ups.
- Comment body: ops/aud-123/AUD-OPUS-W1A-123/c381.md. Claim: claims/mobile-381-5c13f144-opus. Posted 18:41 PDT.

## Add-on LS1 b#738 @ 9c2343126889f2fbcb2210ca6b6511bde40e3d1f (operator mail 18:50)
| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| backend#738 (proxy-addr 2.0.8 lockfile bump) | 9c2343126889f2fbcb2210ca6b6511bde40e3d1f | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/738#issuecomment-6007785296 |

- The diff touches only package-lock.json (+7 -3) and only the node_modules/proxy-addr entry: 2.0.7 to 2.0.8, plus the registry's funding block.
- The integrity equals `npm view proxy-addr@2.0.8 dist.integrity`. There is a single copy in the lockfile, and express 5.2.1 requires ^2.0.7.
- GHSA-jqcg-44mw-7w3h is critical and is patched in 2.0.8.
- All required checks are green at the head, including npm audit (run 37401169129) and build-and-test (run 37401169012). Polled 18:50 to 19:00. Posted 19:00 PDT.
- Comment body: ops/aud-123/AUD-OPUS-W1A-123/c738.md. Claim: claims/backend-738-9c234312-opus.

## HANDOFF
- LS1 is done: APPROVE posted on b#738 (URL above). The operator merges on dual APPROVE, and the main npm audit should then go green.
- W1A is done: 3 APPROVE verdicts posted (URLs above). The claims are in ops/lanes123/claims (backend-737-f743dc73-opus, mobile-382-695460e7-opus, backend-725-b3caa5b1-opus).
- AV3 is done: APPROVE posted at 5c13f144 (URL above).
- No worktrees, branches or lane runs were created, so there is nothing to clean up. Finished 18:41 PDT.
- Operator next steps:
  1. Merge backend#737 at f743dc73 after Sol's verdict, then apply it through Fly Env Sync (plan, apply with deploy_staged=true, plan).
  2. Merge mobile#382 before the 10-07 build. Recommended: first run a read-only `eas env:list` on production to rule out an override.
  3. Merge backend#725 at b3caa5b1 and mobile#381 at 5c13f144 on dual APPROVE with green checks.
