AUDIT Claude Opus 5.5 — growth-project-backend#643 @ 2234862be7f3058843ff3fd743e62d99436b7b69 — VERDICT: APPROVE

Lens AUD-OPUS-RM1-122, agent 122. T4 delta re-review under RUTHLESS SCOPE: my prior B plus the changed lines. **A0 / B0 / C2.**

### Diff at this head
- `git diff origin/main...2234862b` is one line: `.github/fly-env-desired-state.json:32` `BOOKING_REMINDERS_ENABLED` goes from `"unset"` to `"on"`. The merge of main `eb2e9e03` kept main's `FEATURE_MESSAGING_CORE_V2` line.
- `"on"` is the only enabling value. `src/scheduling/jobs/reminder.job.ts:240` (1h sweep) and `:268` (24h sweep) read `=== 'on'`. `SessionReminderJob` is registered in `scheduling.module.ts:62`, and `ScheduleModule.forRoot()` is in `app.module.ts:166`.
- Main has moved 10 commits since (now `e905f3ce`: roman-adjust and scheduling booking options). None of them touch `src/notifications`, `src/notifications/push` or `src/scheduling/jobs`. GitHub reports the PR as CLEAN.

### Prior B (Opus B-643-1, 5960179586): closed on main
- **Time shown in UTC: fixed.** `src/notifications/emitters/booking.emitter.ts:482-505` builds the reminder text with `formatWhen`/`formatTime` (`:667-687`, `Intl.DateTimeFormat` in the recipient's zone, for example "9:00 AM PDT"). The zone comes from `recipient-timezone.ts`: the device zone first, then the coach's zone. If no zone is known, the copy has no clock time. The lock-screen line is also local (`push/lock-screen-copy.ts:158-168`: "Your session is tomorrow at 9:00 AM."). Pinned by `test/booking-reminder-local-time.spec.ts:162` ("never UTC").
- **Reminder shown twice in the inbox: fixed.** `deliver()` writes one `channel: 'inapp'` row (`booking.emitter.ts:562-578`), then calls `NotificationsService.sendPush` (`:603`). `sendPush` writes no inbox row (`notifications.service.ts:551-552`). `listNotifications` and the unread count also filter `INBOX_HIDES_PUSH_TWINS` (`:626`, `:656`).
- **My old C-643-2 (inbox only, no lock screen): fixed.** `sendPush` sends through the push outbox. The tap data is `actionScreen: 'CalendarSession'` for the client and `'CoachBookingInbox'` for the coach, with `actionParams.sessionId` (`notifications.service.ts:1074-1097`). Mobile main `pushTapRouter.ts:75-77` routes `CalendarSession` to `CalendarTab/CalendarSession`, and `EXPO_PUBLIC_FF_CLIENT_CALENDAR` is true in the store profiles. So the owner's story works: the client gets one push showing her local time, and tapping it opens the session.
- **Mute and switches are respected.** `pushAllowed` and `gateFrom` stop a muted user and a `booking_push`/`booking_inapp` that is off (`booking.emitter.ts:634-637`, `notifications.service.ts:477-487`).

### C (one line each, no fix now)
- C-643-3 (edge, deferred to 10k clients): until m#341 ships, a client's zone falls back to the coach's zone. The zone is named in the copy, so the time is still correct.
- C-643-4 (edge, deferred to 10k clients): quiet hours (21:00-08:00) can hold a 24h reminder until 08:00, and a recipient with no known zone gets copy with no clock time. Both are the builder's proposed Cs; I agree.

### CI at this exact head
All checks are SUCCESS: build-and-test, rls-floor-guard, rls-live-tests, mwb-3-live-tests, community-live-tests, npm audit, CodeQL, Banned cast tokens, build-sbom, danger, Schema parity, size-label, test-deploy-readiness. deploy-readiness-gate is SKIPPED as usual. Builder lane [run 37394709160](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37394709160) passed 7 suites, 216/216. No new probe from this lens: the diff is one manifest value, and every behaviour above is code already on main that main's CI covers.

No push, merge, dispatch or production action by this auditor.
