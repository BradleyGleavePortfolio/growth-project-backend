# AUD-SOL-RM1-122 — booking reminders delta audit (agent 122)

Independent GPT-6.1 Sol lens; started 2026-10-05 17:47 PDT, completed 17:51 PDT, within the 25-minute box. Scope is the assigned backend #643 and mobile #341 fix round, prior Sol findings and changed lines only. No Opus lens notes, reports or comments read. Repositories remain read-only; no push, merge, local test/build, new workflow dispatch or production action.

## Heads and scope

- Backend #643: `2234862be7f3058843ff3fd743e62d99436b7b69`, manifest-only +1/-1 against `eb2e9e038a4cc6e2b8b20fb0d37d251a91162350`. [Backend fix round](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/643#issuecomment-6006805839)
- Mobile #341: `ba886adccff3ea35cfafa2cfce8182fe4676572f`, 9 files, +602/-241 (843 changed lines) against `a9bd9470f5d5b9c2ec955156d8886679594379ba`. [Mobile fix round](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/341#issuecomment-6006810677)

## Verdicts

AUDIT GPT-6.1 Sol — growth-project-backend#643 @ 2234862be7f3058843ff3fd743e62d99436b7b69 — VERDICT: APPROVE

A/B/C = **0/0/2**; both prior Sol Bs are closed by the main code now contained in the candidate. [Posted backend verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/643#issuecomment-6006903653)

AUDIT GPT-6.1 Sol — growth-project-mobile#341 @ ba886adccff3ea35cfafa2cfce8182fe4676572f — VERDICT: APPROVE

A/B/C = **0/0/2**; both prior Sol Bs are closed for launch scope, and the two prior Sol Cs are closed by copy correction and focus-code removal. [Posted mobile verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/341#issuecomment-6006901494)

Both heads were fetched and verified immediately before posting their respective verdicts. Exact-head PR checks are successful; backend's deploy-readiness gate alone is skipped, so no production/device-readiness claim is made. [Backend checks evidence](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/643#issuecomment-6006903653) [Mobile checks evidence](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/341#issuecomment-6006901494)

## Closure evidence

- Backend B-643-1 (no device delivery): `booking.emitter.ts:603-617` now calls `sendPush`; `notifications.service.ts:565-610` enqueues through the provided push delivery service; `push-delivery.service.ts:293-316,589` drains to the Expo client. Ordinary both-participant/tap-data regressions are at `test/scheduling-reminder-delivery.spec.ts:151-172`. [Audited emitter](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/2234862be7f3058843ff3fd743e62d99436b7b69/src/notifications/emitters/booking.emitter.ts) [Delivery regressions](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/2234862be7f3058843ff3fd743e62d99436b7b69/test/scheduling-reminder-delivery.spec.ts)
- Backend B-643-2 (duplicate inbox/unread): `booking.emitter.ts:562-577` writes one in-app row and `sendPush` writes no inbox row; one visible item/unread per participant is covered at `test/booking-reminder-local-time.spec.ts:219-240`. [Emitter](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/2234862be7f3058843ff3fd743e62d99436b7b69/src/notifications/emitters/booking.emitter.ts) [Inbox/unread regression](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/2234862be7f3058843ff3fd743e62d99436b7b69/test/booking-reminder-local-time.spec.ts)
- Backend prior local-copy C: the reminder uses recipient-zone formatting rather than hard-coded UTC; no new timezone-edge analysis or probe was performed. [Emitter](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/2234862be7f3058843ff3fd743e62d99436b7b69/src/notifications/emitters/booking.emitter.ts)
- Mobile B-341-1: synchronous `savingRef` admission at `NotificationPreferencesScreen.tsx:222-247`, disabled switches at `:311,:371`, and held-reply/next-normal-save regression at `notificationCenter.test.tsx:450-486`. [Screen](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/ba886adccff3ea35cfafa2cfce8182fe4676572f/src%2Fscreens%2Fnotifications%2FNotificationPreferencesScreen.tsx) [Regression](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/ba886adccff3ea35cfafa2cfce8182fe4676572f/src%2F__tests__%2FnotificationCenter.test.tsx)
- Mobile B-341-2: the existing status classifier is used at `:234`, offline/server outcomes refetch at `:238-240`, and mounted-screen offline/401/500 regressions at `notificationCenter.test.tsx:391-447` prove sign-in recovery, reference/support/reporting and authoritative-row reconciliation; remaining ambiguous-response wording is explicitly deferred below. [Screen](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/ba886adccff3ea35cfafa2cfce8182fe4676572f/src%2Fscreens%2Fnotifications%2FNotificationPreferencesScreen.tsx) [Error regressions](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/ba886adccff3ea35cfafa2cfce8182fe4676572f/src%2F__tests__%2FnotificationCenter.test.tsx)
- Mobile C-341-3: mute copy includes email and session reminders, and all channel switches disable while muted; verified against backend's global mute gate and mounted-screen regression. [Screen](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/ba886adccff3ea35cfafa2cfce8182fe4676572f/src%2Fscreens%2Fnotifications%2FNotificationPreferencesScreen.tsx) [Mute regression](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/ba886adccff3ea35cfafa2cfce8182fe4676572f/src%2F__tests__%2FnotificationCenter.test.tsx)
- Mobile C-341-4: `git diff main..head` is empty for the push router and restored upcoming-session screen/tests, so main's dedicated session destination is preserved and the bounded-list cancellation claim is removed. [Restoration evidence](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/341#issuecomment-6006810677)
- Mobile contract delta: preference patches contain only mapped flat columns; device zone uses `PUT /notifications/timezone` with `source: 'device'`, normal account/zone caching and unchanged sign-in/foreground wiring. [Mapping](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/ba886adccff3ea35cfafa2cfce8182fe4676572f/src%2Fservices%2FnotificationsApi.ts) [PUT body](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/ba886adccff3ea35cfafa2cfce8182fe4676572f/src%2Fservices%2Fapi.ts) [Sync](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/ba886adccff3ea35cfafa2cfce8182fe4676572f/src%2Fservices%2FtimezoneSync.ts)

## CI evidence reuse

- Backend targeted lane is successful at `f218ae1040e2b557e7b661ce2d82d7120c0dde35`; a direct tree diff shows only `.ci-lane-specs` and `.github/workflows/ci-lane.yml` added, no application/manifest/test differences from the audited head. [Backend lane job](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37394709160/job/112047808168)
- Mobile targeted lane is successful at `8f162f956e29ad7393cc2e282bca9cf5c1f95832`; a direct diff of every changed executable/test file against the audited head is empty. [Mobile lane job](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37395129968/job/112049177867)
- Exact-head backend build/test succeeded; no new local or lane execution was needed. [Backend build/test](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37394702808/job/112047786572)
- Exact-head mobile typecheck/lint/test and both analysis checks succeeded. [Mobile typecheck/lint/test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37395169771/job/112049307058) [JS/TS analysis](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37395169642/job/112049307170) [Workflow analysis](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37395169642/job/112049306652)

## C only

- C-643-2 — C (edge, deferred to 10k clients): quiet-hours deferral of some 24h reminders. [Deferred list](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/643#issuecomment-6006805839)
- C-643-3 — C (edge, deferred to 10k clients): no clock time when the recipient has no usable zone. [Reminder copy](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/2234862be7f3058843ff3fd743e62d99436b7b69/src/notifications/emitters/booking.emitter.ts)
- C-341-5 — failed initial preferences GET renders no settings content at `:209,:279`; optional retry/error presentation, not a blocked core flow. [Load path](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/ba886adccff3ea35cfafa2cfce8182fe4676572f/src%2Fscreens%2Fnotifications%2FNotificationPreferencesScreen.tsx)
- C-341-6 — C (edge, deferred to 10k clients): save completion after navigation/account change and absolute failure wording after an ambiguous response. [Save path](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/ba886adccff3ea35cfafa2cfce8182fe4676572f/src%2Fscreens%2Fnotifications%2FNotificationPreferencesScreen.tsx)

## Saved records

Comment payloads are saved at:

- `/home/user/workspace/ops/aud-122/AUD-SOL-RM1-122/backend-643-verdict.md`
- `/home/user/workspace/ops/aud-122/AUD-SOL-RM1-122/mobile-341-verdict.md`

No worktree, branch or lock created. Head-scoped Sol claim files are retained as completed audit receipts. No workspace files were deleted.

## HANDOFF

- Backend #643 at `2234862be7f3058843ff3fd743e62d99436b7b69`: Sol APPROVE, A/B/C 0/0/2, comment posted; no builder fix requested. [Backend verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/643#issuecomment-6006903653)
- Mobile #341 at `ba886adccff3ea35cfafa2cfce8182fe4676572f`: Sol APPROVE, A/B/C 0/0/2, comment posted; no builder fix requested. [Mobile verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/341#issuecomment-6006901494)
- Operator next step: independently obtain the other lens's exact-head verdicts, verify heads/checks, then follow operator-only merge/apply/deploy and native-device acceptance. This audit does not assert that the flag is applied, code is deployed or device receipt has occurred.
