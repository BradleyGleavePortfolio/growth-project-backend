AUDIT Claude Opus 5.5 — growth-project-mobile#341 @ ba886adccff3ea35cfafa2cfce8182fe4676572f — VERDICT: APPROVE

Lens AUD-OPUS-RM1-122, agent 122. Delta re-review under RUTHLESS SCOPE: my prior B plus the changed lines (9 files, +602/-241 = 843, under 1,500). **A0 / B0 / C2.**

### Prior B (Opus B-341-1, 5972160274): fixed
- **One save at a time.** `src/screens/notifications/NotificationPreferencesScreen.tsx:201` sets `savingRef` synchronously (`:222-223`), so a second tap during a save is ignored. While a save is in flight, the Mute all switch (`:311`) and every channel switch (`:371`) are disabled.
- **Rollback is safe now.** With one save at a time, the `previous` snapshot is the only other state there is. A reply or a rollback can no longer overwrite a later change.
- **Test:** `src/__tests__/notificationCenter.test.tsx:450` holds the reply and checks that the second switch waits.

### Job checks
- **B-341-2 (a failed save says what went wrong): fixed.** Screen `:234` uses main's `preferenceSaveFailureOf`, which gives a specific message for offline, signed out, busy, and server failure (with a reference and the support address). The copy has no first person and no exclamation marks. On offline or server failure the screen reloads the server row (`:238`). Tests: `notificationCenter.test.tsx:391`, `:410`, `:427`.
- **Mute all copy is true.** Screen `:186` reads "Turns off all push, in-app and email notifications, session reminders included." The backend `gateFrom` returns `muted` before any per-channel check (`notifications.service.ts:477-487`). The push gate and the nudge engine (`nudge-engine.service.ts:131`, `:303`) also stop on `muted`. While muted, the channel switches are disabled. Test: `notificationCenter.test.tsx:489`.
- **Device zone is sent once on sign-in and when it changes.** `App.tsx:151` sends it on every auth change, and `installTimezoneResyncOnForeground` (`App.tsx:176`) sends it on foreground. `syncDeviceTimezone` skips the send when the cached `<account>|<zone>` stamp matches (`timezoneSync.ts:86`), so it goes out once per account and zone. It uses `PUT /notifications/timezone { timezone, source: 'device' }` (`api.ts:925`), which matches backend `UpdateTimeZoneDto` (`timezone` string, `source` in `['device','settings']`). It falls back to the preferences PATCH only on 404/405 (`timezoneSync.ts:63`).
- **Preferences mapping matches the backend.** GET and PATCH return the flat `NotificationPreferences` row. The mapped keys (`muted`, and `message_`, `milestone_`, `missed_checkin_` and `build_week_` each with `push`/`inapp`/`email`) all exist in `UpdateNotificationPreferencesDto`, so no save is rejected for an unknown key (`notificationsApi.ts:114-161`). Quiet hours are never sent.
- **Booking tap.** This PR now leaves `pushTapRouter.ts` byte-identical to main. Main #365 routes `CalendarSession` to `CalendarTab/CalendarSession`, which matches the backend payload (`actionScreen` + `actionParams.sessionId`).
- **Quiet hours copy is true.** It reads "9:00 PM to 8:00 AM ... a reminder for a session that starts within the hour still comes through". That matches backend `push-quiet-hours.ts`: the window is 21:00-08:00, and the 1h reminder is always urgent.

### C (one line each, no fix now)
- C-341-2 (carried, edge, deferred to 10k clients): if `GET /notifications/preferences` fails, the screen is blank (`:209`, `:279`). This only happens with no network. A normal load works.
- C-341-5: the PR title still says "booking tap opens the session", which is now main #365's work. This is not customer-facing; the operator can retitle.

### CI at this exact head
Typecheck, lint, test: SUCCESS. Analyze (actions): SUCCESS. Analyze (javascript-typescript): SUCCESS. CodeQL: SUCCESS. Builder lane run 37395129968 (tsc plus 5 specs) passed. No new probe from this lens: the B fix and its tests are covered by the PR's own CI run at this head.

No push, merge, dispatch or production action by this auditor.
