AUDIT Claude Opus 5.5 — growth-project-mobile#337 @ 63be101394d996bd4475a8ad86c400925997092c — VERDICT: REQUEST CHANGES

AUD-OPUS-RADJ-121, agent 121. First full review, T4 (coach UI that changes client workouts; companion of growth-project-backend#655,
verdict there: REQUEST CHANGES). Grandfathered PR (opened 2026-10-03 00:23 UTC): 1,052 / 3,000 lines. Independent of the Sol lens.

A/B/C = 0/2/5

What was checked and holds (no finding):
- The card shows only Roman's sentence, signal chips, the set change and exercise names: no memory, playbook, prompts, reasoning or
  client chat text. 404 from GET /coach/adjustments (flag off) hides the section; nothing renders while the backend flag is off.
- The 5 s local countdown with Undo before sending, the server undo while undo_until is open, and coded refusals
  (ALREADY_DECIDED, NOT_FOUND, WORKOUT_STARTED/CHANGED, CONSENT_WITHDRAWN) shown with the server sentence and a list refresh.
- App-chrome copy: no first person, no exclamation marks, no emojis, no "something went wrong"; errors name what failed and what to
  do (probe control). Roman's own sentence uses "I" (persona voice; operator decision on #655).
- No client data is cached or logged: captureError gets the error and action only.

B-337-1 — CI is red: the PR commits a `node_modules` symlink (git mode 120000 -> /home/user/workspace/deps/mobile/node_modules, a
sandbox path). In CI, after `npm ci` it is a directory and `npm run guard:vendors` dies with EISDIR, so lint, tsc and jest never ran:
https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37081842688 (job 111083846786). .gitignore line 4
`node_modules/` matches directories only, so a symlink is not ignored.
Fix rule: `git rm --cached node_modules`; change .gitignore to `node_modules` (no trailing slash) so a linked deps folder cannot be
committed again. Verify: "Typecheck, lint, test" green in PR CI. LANE_TSC

B-337-2 — copy truth: after Approve/Edit/Undo, three failure shapes claim "Your workouts are unchanged" when the change may have been
applied, or certainly was (romanAdjustCopy.ts:88-101 and 112-118, refresh: false):
- a ZodError can only come from parsing a 2xx reply (romanAdjustApi.ts:86/91/101), so the server already applied the change, yet the
  card says "The app could not read the reply ... Your workouts are unchanged";
- a timeout or dropped connection after the request left the phone;
- a 5xx after commit (#655 reads the view after the transaction commits, service.ts:416).
The coach then retries an already-applied change (gets ALREADY_DECIDED) or edits the workout by hand a second time. Probe B-337-2
(6 cases). LANE_COPY
Fix rule: for approve, edit and undo, when there is no coded refusal (no status, 5xx, or a ZodError) do not claim the outcome; say
the result could not be confirmed and reload the list (refresh: true) so the card shows the server's state. Keep "unchanged" only
for load and for coded 4xx refusals. Verify with the probe.

Also visible in this app, fixed in #655: B-655-4 (the WORKOUT_CHANGED fallback at romanAdjustCopy.ts:28-29 promises a new suggestion
that never comes; mirror the backend sentence) and B-655-5 (the card shows no date, RomanAdjustmentCard.tsx:189-191, so a stale
"tomorrow's" in Roman's sentence names the wrong day).

Follow-ups (C, not blocking):
- C-337-1 romanAdjustCopy.ts:140-142 changeSummary renders "18 to 21 sets, -17% less volume" for an edit that adds sets (steppers allow
  up to 20, RomanAdjustmentCard.tsx:271). Fix with C-655-3. Probe C-337-a.
- C-337-2 RomanAdjustmentCard.tsx:92-98 + 135-156: leaving the card during the 5 s countdown (navigation, or the queue reload after a
  failed dismiss switches ActionQueueScreen to its loading state and unmounts the list) silently drops the decision the card had
  announced. Fix: send on unmount, or show "Not applied" when the coach comes back. Probe C-337-b.
- C-337-3 ActionQueueScreen.tsx: the Roman section renders inside the action-queue list, so when the queue fetch fails the suggestions
  are hidden too. Fix: render the section outside the queue's error state.
- C-337-4 RomanAdjustmentCard.tsx:89 undoOpen is computed at render only; the server Undo button stays after undo_until passes until a
  re-render (the server answers UNDO_EXPIRED, copy is true). Fix: a timer to the undo deadline.
- C-337-5 RomanAdjustmentCard.tsx:189-191 add the workout weekday next to the plan name (defence for B-655-5).

Evidence: branch audit/AUD-OPUS-RADJ-121/337-1 = head + origin/main merge + probes in
src/components/roman/adjust/__tests__/aud-opus-radj-121.*. LANE_RUN
