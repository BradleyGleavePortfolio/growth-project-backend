import json
M='cd130ae4cd4e0f72657110e980fc1ccd73ab5910'
ORIG='6055648506036c4b649cc7958c50ff86c132e997'
MAIN='ee55f814eb02b530e6578a168dc16c7ea7e2b07b'
common_tail = f"""
## Split provenance
- Original: #660 (`feat/a3-msg-core-inbox`) @ `{ORIG}` (3,041 lines; never reviewed; no AUDIT or FIX ROUND comments).
  Prior verdicts: none. Its CI on 10-03 was green except community-live-tests (run 37082428163, see "Known red" below).
- Reference merge M = `{M}` (branch `agent120/msg-split-0-merged-reference`): #660 merged with main `{MAIN}`,
  conflicts resolved once. `git show --remerge-diff {M[:8]}` shows every resolved hunk.
- Stack: split 1/4 (main) <- split 2/4 <- split 3/4 <- split 4/4. Land as one stack (MERGE_DEPENDENCY_GUIDE rule 11).
- Top-tree equality: `git rev-parse {M[:8]}^{{tree}}` == `git rev-parse <split 4/4 head>^{{tree}}` == `2ba9ed0815f36b6b0b7d20b7cd4ba252fb2ff749`;
  `git diff {M[:8]} <split 4/4 head>` is empty. No A/B fixes are included (the job is split only).

## Main-merge resolutions (all in M; each lives in the piece that owns the file)
1. `src/messaging/messaging.service.ts` imports (textual): both sides kept. [split 2]
2. `sendAsCoach` insert (textual, two hunks): welcome-job sends (B-609-3, internal only, never carry `client_message_id` or
   `reply_to_id`) keep main's lease-fenced `persistCoachMessage`; every other send takes #660's `insertThreadMessage`; one
   `duplicate` flag skips every side effect for a welcome duplicate and for an idempotent replay. Both helpers are byte-identical
   to their side. [split 2]
3. `src/account-deletion/account-deletion.manifest.ts` (semantic; main's erasure-manifest-coverage gate, A-608-1):
   CoachMessage.deleted_by_id / pinned_by_id detach; CoachThreadState user_id / coach_id / client_id delete. [split 1]
4. Log calls (semantic; main's no-pii-in-logs C-700-2 baseline): the mute-lookup warn and both thread-updated warns print
   `describeFailure(err)` instead of exception text. [split 2]
5. `test/messaging/messaging-core-v2.spec.ts` (semantic): row fixture gains `welcome_job_id: null` (B-609-3 column), the tx double
   gains `communityVoiceErasure.updateMany` (main C-610-12). [split 2]

## Known red (inherited from #660, pre-existing gap on main; operator decision D1)
community-live-tests: `test/messaging/rls/coach-thread-state-rls.live.spec.ts` case "pin / reply columns are visible to participants
and to no one else" fails because no migration in the chain enables RLS on "CoachMessage" (only the loose
`prisma/migrations/rls_fitness_backend.sql` does; policy `coach_message_participant_access` from 20260607000000 is inert while RLS
is off). The split carries the spec unchanged. Details and options: ops report B-SPLIT-MSG-120 (D1).

## Flags
`FEATURE_MESSAGING_CORE_V2` stays unset (off). Flag flips are a separate operator PR after the stack lands.
"""
tier = """## Tier header
- **Tier:** T4
- **Why:** {why}
- **T4 trigger scan:** {t4}
- **T3 trigger scan:** {t3}
- **Bounded T1:** {t1}
- **Canonical builder:** B-SPLIT-MSG-120 (agent 120), split of TGP annex lane A3-MSG-CORE (#660).
- **Parent owner:** operator agent 120.
- **Acceptance evidence:** {ev}
- **Promotion triggers:** flipping `FEATURE_MESSAGING_CORE_V2=true` needs the whole stack landed, mobile thread polish and the
  operator call on "delete erases content" (#660 body); D1 resolved.
"""
pieces = {
1: dict(why="New tenant-scoped table with ENABLE + FORCE RLS (CoachThreadState), new user-id columns on CoachMessage, account-deletion manifest entries (PII), CI gate file (community-live-tests list).",
 t4="RLS/tenancy: YES (new table + policies). PII/deletion: YES (manifest entries). CI gate file: YES (one line in ci.yml). Money/auth: no.",
 t3="Schema migration: YES (20270303000000_messaging_core_actions, additive, nullable, down.sql). Routes: no. Realtime: no.",
 t1="none.",
 ev="live RLS spec in community-live-tests (10 cases); erasure-manifest-coverage 7/7 and manifest-fk-order 10/10 (local, targeted); tsc clean (local); full suite in this PR's CI.",
 contents="""## Contents (459 lines, inert)
| File | Lines |
|---|---|
| prisma/migrations/20270303000000_messaging_core_actions/migration.sql + down.sql | 112 |
| prisma/schema.prisma (CoachMessage action columns, CoachThreadState) | 43 |
| src/account-deletion/account-deletion.manifest.ts (main-merge resolution 3) | 10 |
| test/messaging/rls/coach-thread-state-rls.live.spec.ts | 293 |
| .github/workflows/ci.yml (spec added to community-live-tests) | 1 |

Nothing reads or writes the new columns or table in this piece. Migration: additive only (nullable columns, new table, indexes,
self FK ON DELETE SET NULL, RLS ENABLE + FORCE with self-only and owner policies).
"""),
2: dict(why="Kill switch and error contract for the 1:1 coach thread, idempotent send and reply validation in MessagingService (PII: message content, block filtering, sub-coach scope).",
 t4="Access/tenancy: YES (thread resolution, block parity on reads). PII: YES (reply quotes, logs carry ids and codes only). Money/auth: no.",
 t3="Shared service: YES (MessagingService send/read/unread paths; flag-OFF behaviour asserted legacy). Realtime: new ID-only `thread-updated` event. Env: new FEATURE_MESSAGING_CORE_V2.",
 t1="launch-flags runbook row, fly-env desired-state entry.",
 ev="messaging-core-v2.spec.ts subset 15/15; messaging.service 26/26, messaging-voice 11/11, welcome-message-idempotency 7/7, no-pii-in-logs 11/11, env-validation 50/50, fly-env-manifest 67/67, env-discovery 181/181, env-registration 30/30, feature-flags service 9/9 + controller 9/9 (local, targeted); tsc clean; full suite in this PR's CI.",
 contents="""## Contents (1,141 lines)
| File | Lines |
|---|---|
| src/messaging/messaging.service.ts (idempotent insert, reply validation + quotes, read-up-to, unread without tombstones, mute-aware push; resolutions 1, 2, 4) | 471 |
| src/messaging/messaging-errors.ts, messaging-core.feature.ts (guard), messaging-realtime.ts | 200 |
| src/common/env-validation.ts, src/feature-flags/* (key `messaging_core_v2`), .github/fly-env-desired-state.json, docs/runbooks/launch-flags.md | 24 |
| test/messaging/messaging-core-v2.spec.ts (kill switch, idempotent send, swipe-reply, muted push, read-up-to, unread) | 446 |

Inert until routes land (split 4/4): no current route passes `client_message_id` or `reply_to_id`; every v2 read/unread/push change is
behind the flag (off). The spec file grows as an in-order subsequence: splits 3 and 4 only add lines. The mute describe block keeps
its `thread` constant here; the cases that use it arrive with MessageActionsService in split 3/4.
"""),
3: dict(why="Message edit and delete-for-everyone (content erasure, voice object erasure ledger), thread pins, per-user mute and inbox pin, unified inbox query bound to coach scope (PII, tenancy).",
 t4="PII/erasure: YES (tombstone erases body/voice, durable voice erasure). Tenancy: YES (inbox bound to head-coach namespace and authorized clients). Money/auth: no.",
 t3="New services registered in MessagingModule (no route uses them yet). Concurrency: pin cap under a thread advisory lock, conditional writes.",
 t1="none.",
 ev="messaging-core-v2.spec.ts 36/36 (adds edit, delete, pins, mute, inbox pin, unified inbox); no-pii-in-logs 11/11 (local, targeted); tsc clean; full suite in this PR's CI.",
 contents="""## Contents (1,092 lines)
| File | Lines |
|---|---|
| src/messaging/message-actions.service.ts | 419 |
| src/messaging/messaging-inbox.service.ts | 293 |
| src/messaging/messaging.module.ts (providers) | 6 |
| test/messaging/messaging-core-v2.spec.ts (+ edit, delete, pins, mute, inbox pin, unified inbox) | 374 |

Providers are registered but no route reaches them until split 4/4.
"""),
4: dict(why="New coach and client routes on the 1:1 thread (inbox, edit, delete, pins, mute, inbox pin, read-up-to) and the send contract (idempotency key, reply). Access boundary: every new route behind JwtAuthGuard + role guards + MessagingCoreV2Guard (503 when OFF).",
 t4="Access: YES (new routes; guards). PII: YES (message bodies on edit). Money/auth: no.",
 t3="Public route contract: YES (new routes, `Idempotency-Key` header, `client_message_id`, `reply_to_id`).",
 t1="src/messaging/README.md.",
 ev="messaging-core-v2.spec.ts 37/37; coach-messaging-roles 5/5, entitlement-guards-mounted 17/17, rate-limit 39/39, roles-enforced 2/2 (local, targeted, on the same tree); tsc clean; full suite in this PR's CI.",
 contents="""## Contents (388 lines)
| File | Lines |
|---|---|
| src/messaging/coach-messaging.controller.ts | 118 |
| src/messaging/client-messaging.controller.ts | 109 |
| src/messaging/messaging.dto.ts | 72 |
| src/messaging/messaging-idempotency.ts | 25 |
| src/messaging/README.md | 43 |
| test/messaging/messaging-core-v2.spec.ts (+ Idempotency-Key header case) | 21 |

This is the top piece: its tree equals M (proof below).
"""),
}
titles = {
1: "MSG split 1/4: feat(messaging): thread-state schema, RLS and erasure entries (split of #660; inert)",
2: "MSG split 2/4: feat(messaging): v2 flag, error codes, idempotent send, reply, read-up-to, mute-aware push (split of #660)",
3: "MSG split 3/4: feat(messaging): edit, delete, pins, mute, inbox pin and unified inbox services (split of #660)",
4: "MSG split 4/4: feat(messaging): inbox, edit/delete, reply, pins, mute and read-up-to routes (split of #660)",
}
for k,p in pieces.items():
    body = f"Split piece {k}/4 of #660 (A3-MSG-CORE messaging inbox), B-SPLIT-MSG-120 (agent 120). Draft.\n\n" + tier.format(**p) + "\n" + p['contents'] + common_tail
    open(f'bodies/{k}.md','w').write(body)
    open(f'bodies/{k}.title','w').write(titles[k])
print('ok')
