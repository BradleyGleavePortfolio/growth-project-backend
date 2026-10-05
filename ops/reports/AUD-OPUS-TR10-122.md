# AUD-OPUS-TR10-122 — trials train delta, Opus lens (agent 122)
Started 15:12 PDT 10-05. Time box 45 min (ends 15:57 PDT). Lens: Claude Opus 5.5. Independent: Sol notes/report/comments not read.

## GitHub auth (resolved 15:41)
- `gh api` / git over git-agent-proxy return 401 "Bad credentials" for the whole session (api_credentials=["github"]). Operator 122
  mail 15:25: keep reviewing via unauthenticated api.github.com + a read-only github.com clone; write verdict drafts; retry
  `gh api user` every 5 min; if still 401 at time box, the operator posts them.
- Read-only clone used: /home/user/workspace/wt/AUD-OPUS-TR10-122-ro (blobless clone of github.com, anonymous; main clone untouched).
- Claims: ops/lanes122/claims/backend-{671-565893b5,672-193c6f9a,673-91d0adcb,706-87aaf126,707-2bb4b368}-opus.

## Heads (verified on GitHub at 15:12 and again 15:31 PDT)
#671 565893b5c969fdc937d03f3a5b947bcb8d100b11 | #672 193c6f9ac3f57a10b8ff87fa3874ee0f190dd9b7 | #673 91d0adcbb3b1c5eef10266006a6a6a8c6b33f6a5
#706 87aaf126036bc7604dceb3ab55f0ddf255519950 | #707 2bb4b368f39d8a380a48086c6c79d21cb4cc34b9

## Method
Delta since my lens's last verdict head per piece (671 c75002c9, 672 62c2c066, 673 dcf095b8, 706 3d95f96e, 707 ffed434e), by
comparing the PR's own +/- lines old vs new per file (ops/aud-122/AUD-OPUS-TR10-122/dd.sh). Then read the normal-use money/access
paths of the shared trial rule. No probes (RUTHLESS SCOPE: the only changed risky path, the conflict loser, is race-only).

## Verdicts (drafts in ops/aud-122/AUD-OPUS-TR10-122/verdict-<n>.md, manifest MANIFEST.md)
| PR | Verdict | A/B/C | Delta reviewed |
|---|---|---|---|
| #671 | APPROVE | 0/0/0 | ci.yml 2 additive hunks; schema.prisma trial_days declared once (main's) |
| #672 | APPROVE | 0/0/1 | email.service/types: main's abort signal kept, notStarted() returns error 'aborted' |
| #673 | APPROVE | 0/0/2 | FIX ROUND 12 shared trial rule + 3 webhook conflict hunks |
| #706 | APPROVE | 0/0/0 | new test/b-trials-8-shared-rule.spec.ts only |
| #707 | APPROVE | 0/0/0 new | FIX ROUND 2 draft fence (finalize auto_advance=false + void + full recheck); B-707-1 CLOSED |

CI (unauthenticated check-runs, latest per name, 15:28 PDT): all five heads green; only deploy-readiness-gate skipped.
#671 20/21 success; #672/#673/#706/#707 10/11 success (build-and-test green at all five).
Sizes: 2,289 / 2,959 / 2,996 / 1,239 / 1,249.

## Findings
- No B on any piece.
- C-672-L1 (landing note): the train top merges into current main 5cde6253 with ONE conflict, src/notifications/notifications.service.ts
  :~1052 (main #692 B-NOTIF-6 moved the prefs mapping to src/notifications/push/push-preferences.ts notificationPrefsPrefix()). The
  refresh must port `trial_ending` there, or trial-ending notices fall to 'digest' defaults (off) and the 3-day notice is dropped.
  #671 alone merges clean into 5cde6253. The refresh is a conflict resolution: needs a lens delta (not merge-only).
- C-673-11 (builder's): offersForClient has no in-progress state; narrowed by retireStaleTrialAttempts before decide.
- C-673-12 (edge, deferred to 10k clients): race loser's sheet secrets erased (main's `entitled` key); accept B-TR9-121 decision 1.
- Carried: C-673-1 rest, C-673-2/3/4/8/9/10, C-706-2, C-707-2/3/4, MAX_TRIAL_DAYS 730 vs 30.

## Operator decisions
1. (Done 15:42: all five verdicts posted at the verified heads.)
2. Landing: the train needs a main refresh (notifications conflict, C-672-L1) before landing; default: one builder refresh porting
   `trial_ending` into push-preferences.ts, then a short lens delta on that hunk only.
3. B-TR8-120 decision 2 (no native trial_started_at in production): default accept; main has no CoachPackage.trial_days, so
   packageTrialDays is 0 in production.

## Progress log
- 15:12 start; 15:13 gh 401; anonymous clone; 15:28 CI read; 15:31 drafts written, heads re-verified; 15:37/15:42 gh retries.
- 15:42 auth back (operator 15:41). Heads re-verified unchanged; all five posted 15:42 PDT:
  #671 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/671#issuecomment-6004664932
  #672 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-6004665581
  #673 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/673#issuecomment-6004666466
  #706 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/706#issuecomment-6004667126
  #707 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/707#issuecomment-6004667898

## HANDOFF
- Done: full delta review of all five pieces; verdict drafts + MANIFEST in ops/aud-122/AUD-OPUS-TR10-122/.
- Posted: all five verdicts at exact heads (URLs in Progress log). Left for the operator: Sol's verdicts, then the land-time main
  refresh (C-672-L1) with a lens delta on that hunk, then land the train as one.
- Cleanup: read-only clone wt/AUD-OPUS-TR10-122-ro removed at end (no unsaved work); no ci/audit branches created; claims stay.
