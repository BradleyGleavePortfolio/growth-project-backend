Split piece 6/9 of #634 (S-SCHED-2 native scheduling lifecycle), B-SPLIT-SCHED-120 (agent 120). Draft. Owner order 09:45 PDT 10-05: every piece under 1,500 changed lines.

## Tier header
- **Tier:** T4 (max-tier rule: piece of the T4 S-SCHED-2 split).
- **Why:** Read-access change on the scheduling API: my-coaches, access-gated session types with the welcome rule, participant-only session reads (404 SESSION_NOT_FOUND otherwise), client views without coach-only fields, past/upcoming keyset pages, transition routes.
- **T4 trigger scan:** Read-access change: YES (session reads participant-only; client views null coach_notes_md, provider_idempotency_key, video_meeting_id, calendar_event_id and hide video_url while pending). RLS/money/PII: no new table. CI gate file: no.
- **T3 trigger scan:** Routes: YES (scheduling.controller). Cross-repo contract: mobile #325 consumes it.
- **Bounded T1:** none.
- **Canonical builder:** B-SPLIT-SCHED-120 (agent 120), split of S-SCHED-2 (#634; builders agents 110-114, not self-audited).
- **Parent owner:** operator agent 120.
- **Acceptance evidence:** local (ops/heavy.sh, one spec at a time): tsc clean; scheduling.service 13/13 (final form), scheduling-reminder-delivery 21/21, scheduling-permissions 20/20, qa-p0-launch-blockers 17/17, entitlement-guards-mounted 17/17, availability-overrides 10/10, scheduling-providers 7/7, google-calendar-webhook.controller 6/6, gcal-watch-startup 9/9, google-oauth.service 9/9, google-feature-flag 2/2, calendar-oauth-kms 3/3, no-pii-in-logs 11/11, roles-enforced 2/2. Full suite and live lanes in this PR's CI.
- **Promotion triggers:** any change to the access predicate, the exclusion constraint, the occupying-status set, the transition fence, the reminder claim/lease semantics or the reminder switch semantics re-opens T4 review (as #634). No behaviour change beyond the main-merge resolution is allowed in the split.

## Contents (1068 changed lines vs base `agent120/sched-split-5-reminder-job`)
| File | Lines |
|---|---|
| `src/scheduling/scheduling-session.view.ts` | +119 / -0 |
| `src/scheduling/scheduling.controller.ts` | +119 / -29 |
| `src/scheduling/scheduling.module.ts` | +3 / -0 |
| `src/scheduling/scheduling.service.ts` | +424 / -106 |
| `test/scheduling-reminder-delivery.spec.ts` | +262 / -0 |
| `test/scheduling.service.spec.ts` | +4 / -2 |

After this piece every file under src/, prisma/ and scripts/ equals M; 7/9-9/9 change only tests and ci.yml.

Every file in this piece is byte-identical to M.

## Split provenance
- Original: #634 (`agent110/s-sched-lifecycle`) @ `e18e8055454b04856d2c5ab5568d0a7127b74939` (30 files, +9,378/-1,286 vs merge-base 0d33c4d4).
- Reference merge M = `6fc88c457b917d74773f881ffed60c9d3f8d9d35` (branch `agent120/sched-split-0-merged-reference`): #634 @ e18e8055 merged with main `ee55f814eb02b530e6578a168dc16c7ea7e2b07b`, conflicts resolved once; `git show --remerge-diff 6fc88c45` shows every resolved hunk. M vs main: 33 files, +9,774/-1,454.
- Stack: #712 <- #713 <- #714 <- #715 <- #716 <- #717 (this) <- #718 <- #719 <- #720. Land as one stack (MERGE_DEPENDENCY_GUIDE rule 11). #653 (S-SCHED-5 request auto-expiry) restacks onto 9/9.
- Top-tree equality: `git rev-parse 6fc88c45^{tree}` == `git rev-parse c2b27193^{tree}` (9/9 head `c2b271936f47ecf1827f7a46607d29add381579f`) == `0595cfd70254cde577bf1cc3a844fa0c179c1d20`; `git diff 6fc88c45 c2b27193` is empty. No A/B fixes are included (the job is split only).

## Main-merge resolutions (all in M; full list in ops report B-SPLIT-SCHED-120)
Main #643/#647 (B-643-1, B-647-1/2, C-647-2/3, migration 20270301000000 applied in prod) re-keyed reminder claims to (session_id, user_id, kind, start_at) NOT NULL with a FOR SHARE fence, made reschedule keep claims, and added zone provenance. R1 schema [1/9]; R2 lifecycle [4/9]; R3 reminder job [5/9]; R4 emitter [3/9]; R5 emitter spec [3/9]; R6 job spec [5/9]; R7 service spec [2/9, final in 6/9].
In this piece: None of R1-R7 live here (byte-identical to #634 apart from the merged siblings).

## Prior verdicts on #634 (evidence reuse is each lens's decision, byte-identical code only)
- Opus APPROVE @ 3d989702: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5971916062
- Sol APPROVE @ 3d989702: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5971921481
- FIX ROUND 5 @ 3d989702: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5971822865
- Operator update-branch @ e18e8055: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5972077899
- Opus merge-only APPROVE @ e18e8055: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5972118900 (Sol has no verdict at e18e8055)

## Decisions
- D1 migration 20270222000000 sorts before the applied 20270301000000: keep the name (recommended default; the newer-than-20270316000000 rule does not apply to existing migrations). The two commute (20270222 adds state columns, indexes and the constraint; 20270301 adds start_at); `prisma migrate deploy` applies the unapplied one. Alternative: rename to a timestamp newer than 20270316000000.
- Reminder switch: unchanged from #634 (unset means off; set `BOOKING_REMINDERS_ENABLED=on` through the B-FLAGS manifest in the deploy window). Pairs with mobile #325 (OR-112-13).
