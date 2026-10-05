# AUD-OPUS-BC1-122 — Claude Opus 5.5 lens, broadcasts backend b#726-#730 (agent 122)

Window: 16:05-16:20 PDT 2026-10-05 (times from `TZ=America/Los_Angeles date`). Time box was 45 minutes; this took 15. First full review of the split pieces (T4). Independence: I did not read the Sol notes, report or comments before posting.

## Verdicts (all posted at the exact heads, re-verified right before posting)
| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| #726 schema/migration/flag/errors | b5501a89611844fc43717084d887e604af33037a | APPROVE | 0/0/1 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/726#issuecomment-6005262469 |
| #727 segments/recurrence/scope/cards | 15cf8e5c0f2e3e6de19a0a8f58c0c1ff6a4f76a5 | APPROVE | 0/0/1 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/727#issuecomment-6005262902 |
| #728 services | 1dd798ab36e90dbb6b3719b7a4ae13883797167f | APPROVE | 0/0/3 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/728#issuecomment-6005263205 |
| #729 dispatcher | 82a28bf2dbbe52b516e30fda1d22959ea0f87b42 | APPROVE | 0/0/2 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/729#issuecomment-6005263504 |
| #730 routes/module/live | e97c472f00cdecbce2e5f1a680e05b1744c14715 | APPROVE | 0/0/1 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/730#issuecomment-6005263800 |

Comment texts: ops/aud-122/AUD-OPUS-BC1-122/v726.md ... v730.md.

## Prior Opus findings on #659 (my lens, AUD-OPUS-114B)
- **B-659-1, CLOSED.**
  - Service: `update` refuses a started one-off (`broadcast.already_sending`), and a series edit lands after the last claimed local day.
  - `resume` never re-arms a started one-off.
  - Dispatcher: the run payload (body, card, segment, urgent) is frozen at the claim, and every copy uses it.
  - Unit tests are green in the lane. The live case at broadcasts-dispatch.live.spec.ts:371 has not run yet.
- **C-659-2 closed** (manifest entries). **C-659-3 closed** (`attempts` counts failed sends only).
- **C-659-4 narrowed** (fan-out uses the author's roster) and is carried as a C on #728. **C-659-5** is carried on #729.

## Item-list checks (all clean)
- **Another coach's clients:** the audience is limited to the roster from SubCoachScopeService, and package and program refs are checked against the tenant.
- **Client who left:** the send-time `lockSendAuthority` (FOR SHARE) refuses a client who switched coach, deleted their account or was unassigned, and an author whose seat was closed.
- **Messages off:** a client who muted or turned off message pushes gets the copy silently in the thread, the same as 1:1. Quiet hours defer the copy.
- **Private data:** cards are snapshots resolved by the server (a client-specific meal plan cannot go to a group). The push carries only the sender name. Each copy lands in the client's own thread.
- **Double send or never send:** unique run_key per occurrence, unique (run_id, recipient_id), lease-fenced message write with a unique message_id. The cron is registered, and the AppModule boots.
- **Migration:** additive, six tables, FORCE RLS with service_role only and RESTRICTIVE deny for anon and authenticated, a down.sql, and correct ordering for the dry-run chain.

## Evidence
- Lane run 37386665159 (top head e97c472f): full tsc green; test/broadcasts plus erasure-manifest-coverage, manifest-fk-order, no-pii-in-logs, fly-env-manifest and fly-env-classifier gave 11 suites, 227 passed. The live spec was skipped because the lane has no DB. https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37386665159
- Lane run 37387377022: openapi-spec (boots the full AppModule), module-graph, roles-enforced, messaging.service and coach-messaging-roles gave 5 suites, 43 passed. https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37387377022
- Two lane pushes instead of one, run back to back: the boot proof was added after the first run finished, since PR CI was cancelled everywhere. There was never more than one run in flight.
- Logs: ops/aud-122/AUD-OPUS-BC1-122/lane_*.log.
- Relative imports resolve at every piece head.
- PR CI state: every check was cancelled at all five heads (runner incident). Required checks, including community-live-tests with the 4 new live cases, Schema parity and Migration Dry-Run, still have to run green before merge.

## Cs (follow-up tickets)
- C-726-1: the migration header names a spec that does not exist (migration.sql:12).
- C-727-1: archived clients are still on the broadcast roster: no `archived_at` filter in getAuthorizedClientIds or in the send-time client checks (broadcast-scope.service.ts:64, dispatcher :369-371). This is operator decision 1.
- C-728-1: a PATCH to a draft that omits `status` arms it. `validate` defaults to 'scheduled' (broadcasts.service.ts:154), so with no send_at it sends on the next tick. Fix: default to the row's own status.
- C-728-2: the `broadcast.not_editable` copy promises "Duplicate it", but no duplicate route exists. The mobile composer must offer Duplicate, or the copy must change.
- C-659-4: carried (head coach edit is validated against the head's roster).
- C-659-5: carried (direct coachMessage.create skips the messaging.sent audit and the AI-context invalidation).
- C-659-10: carried (live RLS assertions are thin).
- C (edge, deferred to 10k clients): the quiet-hours zone falls back to America/Los_Angeles (dispatcher :395); push_status stays pending after a crash between commit and push.

## Operator decisions (recommended defaults)
1. **Archived clients in broadcasts (C-727-1).** Default: exclude them before the flag flips. That is a one-line `archived_at: null` in the broadcast roster plus the send-time client check, in the mobile-composer window. It does not block this train, because the flag stays off.
2. **Draft PATCH default (C-728-1).** Default: the backend keeps the row's status when `status` is omitted. The follow-up lands before the flag flips.
3. **CI.** Default: the operator re-runs the cancelled PR workflows at all five heads and lands the stack as one (A5 rule 11) once everything is green. The live spec has to pass in community-live-tests.
4. **Builder decisions in B-SPLIT-BCAST-121** (delete an erased author's broadcasts; keep the 20270304 name; keep the B-659-8 and B-659-9 fixes). Default: keep all three.

## HANDOFF
Done: five APPROVE verdicts posted at the exact heads above. Claims are in ops/lanes122/claims/backend-<n>-<head8>-opus. Worktree removed. Branch audit/AUD-OPUS-BC1-122/730 deleted. No locks held, and nothing was pushed to any PR branch.
Left for the operator:
- Re-run PR CI at the five heads.
- Pair these verdicts with the Sol lens's verdicts.
- Decide items 1-4.
- If any head moves, a delta re-review is needed (20 minutes): check only the changed lines and C-727-1 / C-728-1 if they were fixed.
