# AUD-SOL-HC13-121 — agent 121 — Health Connect follow-up / ingest flag

## Status
- COMPLETE 2026-10-05 14:55:36 PDT (`date`): independent Sol verdicts posted, exact heads verified unchanged after publication.
- Independent Sol audit started 2026-10-05 14:51 PDT; exact GitHub heads confirmed and claimed before reading code.
- Mobile [#378](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/378): `2ea649a1bd9d4ba8f61c9c84f57e100df8b31fb7`, 1,055 changed lines.
- Backend [#731](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/731): `958d340d480e569770345f38bd0130dcd7cb64ee`, draft, 13 changed lines.
- Scope: _COMMON_121 items 13–14 plus the assigned HC13 job: wrong-account health data, ordinary-user data loss/double count, non-finishing sync, crash, permissions/store policy, false claims.
- No merge, deployment, production access, or PR-head changes.

## Published verdicts
| PR | Exact head | Verdict | A/B/C | Published comment |
|---|---|---|---|---|
| Mobile #378 | `2ea649a1bd9d4ba8f61c9c84f57e100df8b31fb7` | APPROVE | 0/0/0 | [Sol audit](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/378#issuecomment-6003831008) |
| Backend #731 | `958d340d480e569770345f38bd0130dcd7cb64ee` | APPROVE | 0/0/0 | [Sol audit](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/731#issuecomment-6003830962) |

## Review and evidence
- Full mobile diff (all 11 changed files and three new test files), surrounding Health Connect / Apple Health sync, native reader, normalization, ingest and account-fence context reviewed; no in-scope A/B issue. [Mobile verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/378#issuecomment-6003831008)
- Entire backend manifest/runbook diff plus actual flag guard, ownership/provider/lifecycle checks, throttle isolation and apply/plan contract reviewed; no in-scope A/B issue. [Backend verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/731#issuecomment-6003830962)
- Exactly one targeted spec, explicitly permitted by this job, executed locally through `heavy.sh`: `healthConnectSyncService.hc12.test.ts`, **6/6 PASS**, 3.525 seconds; real ingest API/batching exercised for changed-record refresh, first import/resume, overlapping sleep/nap and 429 saved-page resume. [Execution disclosed in verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/378#issuecomment-6003831008)
- No backend spec executed by this lens; builder's manifest 67/67, sync-behavior 54/54 and workflow 15/15 are reported evidence only. [Backend builder opening](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/731#issuecomment-6002677024)
- Prior Sol H9 report read; no other lens's current-round notes/comment read before publication.
- Evidence directory: `/home/user/workspace/ops/aud-121/AUD-SOL-HC13-121/` contains review notes, exact posted payloads, API comment receipts, final head/check JSON and the targeted local execution log.

## CI
- Mobile head checks are cancelled, not green: [mobile CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37371374734).
- Backend substantive checks cancelled; readiness comment job failed downloading absent `deploy-readiness-board`, readiness gate skipped: [backend readiness run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37372034843).
- No queued-run waiting, CI rerun, workflow dispatch or new audit lane.
- These are code approvals only, not green required checks, native/device acceptance or release readiness. [Mobile verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/378#issuecomment-6003831008), [backend verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/731#issuecomment-6003830962)

## Follow-ups (C)
- No new C findings; no prohibited edge-category analysis or probes.
- Existing rewritten-record replacement follow-up remains [backend #732](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/732); keep accepted first-posted sleep wins, 60-second Retry-After cap and 50/60-second pacing. [Mobile opening defaults](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/378#issuecomment-6002676577)
- Builder's previously recorded edge follow-ups remain deferred to 10,000 clients; not reopened or counted as new findings. [Existing deferred list](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/378#issuecomment-6002676577)

## Operator decisions
- None new. Recommended default: reconcile required checks/companion verdicts before merge; merge mobile #378 before applying backend #731, then the owner device pass, retaining all accepted defaults. [Mobile verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/378#issuecomment-6003831008), [backend verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/731#issuecomment-6003830962)

## HANDOFF
- DONE: both exact-head APPROVE 0/0/0 comments published; live heads unchanged on final REST verification at 14:55:36 PDT.
- Remaining operator work: companion-lens/check reconciliation and the accepted merge/apply/device sequence; neither PR is CI-green.
- Workspace evidence preserved, including detached worktrees `/home/user/workspace/wt/AUD-SOL-HC13-121-mobile` and `/home/user/workspace/wt/AUD-SOL-HC13-121-backend`; no audit/ci branch created, no source edits, no production action.
