# AUD-OPUS-RM1-122 — booking reminders on at launch, Opus lens (agent 122)

Started 17:47 PDT 2026-10-05. Finished 17:54 PDT. Lens: Claude Opus 5.5. I did not read the Sol lens's work for this round.
Claims: ops/lanes122/claims/backend-643-2234862b-opus and mobile-341-ba886adc-opus. Notes and comment drafts: ops/aud-122/AUD-OPUS-RM1-122/.
No worktrees and no lane branches were created. Everything was read with `git show <sha>:path` on the main clones after a fetch (their checkouts were not changed).

## Verdicts (posted at exact heads, verified right before posting)
- **growth-project-backend#643 @ 2234862be7f3058843ff3fd743e62d99436b7b69 — APPROVE, A0 / B0 / C2**
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/643#issuecomment-6006940614
  - The diff is one line: the manifest flag BOOKING_REMINDERS_ENABLED goes from "unset" to "on".
  - Old Opus B-643-1 is closed on main.
    - The time is local, not UTC: booking.emitter.ts formatWhen/formatTime (:667/:680), plus lock-screen-copy.ts:158-168. Pinned by test/booking-reminder-local-time.spec.ts:162.
    - One inbox row per reminder: deliver() writes only the inapp row (:562-578), sendPush writes no inbox row, and the inbox filters INBOX_HIDES_PUSH_TWINS.
  - Old C-643-2 (no device push) is closed: the reminder goes through sendPush, with tap data CalendarSession + sessionId. Mobile main pushTapRouter routes it to CalendarTab/CalendarSession.
  - Main has moved 10 commits since this head (e905f3ce). None of them touch notifications, push or scheduling/jobs. GitHub reports the PR as CLEAN.
  - CI: all checks green.
  - Cs:
    - C-643-3: the coach's zone is the fallback until m#341 ships (edge).
    - C-643-4: quiet hours can hold a 24h reminder; with no zone, the copy has no clock time (edge).
- **growth-project-mobile#341 @ ba886adccff3ea35cfafa2cfce8182fe4676572f — APPROVE, A0 / B0 / C2**
  https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/341#issuecomment-6006940817
  - B-341-1 is fixed: savingRef plus the switches are disabled while a save runs.
  - B-341-2 is fixed: the failure copy depends on the status (preferenceSaveFailureOf), and the screen reloads the server row on offline or server failure.
  - The Mute all copy is true: backend gateFrom, the push gate and the nudge engine all stop on muted, email included.
  - The device zone is sent once per account and zone: on sign-in or auth change and on foreground, using the cached stamp. The PUT /notifications/timezone contract matches UpdateTimeZoneDto.
  - The preference keys match the backend DTO. The booking tap is byte-identical to main #365.
  - CI: all checks green.
  - Cs:
    - C-341-2: blank screen when the preferences load fails (only with no network).
    - C-341-5: the PR title still names the booking tap; the operator can retitle.

## Bs
None. No finding met the normal-user bar.

## Probes
None. #643 is a one-value manifest flip over code already on main, which main's CI and the builder lane 37394709160 (216/216) cover. m#341's B fixes are tested in its own CI at this head.

## HANDOFF
- Done. Both Opus verdicts are posted at the exact heads above. Nothing is left for this lens.
- Next for the operator:
  1. Compare with Sol's verdicts.
  2. If both lenses approve, merge b#643 and m#341 with --match-head-commit.
  3. Run Fly Env Sync plan/apply for BOOKING_REMINDERS_ENABLED (operator only).
- Recommended order: merge m#341 alongside b#643 (or first), so clients' zones come from their devices from day 1.
- Cleanup: no worktrees or branches were created. The claim files stay as a record.
