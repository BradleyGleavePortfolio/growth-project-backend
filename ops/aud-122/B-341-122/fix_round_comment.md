FIX ROUND 1 (B-643-122 / B-341-122, agent 122) — growth-project-mobile#341 @ ba886adccff3ea35cfafa2cfce8182fe4676572f

Old head 7c791bb39979eb16481ce71a85de652b41368a3a (Sol RC 5972146496, Opus RC 5972160274). #312 merged 10-05; this PR is now on main. Size vs main: 9 files, +602/-241 = 843 lines.

Commits: 2053796 merge origin/main 300f898f (one conflict, below) · c41fb1f fix · ba886ad merge origin/main a9bd947c (clean).

**Superseded by main (removed from this PR).** Booking tap: main #365 routes client `CalendarSession` to the Calendar tab session view (`CalendarTab/CalendarSession`, loads that one session by id; `clientCalendar` is on in the production and clinic profiles) and coach `CoachBookingInbox` to the booking inbox. The pushTapRouter conflict takes main's version; this PR's upcoming-sessions focus is removed (ClientUpcomingSessionsScreen.tsx, ClientUpcomingSessionsFocus.test.tsx, its ClientUpcomingSessionsScreen cases and the old pushTapRouter block are byte-identical to main). That also closes Sol C-341-4. The PR title's "booking tap opens the session" part is now main's.

**Still needed (not on main).** `PUT /notifications/timezone { timezone, source: 'device' }` on sign-in and foreground (backend main has the route, notifications.controller.ts:122; B-643-122 confirmed the contract), the flat preferences mapping (the live screen sent a nested body the backend rejected with 400), the fixed quiet hours row.

| Finding | Fix (c41fb1f) | Test (notificationCenter.test.tsx) |
| --- | --- | --- |
| B-341-1 (Sol, Opus) | One save at a time: a ref set synchronously ignores a second tap during a save, and the switches are disabled while it is in flight, so no reply or rollback can overwrite a later change. Rollback is then exactly the one change. | "one save at a time: a second switch waits, and the first reply never turns it back" (held reply; one PATCH; next change saves normally) |
| B-341-2 (Sol) | Failure copy by status through main's `preferenceSaveFailureOf` (B-312-1 rules): offline, signed out, busy, or server with a short reference, the support address and a Sentry report. With no answer or an unexpected one the screen reloads the server row. | "a save with no answer ...", "a signed-out save says to sign in again ...", "a server failure gives a reference and the support address, reports it, and shows the server row" |
| C-341-3 (Sol) promoted: false claim once saves work | Mute all now reads "Turns off all push, in-app and email notifications, session reminders included." (backend `muted` blocks every channel: notifications.service.ts gateFrom, push-preferences.ts). Email switches also wait while muted. README updated. | "mute all says email stops too, and the channel switches wait while it is on" |

Normal-user story for each: B-341-1, a client turns off two switches in a row and one can show the opposite of what was stored; B-341-2, a signed-out or server failure told the client to check a connection that was fine; mute copy, a client mutes expecting emails to continue and gets none.

Failing before / passing after (local heavy.sh, one file): old screen 5 failed / 16 passed; fixed screen 21/21. CI lane [run 37395129968](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37395129968): tsc + notificationCenter, timezoneSync, notificationPreferencesMapping, pushTapRouter, ClientUpcomingSessionsScreen specs, success.

PR checks at ba886ad: Typecheck, lint, test [success](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37395169771/job/112049307058); Analyze (javascript-typescript), Analyze (actions) [success](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37395169642); CodeQL success.

Cs proposed (not fixed): C-341-2 (Opus) load failure on GET /notifications/preferences shows a blank screen (OS back works), small follow-up; C (edge, deferred to 10k clients) save completing after unmount or account switch.

Copy check: no first person, no exclamation marks, no emoji, no generic error.

READY FOR AUDIT
