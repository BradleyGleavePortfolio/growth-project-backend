AUDIT Claude Opus 5.5 (LB-OPUS-126) — growth-project-backend#814 @ b6e40ad884f0403628955b3b5ae8ef6e48f954d7 — VERDICT: APPROVE

A=0 B=0 C=2. CI: green at this head (15 SUCCESS, 1 SKIPPED); mergeable clean. Size 111 lines (105+/6-). This is a re-grade at fix round 2. e27aa237..b6e40ad8 is one commit that changes only `src/notifications/push/push-preferences.ts` (+7).

**B-814-1 (other Opus lens, at e27aa237): fixed**
- `notificationPrefsPrefix` now maps `workout_assigned*` to `workout_reminder`.
- `workout_reminder_push` and `workout_reminder_inapp` are `Boolean @default(true)` (schema.prisma:1135-1136). For a client with default preferences, `pushAllowedByPreferences` (`prefs.workout_reminder_push !== false`) therefore passes, and so does the inbox `gateFrom` in `createNotification`.
- Before this commit the kind fell through to `digest` (defaults false), so both the push and the inbox row were dropped.
- The same single mapping is used by:
  - `pushAllowedByPreferences`, which the push worker re-checks before sending;
  - `NotificationsService._kindToPrefsPrefix`;
  - `androidChannelFor`, which still returns CLIENT_BOT for WORKOUT_ASSIGNED via its explicit kind list;
  - the `pushTapData` prefix check. Its `message` and `booking` branches are unaffected, and the `workout` branch keys on the kind itself.
- A client who switched workout reminders off also gets no assignment push or inbox row. That is the client's own setting and the safe direction.

**Unchanged since my e27aa237 read**
- The push goes only to the assignment's own client, once per action.
- The lock-screen copy is "New workout" / "Your coach added a workout for you.", with no names.
- A tap opens `WorkoutMain`, which every mobile build routes (`pushTapRouter.ts:74`).
- `sendPush` writes no second inbox row, and the push is fire-and-forget after the inbox write.

**C (never block)**
- C-814-1: when `createNotification`'s 60 s per-kind throttle drops the inbox row, the chained `sendPush` still queues a device push. Two assigns to the same client within a minute therefore give two pushes but one inbox row. C (edge, deferred to 10k clients).
- C-814-2: the FIX ROUND 2 comment says a real-gate spec was added (3/5 fail at e27aa237), but e27aa237..b6e40ad8 changes no test file. `test/fu-worklog-126-assignment-push.spec.ts` is the same 74 lines as at e27aa237, so nothing in this PR pins the preference mapping. The comment's full sha (b6e40ad8ba0b…) also does not match this head (b6e40ad884f0…). Recommended: add the spec in a follow-up.
