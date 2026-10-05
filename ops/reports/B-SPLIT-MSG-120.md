# B-SPLIT-MSG-120 — split backend #660 messaging inbox (agent 120)

Job: JOBS120.md "B-SPLIT-MSG-120". T4 (PII, access). Split only, no behaviour change beyond the main-merge resolution.
Stack lock: ops/lanes120/locks/msg (taken 09:47:27 PDT 10-05).
Worktree: /home/user/workspace/wt/B-SPLIT-MSG-120-1. Tools: ops/split/B-SPLIT-MSG-120/{plan.json,spec_subset.py,build.sh}.

## Source
- Original #660 head 6055648506036c4b649cc7958c50ff86c132e997 (feat/a3-msg-core-inbox), merge-base 53b6d472, 25 files
  +3,002/-39 = 3,041. Never reviewed (only bot comments). Its own CI on 10-03: all green EXCEPT community-live-tests
  (run 37082428163, job 111085632366): coach-thread-state-rls.live.spec.ts case "pin / reply columns are visible to
  participants and to no one else" fails: a stranger sees all 3 CoachMessage rows. See D1.
- Main = ee55f814eb02b530e6578a168dc16c7ea7e2b07b.

## Main merge (reference M = cd130ae4cd4e0f72657110e980fc1ccd73ab5910, parents 60556485 + ee55f814; tree 2ba9ed08)
Textual conflict (one file, three hunks), src/messaging/messaging.service.ts:
1. imports: kept both (main's holdWelcomeLease/WelcomeLeaseLostError + #660's feature/errors/realtime imports).
2+3. sendAsCoach insert: main routed every send through persistCoachMessage(data, options.welcome) (B-609-3 lease
   fence); #660 routed it through insertThreadMessage (idempotency key + reply validation). Resolution: welcome-job sends
   (internal only; never carry client_message_id/reply_to_id) keep persistCoachMessage unchanged; every other send takes
   insertThreadMessage unchanged; one `duplicate` flag skips all side effects for both (welcome duplicate or idempotent
   replay). Both helper functions are byte-identical to their sides.
Semantic resolutions (no textual conflict; each one is required by a gate that exists only on main):
4. src/account-deletion/account-deletion.manifest.ts (+10): erasure-manifest-coverage (A-608-1) requires a decision for
   every user-id column: CoachMessage.deleted_by_id / pinned_by_id -> detach; CoachThreadState user_id / coach_id /
   client_id -> delete (the #660 body asked for the CoachThreadState entry).
5. Log calls (no-pii-in-logs, C-700-2: messaging.service.ts baseline 1, new files 0): mute-lookup warn in
   messaging.service.ts and both thread-updated warns in messaging-realtime.ts print describeFailure(err) instead of
   err.message.
6. test/messaging/messaging-core-v2.spec.ts: row() fixture gains `welcome_job_id: null` (B-609-3 column; tsc error
   otherwise) and the tx double gains communityVoiceErasure.updateMany (main C-610-12 changed recordVoiceErasures).
Checked on M locally (heavy.sh, one at a time): tsc 0 errors; messaging-core-v2 37/37; erasure-manifest-coverage 7/7;
manifest-fk-order 10/10; welcome-message-idempotency 7/7; coach-welcome.service 42/42; no-pii-in-logs 11/11;
coach-messaging-roles, entitlement-guards-mounted, rate-limit, roles-enforced pass.

## Pieces (drafts opened 10:18 PDT 10-05: #708 split-1, #709 split-2, #710 split-3, #711 split-4)
| k | branch | head | base | size | contents |
|---|---|---|---|---|---|
| 1 (#708) | agent120/msg-split-1-schema-rls | 5c9c6a0e512e5bac1185e51e877d306684a84a3e | main | 459 | migration+down, schema, manifest, live RLS spec + ci.yml line |
| 2 (#709) | agent120/msg-split-2-core-service | 87f0bfffa9663661c7b1fe61fd892dbdaa59469a | split-1 | 1,141 | flag (env rule, fly, runbook, feature-flags), guard, errors, realtime, MessagingService, spec subset (15 cases) |
| 3 (#710) | agent120/msg-split-3-actions-inbox | 47b528ceb99eeaf0b2805c73cedf65936ed7db29 | split-2 | 1,092 | MessageActionsService, MessagingInboxService, module providers, spec subset (+21 = 36) |
| 4 (#711) | agent120/msg-split-4-routes | 5a7c41e89ff6f79fc02fd8bab06e7b83bd11d666 | split-3 | 388 | controllers, DTOs, idempotency header, README, last spec case (37) |
Total 3,080 (= M vs main). Tree of split-4 == tree of M (2ba9ed0815f36b6b0b7d20b7cd4ba252fb2ff749).
The spec file grows as an in-order subsequence (each piece only adds lines). Per piece: tsc 0 errors, core-v2 spec green
(15/36/37), no-pii-in-logs green (2, 3); P1: erasure coverage, fk-order, messaging.service, feature-flags green.

## PR CI (all runs completed 10:31 PDT)
| PR | head | build-and-test | community-live-tests | other checks |
|---|---|---|---|---|
| #708 | 5c9c6a0e | green, 13,187 passed (run 37347344432) | RED, 1 of 112 (same case as #660) | 19 other green (danger, migrations reversible, schema parity, forward migrations, rls-live, mwb-3, CodeQL, audit, ...) |
| #709 | 87f0bfff | green, 13,202 passed (+15) (run 37347352780) | RED, 1 of 112 | 9 other green |
| #710 | 47b528ce | green, 13,223 passed (+21) (run 37347360347) | RED, 1 of 112 | 9 other green |
| #711 | 5a7c41e8 | green, 13,224 passed (+1) (run 37347370315) | RED, 1 of 112 | 9 other green |
The red case on every piece: coach-thread-state-rls.live.spec.ts "pin / reply columns are visible to participants and to no one
else" (D1). rls-floor-guard soft-skips (no DATABASE_URL secret in PR CI), so production CoachMessage RLS state is unknown from CI.
Comments: FIX ROUND 1 (OPENING) + READY FOR AUDIT (with the D1 exception stated) on #708 (issuecomment-5999692986), #709
(-5999694034), #710 (-5999695033), #711 (-5999696107). #660 superseded comment: issuecomment-5999701005 (not closed).
Notify: ops/lanes120/notify/msg.txt (4 lines, 10:32:58 PDT).

## Decisions for the operator
- D1 (pre-existing, outside the diff, T4): no migration in the chain enables RLS on "CoachMessage" (only the loose
  prisma/migrations/rls_fitness_backend.sql does; the policy coach_message_participant_access exists from 20260607000000
  but is inert while RLS is off). On a chain-migrated DB the #660 live spec case "pin / reply columns ... no one else"
  fails (stranger reads the thread). The split carries the spec unchanged, so community-live-tests is expected red on
  that one case on every piece. Options: (a) add ENABLE + FORCE RLS on CoachMessage to 20270303000000 in split 1 (T4,
  both lenses; first a read-only check of production pg_class.relrowsecurity for CoachMessage); (b) separate PR with a
  new migration > 20270316000000; (c) narrow the spec (not recommended: hides the gap). Recommended default: (a), as a
  FIX ROUND on #708 (2 SQL lines + down.sql, merge-only restack of #709-#711), after the operator's read-only production check
  of pg_class.relrowsecurity for "CoachMessage" (expected already on via rls_fitness_backend.sql; the runtime role bypasses RLS,
  so ENABLE + FORCE is a no-op there and closes the gap on fresh databases). Until then community-live-tests stays red and the
  stack cannot land. Also verify production exposure: if relrowsecurity is false in production, CoachMessage rows are readable
  through PostgREST by any authenticated user (T4, fast lane).
- D2: migration timestamp 20270303000000 (A3 reserved) sorts before main's unapplied 20270311000000. Prod has neither
  applied, so deploy order is fine; kept as is (rename = behaviour change). Recommended default: keep.
- D3 (from #660 body): delete erases content immediately (no sealed copy for open reports). Recommended default: keep (a).

## Mobile (main cc4ceeed40a3b4dd509e4b0336581697c8161df1) — which screens use this backend feature, what is missing for day 1
No mobile screen calls any v2 route yet. Current consumers of the legacy 1:1 thread:
- Client thread: src/screens/client/MessagesScreen.tsx (GET/POST /messages, POST /messages/read, realtime 'new-message').
- Coach thread: src/screens/coach/ClientMessagesScreen.tsx (GET/POST /coach/clients/:id/messages, .../read).
- Coach thread list: src/screens/coach/MessagesScreen.tsx (client list + GET /coach/messages/unread-count, sorted client-side);
  src/screens/coach/command-center/InboxScreen.tsx + src/services/commandCenterApi.ts use /coach/command-center/inbox (README: MOCKED).
- API: src/services/api.ts (messagesApi ~l.726-744, coachApi messaging ~l.626-638), src/api/messagesApi.ts (report/block/sendReply).
Missing for day 1 (not built here):
1. Unified inbox: no caller of GET /coach/messages/inbox or GET /messages/inbox (pinned first, unread, cursor, filter=unread);
   coach list and command-center inbox need to switch to it.
2. Reply contract mismatch (live bug today): src/api/messagesApi.ts sendReply posts `parent_message_id` to POST /messages;
   backend main runs ValidationPipe forbidNonWhitelisted, so a client reply is rejected (400) and lands as a pending bubble.
   v2 field is `reply_to_id` (flag ON) and the server returns `reply_to` {id, sender_id, kind, preview}. Coach side
   (ClientMessagesScreen.tsx ~l.169-174) keeps the parent locally only. MessageBubble.tsx must render the server quote.
3. Idempotent send / offline queue: no client_message_id or Idempotency-Key on either send (src/services/api.ts); `pending_*`
   bubbles in client MessagesScreen are never retried with a key.
4. Read-up-to: markRead / markClientThreadRead send no `up_to_message_id`.
5. Realtime: src/services/realtime.ts subscribes only to 'new-message'; needs 'thread-updated' (edit, delete, pin, read receipt).
6. Actions UI: src/components/messaging/MessageActionSheet.tsx offers Reply/Copy/Report only; Edit (48 h), Delete for everyone,
   Pin/Unpin, pins bar, thread Mute (1h/8h/1d/7d/forever/off) and inbox pin are absent; tombstone ("Message deleted") and
   "edited" rendering absent.
7. Flag: src/api/featureFlagsApi.ts SERVER_FEATURE_FLAG_KEYS lacks 'messaging_core_v2'.
8. Error copy: the messaging.* codes (edit_window_closed, delete_window_closed, pin_limit_reached, inbox_pin_limit_reached,
   reply_target_unavailable, idempotency_key_*, blocked, feature_disabled) have no mobile mapping.

## Follow-ups (C)
- C-MSG-1 src/data-export/data-export.service.ts: CoachThreadState (mute/inbox pin) and the new CoachMessage columns
  are not in the data export. Fix rule: export the user's CoachThreadState rows; include edited_at/deleted_at/reply_to_id.

## HANDOFF
- State: done for this job. Stack #708 <- #709 <- #710 <- #711 (drafts), heads in the table above; top tree == M (2ba9ed08).
  Reference branch agent120/msg-split-0-merged-reference @ cd130ae4 (keep until the stack lands; it backs the equality proof).
- Waiting on: operator D1 (CoachMessage RLS), then both lenses on each piece. D2/D3 keep as is unless the operator says otherwise.
- Next owner: on D1 = (a), a builder adds `ALTER TABLE "CoachMessage" ENABLE ROW LEVEL SECURITY; ... FORCE ...` to
  20270303000000 migration.sql (+ down.sql) on #708 as a new commit, then merges each branch into the next (no force-push).
- Cleanup done: worktree wt/B-SPLIT-MSG-120-1 removed, lock ops/lanes120/locks/msg released, no ci/* or audit/* branches created.
- Split tooling kept: ops/split/B-SPLIT-MSG-120/ (plan.json, spec_subset.py, build.sh, bodies/, comment_*.md).
