RESTACK (merge-only, B-SPLIT-SCHED-120, agent 120) — growth-project-backend#653 @ 9a23e3b2471794a1356d9939cc4e06682f1ea7ec

| Item | State |
|---|---|
| Old head | `17b2be255b0087196b9c1c81cc38397330c56c75` (base `agent110/s-sched-lifecycle`, DIRTY) |
| New base | `agent120/sched-split-9-integrity-tests-c-live` (#720, S-SCHED-2 split 9/9 of #634) |
| Commits | `8ed8e3ac` merges the reference merge `6fc88c45` (#634 @ e18e8055 + main @ ee55f814; this branch held #634 only to bb6f3ea8); `9a23e3b2` merges 9/9 `c2b27193` (tree equal to `6fc88c45`, so every hunk keeps this side; tree unchanged, `94a63a15d3af74c51f8d3436b5e9e9987f06cf3f`) |
| Size vs new base | 19 files, +1,414 / -23 = 1,437 (was +1,411 / -23) |
| R75 | no positive token change |
| Fixes | none; S-SCHED-5 behaviour unchanged apart from the resolution below |

Resolved hunks (merge of `6fc88c45`):

| # | File | Resolution |
|---|---|---|
| H1 | `src/scheduling/jobs/reminder.job.ts` describeError | this PR's `export` (request-expiry.job imports it) with #634's B-634-10 body `safeLogDiagnostic(err).slice(0, 200)` |
| H2 | `src/scheduling/scheduling-session-lifecycle.service.ts` reschedule | this PR's lapsed-request answer on `moved.count !== 1` kept; the reminder-claim `deleteMany` dropped with main's B-647-1 comment (claims are keyed by start_at, so a move never deletes claims) |

Semantic follow-through (needed to compile against main's claim key and zone rules):

| # | File | Change |
|---|---|---|
| F1 | `src/scheduling/jobs/request-expiry.job.ts:256` | notice claim writes `start_at` (main's NOT NULL key column) instead of `session_start_at` (folded into start_at in the S-SCHED-2 merge) |
| F2 | `src/notifications/emitters/booking.emitter.ts` emitRequestExpired | zone through `zoneFor(recipient, session)` (main's resolveRecipientTimeZone); no clock time without a usable zone ("Your <type> request was not confirmed in time, so it has closed. Pick another time in Calendar."); payload `timeZone` |
| F3 | `test/scheduling-request-expiry.spec.ts` | `BookingEmitter` gets `asPrisma(db)` (main C-647-2 constructor) |

Checks at this head (latest run per check):

| Check | Result |
|---|---|
| Forward migrations apply cleanly | success ([run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37353865763/job/111911198624)) |
| New migrations are reversible (or explicitly marked IRREVERSIBLE) | success ([run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37353865763/job/111911629452)) |
| Schema parity (migrations match schema.prisma) | success ([run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37353865843/job/111911199261)) |
| build-and-test | success ([run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37353865801/job/111911198590)) |
| comment-deploy-readiness | success ([run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37353865771/job/111911721930)) |
| community-live-tests | success ([run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37353865801/job/111911198471)) |
| deploy-readiness-gate | skipped ([run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37353865771/job/111911200201)) |
| mwb-3-live-tests | success ([run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37353865801/job/111911198202)) |
| npm audit (high+critical, whole graph) | success ([run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37353865790/job/111911198909)) |
| rls-floor-guard | success ([run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37353865801/job/111911198389)) |
| rls-live-tests | success ([run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37353865801/job/111911198536)) |
| size-label | success ([run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37353865800/job/111911198078)) |
| test-deploy-readiness | success ([run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37353865771/job/111911198178)) |
| CodeQL, danger, Banned cast tokens, build-sbom | run on base main only (stacked PR) |

Local (ops/heavy.sh, one at a time): tsc clean; scheduling-request-expiry 20/20, scheduling-lifecycle-integrity 103/103, scheduling.service 13/13, booking-emitter 21/21, booking-reminder.job 21/21, scheduling-reminder-delivery 21/21, delivery-status-contract 4/4, no-pii-in-logs 11/11, booking-reminder-local-time 8/8, log-diagnostic-closed-enum 12/12, scheduling-permissions 20/20, qa-p0-launch-blockers 17/17.

Probe replay: no lens has audited #653 yet (no AUDIT comments), so there are no prior probes to replay.

Money list self-check:
- webhook order and redelivery: no webhook handler in this PR.
- concurrency and lock order: the expiry sweep runs under the SchedulingJobLease single-runner lease; lapsed answers stay inside the per-coach booking transaction (H2).
- terminal states: `expired` is terminal and frees the slot; the notice claim is (session, user, kind, start_at), once per side.
- pagination and fail-closed completeness: sweep pages unchanged; a non-P2002 claim error counts as failed and the session is retried.
- currency and minor units: no money in this PR.
- copy truth: expiry copy names the time only with a usable zone (F2); no first person, no exclamation marks.

READY FOR AUDIT
