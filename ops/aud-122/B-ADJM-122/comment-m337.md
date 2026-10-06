FIX ROUND 1 (B-ADJB-122 / B-ADJM-122, agent 122) — growth-project-mobile#337 @ c37add1c37dd47fb6d5ade587b320b84e64854db

Mobile half of the approve-to-adjust fix round (backend half: growth-project-backend#655, builder B-ADJB-122). Prior verdicts: Sol RC
https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/337#issuecomment-6001900495 , Opus RC
https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/337#issuecomment-6002745483 . Graded under _COMMON_122 item 6.
`FEATURE_ROMAN_ADJUST_ENABLED` stays off (the section renders nothing on the backend 404).

Head 63be1013 -> c37add1c: 0b115f4 untrack node_modules link, 36fffd6 merge origin/main 2c88eae (clean), c37add1 fix + tests.
Size 1,204 changed lines vs main (grandfathered 3,000). No API shape change; backend contract confirmed in ops/lanes122/notify/adjust.txt.

Fixed
- B-337-1 (Opus; Sol B-337-1 + B-337-2) CI red. The tracked `node_modules` symlink is removed from Git (main's .gitignore already has
  `node_modules` without the slash). Every render, fireEvent and act in RomanAdjustmentCard.test.tsx is awaited (RNTL 14).
- B-337-2 (Opus; Sol B-337-3) false "Your workouts are unchanged". Story: a coach on patchy signal taps Approve, the server applies it,
  the reply is lost, and the card said nothing changed. Now Approve, Edit and Undo with no coded refusal (no HTTP status, an unreadable
  reply, or 5xx) say it is not certain whether the change was applied (or undone), remove the card and reload the list, so the card
  shows the server state (the list returns applied suggestions inside the undo window, with Undo). Coded refusals, 401/403/429 and
  other 4xx keep their copy; Dismiss keeps "unchanged" (true). Load errors no longer claim anything about workouts.
  romanAdjustCopy.ts adjustErrorView.
- B-655-2 mirror (Opus): the ADJUSTMENT_WORKOUT_CHANGED fallback no longer promises a new suggestion; it equals the backend's new
  sentence "This workout was edited after Roman made the suggestion, so it was not applied. Open the workout to review it."
- A-337-1 (Sol), same function: Sentry gets a fixed Error plus where/status and an allowlisted upper-case code only, never the raw
  ZodError (which quotes received values) or the response object.

Tests (failing before, passing after)
- 16 new or changed assertions in src/components/roman/adjust/__tests__/RomanAdjustmentCard.test.tsx: 8 adjustErrorView cases
  (timeout, 500/502/503, unreadable 2xx x approve/edit/undo), a lost Approve reply and a lost server Undo reply on the card, a lost
  Approve reply in the section reloading to the applied card, load copy, Sentry payload (ZodError and unrecognised code), the
  WORKOUT_CHANGED fallback. Against the PR-head copy file: 16 failed, 18 passed; after: 34/34 (single-file jest through heavy.sh).
- CI lane ci/B-ADJM-122-1 at c37add1 (tsc --noEmit + this spec): success,
  https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37391376217
- PR CI at c37add1: green. "Typecheck, lint, test" attempt 1 failed only on the unrelated wearables spec ConnectProviderSheet.attemptFence.test.tsx (1 of 7,126; passes on main 2c88eae and 21/21 locally at this head); job rerun, attempt 2 success:
  https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37391538418/job/112039305987 . CodeQL success.

Proposed C (not fixed; operator to confirm)
- Sol B-337-4 approve/edit callback after unmount: the parent receives the server's newer suggestion or nothing; no wrong data.
  C (edge, deferred to 10k clients).
- Opus C-337-1 "18 to 21 sets, -17% less volume" when a coach raises sets with the steppers; with b#655 now sending the realized
  volume_pct this shows on every upward edit. Recommend a small changeSummary follow-up before the flag turns on.
- Opus C-337-2 countdown dropped on unmount (edge); Opus C-337-4 / Sol C-337-1 Undo not removed on a timer (edge; server answers
  UNDO_EXPIRED with true copy); Opus C-337-3 section hidden when the queue fetch fails; Opus C-337-5 weekday on the card (b#655 now
  writes the weekday into roman_text); Sol C-337-2 cancelled edit draft kept (the steppers show it, so what applies is what shows).

READY FOR AUDIT
