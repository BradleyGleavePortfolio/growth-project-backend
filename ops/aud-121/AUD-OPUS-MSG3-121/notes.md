# AUD-OPUS-MSG3-121 notes (Claude Opus 5.5 lens, agent 121) — b#708-#711 first full review

Start 13:49 PDT 10-05. Worktree /home/user/workspace/wt/AUD-OPUS-MSG3-121-1 (detached db7fa3bf).
Heads verified 13:51 and again before posting:
- #708 07d16d821ea801f14f7426ffe9916316c721e707 (554, base main)
- #709 d9cf7ad9bcb941dd5294917404272f7c91cee717 (1,141, base #708)
- #710 3572b2092c0afa98de35606a491e518d26175760 (1,092, base #709)
- #711 db7fa3bf86720acfa9eb63528c5ae792de07bf67 (388, base #710)
No prior Opus verdict on #660 or on any piece: no evidence reuse; every line read.

## What was read
- #708: migration.sql + down.sql (D1 DO block on pg_policy, ownership COMMENT marker, ENABLE+FORCE after), schema.prisma,
  erasure manifest entries, ci.yml (one spec added to community-live-tests), live RLS spec (SET LOCAL ROLE authenticated).
- #709: messaging.service.ts (resolveThread*, insertThreadMessage idempotency + P2002 replay, reply validation, mute-aware push,
  read-up-to, tombstone-aware unread), messaging-core.feature.ts, messaging-errors.ts (copy), messaging-realtime.ts (ID-only),
  feature flag wiring, env rule, fly desired state, launch-flags.md.
- #710: message-actions.service.ts (edit/delete/pin/unpin/listPins/mute/inbox pin), messaging-inbox.service.ts, module.
- #711: both controllers (guards: class Jwt+Roles/Coach first, then MessagingCoreV2Guard), DTOs, idempotency header fold, README.
- Cross-checked: assertClientOfCoach (sub-coach returns head coach id), SubCoachScopeService (global module), voice erasure cron
  (unguarded @Cron every 10 min, same bucket as DM voice), RlsContextInterceptor (GUC only, no role switch), data export
  (_streamCoachMessages findMany without select -> new columns already exported for own messages), MessageReport model.

## Findings (all C; no A, no B under the owner edge-case freeze)
- C-708-1 (outside this diff; refines builder C-MSG-1): data export omits CoachThreadState rows (mute/inbox-pin preferences).
  The new CoachMessage columns are already exported for the user's own messages (data-export.service.ts:1357 findMany, no select).
  Fix rule: add the caller's CoachThreadState rows (user_id = caller) to the export.
- C-709-1: messaging-errors.ts:54 BLOCKED copy "Unblock in Settings to continue." is false for the party who was blocked
  (isEitherSideBlocked: the other side blocked them; nothing to unblock). Same text on mobile m#377 src/api/messagingV2Api.ts:158
  (report to operator; belongs to m#377). Fix rule: neutral copy, e.g. "This conversation is blocked, so messages cannot be sent,
  edited or pinned." or split into blocked_by_me / blocked_by_them codes.
- C-709-2 (edge, deferred to 10k clients): messaging-idempotency.ts:24 header key is lower-cased, body key stored verbatim; a send
  whose body key is upper-case and whose retry uses only the header inserts a duplicate. Fix rule: lower-case the body key too.
- C-709-3 (rollout): once FEATURE_MESSAGING_CORE_V2 is on, app builds without m#371/#377 render a tombstone as an empty bubble
  (mobile main src/components/messaging/MessageBubble.tsx:109) and edits with no "edited" mark. No data exposure.
  Fix rule / default: flip the flag only after the store build that carries m#371/#377 is live (A6 device pass already gates it).
- C-709-4: send responses (sendAsCoach/sendAsClient, messaging.service.ts) return the raw row; with the flag on, thread reads return
  reply_to preview + deleted. A just-sent reply has no reply_to object until the next read. Fix rule: serialize the send result
  with serializeMessage when v2 is on (or mobile renders the quote from its local target).
- C-710-1: message-actions.service.ts:389 inbox-pin cap counts every pinned CoachThreadState row of the caller, including threads
  no longer in scope (client left the coach, sub-coach unassigned). That slot cannot be freed (thread routes 404) and the inbox
  shows fewer than 5 pins while answering inbox_pin_limit_reached. Fix rule: count only rows whose client_id is in the caller's
  current scope, or clear CoachThreadState.pinned_at when the relationship / assignment ends.
- C-710-2 (edge, deferred to 10k clients): messaging-inbox.service.ts:273/283 client inbox hides the preview only when the client
  blocked the head coach; a last message from a sub-coach the client blocked still shows as preview (thread read filters it).
  Fix rule: skip rows whose sender_id is in blockedList when choosing the preview.
- C-710-3 (edge, deferred to 10k clients): message-actions.service.ts:80 edit/pin block check uses (head coach, client); send uses
  (actor, client). A sub-coach the client blocked can still edit/pin. Fix rule: also check isEitherSideBlocked(actorId, clientId).
- C-710-4 (operator decision): edit/delete inside 48 h changes or erases a message under a pending MessageReport
  (prisma/schema.prisma:1376 MessageReport has no content snapshot), so moderation reviews the edited or empty text.
  D3 (delete erases immediately) stands. Default: snapshot body (and reason context) into MessageReport at report time in a
  follow-up PR; keep D3 for the thread view.

## Probes
No CI lane pushed: every finding is a C proven by reading exact lines; GitHub runner incident has required checks on these heads
queued since 12:42-12:44 PDT; adding a lane would only delay them. No local jest run.

## CI at heads (14:0x PDT)
- #708: green CodeQL, Schema parity, mwb-3-live-tests, actionlint, shellcheck, size-label; queued build-and-test,
  community-live-tests, rls-floor-guard, Banned cast tokens, build-sbom, danger; cancelled by runner incident rls-live-tests
  (run 37365158771), npm audit (37365158854), test-deploy-readiness; non-required danger dry-run failed (19:49Z).
- #709-#711: required build-and-test, community-live-tests, rls-live-tests, rls-floor-guard, mwb-3-live-tests, Schema parity /
  npm audit queued or cancelled-and-rerun-queued.
