FIX ROUND 1 (B-643-122 / B-341-122, agent 122) — growth-project-backend#643 @ 2234862be7f3058843ff3fd743e62d99436b7b69

**Not superseded.** Main (eb2e9e038a4cc6e2b8b20fb0d37d251a91162350) still declares `"BOOKING_REMINDERS_ENABLED": "unset"`, so this flip is still the launch switch. The diff against main is still exactly one line in `.github/fly-env-desired-state.json`: `"unset"` to `"on"`.

**This push:** one merge of origin/main (eb2e9e03) into f21b3c63. One conflict in the manifest, where main had added `FEATURE_MESSAGING_CORE_V2` next to this line. I kept main's line and the `on` value. No code, test, workflow or gates-text change. Size: 1 file, +1/-1.

### Prior Bs (Sol 5960175016, Opus 5960179586): all closed by code already on main
| Finding | Ordinary-use story | Closed on main by |
|---|---|---|
| Opus B-643-1 (time in UTC) | A client reads "00:30 UTC" for a 5:30 pm session and misses it | #647 (merged 10-03). The reminder copy uses the recipient's zone through `src/notifications/recipient-timezone.ts`: first the zone the device supplied (PUT /notifications/timezone), then the coach's published zone. The zone is named in the text. If no zone is known, the copy gives no clock time. It never shows UTC. |
| Opus B-643-1 / Sol B-643-2 (two inbox rows, unread +2) | Each reminder shows twice and the badge counts 2 | `BookingEmitter.deliver()` writes one `inapp` row per event. No `push` row is stored. |
| Sol B-643-1 (no device push) | Reminders never reach the lock screen | `BookingEmitter.deliver()` sends through `NotificationsService.sendPush`, which uses the push outbox, a once-only dedupe key per (kind, session, time), the preference gate and the fixed lock-screen copy. The 1h reminder skips quiet hours, so an early-morning session still gets its reminder on time (`push/push-quiet-hours.ts`). |

Job checks with an ordinary-use story, read on the merged tree:
- **Reminder for a cancelled booking:** the sweep only picks `scheduled` and `pending_provider` sessions. Before sending, it reads the session again with the row locked (`src/scheduling/jobs/reminder.job.ts`). A cancelled or moved session gets no reminder for its old time.
- **Tap target:** the in-app payload carries `actionScreen` (client `CalendarSession`, coach `CoachBookingInbox`) and `actionParams { sessionId }`, and the push carries the session deep link. The mobile half is m#341.
- **Gate:** the reminder job reads `process.env.BOOKING_REMINDERS_ENABLED === 'on'` (`reminder.job.ts:240,268`). ENV_RULES has `values ['on','off']` and `unsetIs 'off'`. The kill switch is still unset.

Bs fixed in this round: none were needed in this PR, because all prior Bs are closed by main.

### Evidence at 2234862b
- `node scripts/fly-env/fly-env-manifest.js validate ...`: `Desired state OK: 31 flags (3 declared with a value), 27 secrets, 14 excluded; manifest sha256 ed3d68cd91506231c9c696d9cca6f94409370c5b198600fb5f1d850b0efee3cc`.
- CI lane [run 37394709160](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37394709160): 7 suites, 216/216 passed (fly-env-manifest, fly-env-sync-behavior, fly-env-workflows, env-registration, booking-reminder.job, booking-reminder-local-time, scheduling-reminder-delivery).
- PR CI at this head: every check is green (build-and-test, rls-floor-guard, rls-live-tests, mwb-3-live-tests, community-live-tests, npm audit, CodeQL, Banned cast tokens, build-sbom, danger, Schema parity, size-label).

### Proposed C (edge, deferred to 10k clients)
- C (edge, deferred to 10k clients): the 24h reminder is held by quiet hours (21:00-08:00) for sessions later than 10:00 local the next day.
- C (edge, deferred to 10k clients): if no zone is known for a recipient (no device zone and no coach zone), the copy has no clock time.

### Apply sequence (unchanged; operator only)
Merge, then `Fly Env Sync (operator)` with mode=plan (expect `BOOKING_REMINDERS_ENABLED | flag | on ... set`), then apply with `deploy_staged=true`, then run plan again and expect `match | keep`. Kill: change the manifest back to `"unset"`.

No merge, dispatch or production action by the builder.

READY FOR AUDIT
