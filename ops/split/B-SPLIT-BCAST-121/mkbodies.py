import json
O='https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/659'
OPUS=O+'#issuecomment-5964501283'; SOL=O+'#issuecomment-5964574829'
heads={1:'b5501a89611844fc43717084d887e604af33037a',2:'15cf8e5c0f2e3e6de19a0a8f58c0c1ff6a4f76a5',3:'1dd798ab36e90dbb6b3719b7a4ae13883797167f',4:'82a28bf2dbbe52b516e30fda1d22959ea0f87b42',5:'e97c472f00cdecbce2e5f1a680e05b1744c14715'}
titles={1:'BCAST split 1/5: broadcasts schema, migration, flag and error codes',
2:'BCAST split 2/5: segments, recurrence, send-time scope and cards',
3:'BCAST split 3/5: broadcasts, saved replies and client tags services',
4:'BCAST split 4/5: broadcast dispatcher',
5:'BCAST split 5/5: broadcasts routes, module wiring and live coverage'}
sizes={1:642,2:1221,3:1162,4:1114,5:865}
contents={
1:"""| File | Lines |
|---|---|
| prisma/migrations/20270304000000_a4_broadcasts_cards_saved_replies/migration.sql + down.sql | 264 |
| prisma/schema.prisma (CoachBroadcast, CoachBroadcastRun, CoachBroadcastDelivery, CoachMessageCard, CoachSavedReply, CoachClientTag) | 189 |
| src/broadcasts/broadcast-errors.ts | 123 |
| src/broadcasts/broadcasts.feature.ts (FEATURE_COACH_BROADCASTS reader) | 41 |
| src/account-deletion/account-deletion.manifest.ts (main-merge resolution 1) | 11 |
| src/common/env-validation.ts, .github/fly-env-desired-state.json, docs/runbooks/launch-flags.md (flag registration) | 14 |

Inert: nothing reads or writes the new tables in this piece. Migration additive (new tables, indexes, ENABLE + FORCE RLS, down.sql).""",
2:"""| File | Lines |
|---|---|
| src/broadcasts/segment.ts, recurrence.ts, tz.ts (pure parsing and time-zone math) | 393 |
| src/broadcasts/broadcast-scope.service.ts (roster scope + send-time authority lock) | 81 |
| src/broadcasts/segment-resolver.service.ts | 164 |
| src/broadcasts/cards.service.ts | 178 |
| test/broadcasts/segment, recurrence, cards, broadcast-scope specs + _stub | 405 |

Services only; no module registers them yet (split 5).""",
3:"""| File | Lines |
|---|---|
| src/broadcasts/broadcasts.service.ts (create, update, transitions, preview, list) | 624 |
| src/broadcasts/saved-replies.service.ts, client-tags.service.ts | 178 |
| src/messaging/messaging.service.ts (thread read includes the card row) | 5 |
| test/broadcasts/broadcasts.service.spec.ts | 355 |""",
4:"""| File | Lines |
|---|---|
| src/broadcasts/broadcast-dispatcher.service.ts (claim, fan-out, deliver, finalize) | 591 |
| test/broadcasts/dispatcher-delivery.spec.ts | 523 |

The cron is registered only by BroadcastsModule (split 5), and every phase is behind FEATURE_COACH_BROADCASTS.""",
5:"""| File | Lines |
|---|---|
| src/broadcasts/broadcasts.controller.ts, broadcasts.dto.ts, broadcasts.module.ts | 345 |
| src/app.module.ts (imports BroadcastsModule) | 3 |
| test/broadcasts/broadcasts-dispatch.live.spec.ts | 516 |
| .github/workflows/ci.yml (live spec added to community-live-tests) | 1 |"""}
diffs={
1:"""- `prisma/schema.prisma` 7838-7840: CoachBroadcast unique is `(coach_id, author_user_id, idempotency_key)` instead of `(coach_id, idempotency_key)` (A-659-6).
- `prisma/schema.prisma` 7866-7872 and `migration.sql` 53-56: CoachBroadcastRun gains `body`, `card`, `segment`, `urgent` (the payload frozen at claim, B-659-1).
- `migration.sql` 127: the unique index renamed and widened to match (A-659-6). The migration is not applied anywhere (production `_prisma_migrations` has no 20270304000000 row), so it is edited in place.
- `broadcast-errors.ts` 18-28: two 409 codes, `broadcast.already_sending` and `broadcast.series_started` (B-659-1), each saying what happened and the next action.
- `account-deletion.manifest.ts` 92-102: main-merge resolution 1 (not in #659): decisions for the six new user columns (C-659-2).""",
2:"""- `broadcast-scope.service.ts` 2, 14-23, 41-80: new `lockSendAuthority(tx, tenant, author, client)`: the author's and the client's User rows, the membership row (`SubCoachScopeService.lockMembershipHeadCoachIdInTx`) and, for a sub-coach, the open SubCoachAssignment are read FOR SHARE inside the message transaction (A-659-7).
- `test/broadcasts/broadcast-scope.spec.ts` (new, 118 lines): decision table for that check.
- Every other file in this piece is byte-identical to #659.""",
3:"""- `broadcasts.service.ts` 194-195, 242-265: create replays only the caller's own (tenant, author, key) broadcast; replay re-checks tenant and author (A-659-6).
- `broadcasts.service.ts` 275-293: update refuses a one-off that has a run (`broadcast.already_sending`) and a series-to-one-off change once a run exists (`broadcast.series_started`); a series edit starts after the last claimed local day (B-659-1).
- `broadcasts.service.ts` 347-357: resume never re-arms a one-off that has a run; a series resumes after the last claimed local day (B-659-1).
- `broadcasts.service.ts` 433-442, 545-565: `lastClaimed()` and exported `afterClaimed()` (B-659-1).
- `test/broadcasts/broadcasts.service.spec.ts` 2, 142-355: A-659-6 and B-659-1 cases.
- `saved-replies.service.ts`, `client-tags.service.ts`, `messaging.service.ts` are byte-identical to #659.""",
4:"""- `broadcast-dispatcher.service.ts` 6, 104: exception text in the two log calls goes through `describeFailure` (main-merge resolution 2, not in #659).
- 111-120, 134, 205, 320-322: FEATURE_COACH_BROADCASTS re-read at every phase, per occurrence, per run and per delivery before the claim (B-659-9).
- 147-156, 173-176: the claim CAS pins `updated_at` and freezes body, card, segment and urgent on the run (B-659-1).
- 239-246: fan-out uses the run's segment; a removed author fails the run (`author_removed`), never the head coach (B-659-1, A-659-7).
- 330-335 (claim no longer counts an attempt) and 460-483 (a failed send counts one): C-659-3, on the same lines as the B-659-9 park.
- 350-365, 394, 414-418: deliver uses the run payload and refuses a removed author (B-659-1, A-659-7).
- 418, 483-513: `fenceSend` first in the message transaction: broadcast row FOR SHARE (canceled skips, paused parks; B-659-8), `lockSendAuthority` (A-659-7), flag read last (B-659-9). 567-578: `SendRefusedError`.
- 37-38, 74-78: `PARK_MS` and the class doc.
- `test/broadcasts/dispatcher-delivery.spec.ts`: harness carries the run payload and the live status; 19 new cases.""",
5:"""- `test/broadcasts/broadcasts-dispatch.live.spec.ts`: flag set in beforeAll; two sub-coaches with seats and assignments seeded and removed; four new Postgres cases: pause mid-run, edit refused, resume (B-659-1); cancel committed while a copy waits on FOR SHARE (B-659-8); same key from two sub-coaches (A-659-6); reassignment committed while a sub-coach copy waits (A-659-7).
- Controller, DTO, module, app.module and the ci.yml line are byte-identical to #659."""}
for k in range(1,6):
    base='main' if k==1 else f'BCAST split {k-1}/5'
    b=f"""Split piece {k}/5 of #659 (A4 broadcasts), B-SPLIT-BCAST-121 (agent 121). Draft. Base: {base}.

## Tier header
- **Tier:** T4
- **Why:** new tenant-scoped tables with ENABLE + FORCE RLS, account-deletion manifest entries (PII), sub-coach authority at send time, a CI gate file line (community-live-tests), a kill-switch flag.
- **Canonical builder:** B-SPLIT-BCAST-121 (agent 121), split of #659 plus its fix round 1.
- **Parent owner:** operator agent 121.
- **Acceptance evidence:** targeted local runs (heavy.sh, one at a time) listed in the FIX ROUND 1 comment; full suite in this PR's CI.
- **Promotion trigger:** `FEATURE_COACH_BROADCASTS` stays unset (off). Turning it on needs the whole stack landed and the mobile day-1 work (ops report B-SPLIT-BCAST-121).

## Contents ({sizes[k]:,} changed lines)
{contents[k]}

## Lines that differ from #659 (merged with main) and why
{diffs[k]}

## Split provenance
- Original: #659 (`annex/a4-broadcasts-be`) @ `fa9a7cbd33c5f1c1d5108f3a3d57ea70f3177faf` (3,929 lines).
- Prior verdicts at that head: [Opus REQUEST CHANGES]({OPUS}) (0/1/4), [Sol BLOCK]({SOL}) (2/3/3).
- Plain merge M0 = `03c5d7316528bf68df182e7509deda9b07617dc6` (#659 + main `5da537d60b5775078c20530829c94d33be2bc527`, no textual conflicts). Fixed reference M1 = `cb87282a00ae5119851f9b4417e9f2c40046030a` (branch `agent121/bcast-split-0-merged-reference`, one commit on M0). `git diff 03c5d731 cb87282a` is exactly the main-merge resolutions and A/B fixes listed per piece.
- Stack: split 1/5 (main) <- 2/5 <- 3/5 <- 4/5 <- 5/5. Land as one stack (rule 11).
- Top-tree equality: `git rev-parse cb87282a^{{tree}}` == `git rev-parse e97c472f^{{tree}}` (split 5/5 head) == `6b89e8e23a831749b8fdd2604b9041d164714118`.

## Main-merge resolutions (semantic; no textual conflicts)
1. `src/account-deletion/account-deletion.manifest.ts`: main's erasure-manifest-coverage gate fails on M0 (2 failed: CoachBroadcast.coach_id, CoachBroadcast.author_user_id, CoachBroadcastDelivery.recipient_id, ...). Delete decisions for CoachBroadcast.author_user_id and .coach_id, CoachBroadcastDelivery.recipient_id, CoachSavedReply.owner_user_id, CoachClientTag.coach_id and .client_id, after the CoachMessage detach. [split 1]
2. `src/broadcasts/broadcast-dispatcher.service.ts`: main's no-pii-in-logs gate fails on M0 (2 exception-text log calls); both use `describeFailure(err)`. [split 4]

## Flags
`FEATURE_COACH_BROADCASTS` unchanged (unset, off).
"""
    open(f'bodies/{k}.md','w').write(b); open(f'bodies/{k}.title','w').write(titles[k])
json.dump(heads,open('heads.json','w'))
