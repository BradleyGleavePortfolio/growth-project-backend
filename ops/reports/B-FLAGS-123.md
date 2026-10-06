# B-FLAGS-123 — three day-1 flag PRs (builder, Claude Opus 5.5, agent 123)

Started 19:42 PDT 10-05. Time box 45 min (ends about 20:27).
Bases: backend main e6f9a5ec0c5bac40f33ac7513ad2653880f265d3, mobile main a33e5d75cb1842073ded00609ea25ec79ec988ee.
Worktrees: /home/user/workspace/wt/B-FLAGS-123-b1 (backend agent123/day1-flags), wt/B-FLAGS-123-m1 (mobile agent123/day1-flags),
wt/B-FLAGS-123-m2 (mobile agent123/c337-volume-copy). PR bodies: ops/aud-123/B-FLAGS-123/body_{b,m1,m2}.md.

## PRs (opened 19:49 PDT)
| PR | Branch | Head | Size | Local runs (heavy.sh, one file at a time) |
|---|---|---|---|---|
| growth-project-backend#740 chore(flags): day-1 community core, messaging v2 and Roman chat on (T4) | agent123/day1-flags | 7e3ff31b1b28758a5ebaa6081e6ca090742fb6b3 | 3 files +19/-10 | fly-env-manifest 67/67, env-validation 50/50, fly-env-sync-behavior 54/54, fly-env-workflows 15/15, manifest validate OK |
| growth-project-mobile#383 chore(flags): Roman chat and community on in the store builds (T3) | agent123/day1-flags | d2845013b2a8f279606a8886ff45e25ad7064da8 | 1 file +7/-2 | expectedEnv 38/38, releaseEnvProfile 95/95, validateAppConfig 31/31, validateAppConfigUpdates 38/38, easUpdateGuard 74/74 |
| growth-project-mobile#384 fix(roman): say more volume when an adjustment raises sets (T3) | agent123/c337-volume-copy | 341216276547a1ead980a91f302768c554028237 | 2 files +30/-1 | new romanAdjustCopy.test.ts: before fix 2 fail/1 pass, after 3/3; RomanAdjustmentCard 34/34; eslint clean |

## What each PR does
- b#740: FLAGS-D1-123 (a)1-5 exactly. Community API/POSTS/MESSAGES/PUSH/REALTIME and MESSAGING_CORE_V2 -> true; FEATURE_ROMAN_CHAT_ENABLED
  moved from excluded to flags = true; FEATURE_ROMAN_ADJUST_ENABLED managed = unset; gates for both Roman names, messaging gate rewritten,
  community API gate notes #610 deployed + m#314 merged; ENV_RULES values ['true','false'] + unsetIs 'off' for both Roman names;
  kill-switch table in docs/runbooks/launch-flags.md regenerated (2 new rows). Body says it supersedes b#650.
- m#383: production + ROMAN_CHAT, COMMUNITY_TAB, COMMUNITY_HALL, COMMUNITY_COHORTS = "true"; clinic + ROMAN_CHAT = "true".
  COMMUNITY_DM absent in production = code default off (featureFlags.ts:203).
- m#384: changeSummary now says "% less volume" for a cut, "% more volume" for a raise (abs value), "same volume" for 0.
  Callers checked: RomanAdjustmentCard summary text, its a11y label, Approve label (all through changeSummary); edit chips are fixed
  positive presets; appliedLine prints sets only. Backend romanProposalText ("trimming ... by X%") is only built for server-made cuts
  (always positive); not in this mobile PR.

## Notes
- Prettier: backend env-validation.ts and mobile romanAdjustCopy.ts were already not prettier-clean on main; edits follow the file style.
- Worktree slip: first `worktree add` used relative paths and landed inside the main clones; moved with `git worktree move` to
  /home/user/workspace/wt/ within a minute. Main clones' checkouts were never changed.

## Status (19:59 PDT, done)
- CI green at every head: b#740 all checks SUCCESS (build-and-test https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37406043966/job/112083734058;
  deploy-readiness-gate skipped as usual), mergeState CLEAN. m#383 and m#384: Typecheck, lint, test + CodeQL + Analyze SUCCESS
  (runs 37406046428, 37406048996), mergeState CLEAN.
- Opening comments (READY FOR AUDIT), heads verified right before posting:
  - b#740 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/740#issuecomment-6008418861
  - m#383 https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/383#issuecomment-6008386951
  - m#384 https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/384#issuecomment-6008387112
- Worktrees removed 19:58 (all work pushed, nothing unsaved). No ci/* or audit/* branches created; no locks or claims taken.
- Notify: ops/lanes123/notify/B-FLAGS-123.txt.

## HANDOFF
- State: builder finished 19:59 PDT, about 17 minutes into the 45-minute box. Three PRs open, CI green, READY FOR AUDIT at the heads above.
  Nothing merged, deployed or applied; no Fly workflow run.
- Next (operator): lens pair on b#740 (T4) and on m#383 + m#384 (T3). Merge the two mobile PRs before the 10-07 build. After m#384 merges,
  a one-line backend PR FEATURE_ROMAN_ADJUST_ENABLED "unset" -> "true". Close b#650 as superseded when b#740 merges. Apply b#740 only
  after deploy 7, then a read-only fly-env-truth run (ANTHROPIC_API_KEY), then Fly Env Sync plan (expect 7 to set, 0 to unset) and apply.
- If a fix round is needed: recreate a worktree from the PR branch under /home/user/workspace/wt/ (absolute path), one push per PR per round,
  post `FIX ROUND 2 (B-FLAGS-123, agent 123) — <repo>#<n> @ <sha>`.
