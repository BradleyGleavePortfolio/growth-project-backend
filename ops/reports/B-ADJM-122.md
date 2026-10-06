# B-ADJM-122 — mobile half of Roman approve-to-adjust fix round (growth-project-mobile#337), agent 122

Status: DONE 17:12 PDT (started 16:50). m#337 head c37add1c37dd47fb6d5ade587b320b84e64854db, PR CI green, FIX ROUND comment posted, READY FOR AUDIT.
Lock: ops/lanes122/locks/roman-adjust-m (released 17:12). Coordination: ops/lanes122/notify/adjust.txt (backend B-ADJB-122 plan acked; no API shape change).
Worktree: /home/user/workspace/wt/B-ADJM-122-337 (local branch agent/clinic/roman-adjust-card-wt tracks origin/agent/clinic/roman-adjust-card).

## Heads
- Start: 63be101394d996bd4475a8ad86c400925997092c (1,052 lines, grandfathered 3,000).
- Local: 0b115f4 (git rm --cached node_modules) -> 36fffd6 (merge origin/main 2c88eae, clean) -> c37add1 (fix + tests). 1,204 lines vs main.

## Bs fixed (ordinary-use story each)
- B-337-1 (Opus; = Sol B-337-1 + B-337-2) CI red: tracked node_modules symlink (guard:vendors EISDIR) and sync RNTL calls against
  RNTL 14. Story: the required check can never pass, so the coach card cannot ship. Fix: untracked the link (main's .gitignore already
  has `node_modules` without slash); every render/fireEvent/act in RomanAdjustmentCard.test.tsx awaited.
- B-337-2 (Opus; = Sol B-337-3) false "Your workouts are unchanged" after Approve/Edit/Undo with a lost reply, unreadable 2xx or 5xx.
  Story: a coach on patchy phone signal taps Approve, the server applies it but the reply is lost, and the card says nothing changed,
  so the coach edits the workout by hand on top. Fix (romanAdjustCopy.adjustErrorView): for approve/edit/undo with no coded refusal
  (no status, ZodError, >= 500) the copy says it is not certain whether the change was applied/undone, and refresh: true removes the
  card and reloads the list so the server state shows (GET list returns applied proposals inside the undo window). Coded refusals,
  429/401/403 and other 4xx keep their copy; dismiss keeps "unchanged" (true). Load copy no longer says "Your workouts are unchanged"
  (it would read as an answer right after an unconfirmed change).
- B-655-2 mirror (Opus): ADJUSTMENT_WORKOUT_CHANGED fallback no longer promises "refresh for a new suggestion"; text equals the backend's
  new sentence (adjust.txt 16:55).
- A-337-1 (Sol) fixed in passing, same function: captureError gets a fixed Error and an allowlisted upper-case code, never the raw
  ZodError (quotes received values) or the axios error. Note: needs app/server contract drift to trigger, arguably edge; 2 lines.

Failing-before: the 16 new/changed assertions fail on the PR-head copy file and pass after (local heavy.sh single-file jest, logs
ops/aud-122/B-ADJM-122/failing-before.log; 34/34 pass after). ESLint on the 2 files clean (heavy.sh).

## Proposed C (edge or not ordinary-harm; not fixed)
- Sol B-337-4 approve/edit callback after unmount: the parent gets the server's newer proposal (correct state) or nothing; no wrong
  data, no money. C (edge, deferred to 10k clients).
- Opus C-337-1 "18 to 21 sets, -17% less volume" when a coach raises sets with the steppers. With b#655 now sending the realized
  volume_pct (B-655-6) this shows for every upward edit; recommend a 3-line changeSummary follow-up before the flag turns on.
- Opus C-337-2 leaving the card during the 5 s countdown drops the decision (edge). Opus C-337-4 / Sol C-337-1 server Undo button
  not removed on a timer (edge; server answers UNDO_EXPIRED with true copy).
- Opus C-337-3 Roman section hidden when the Action Queue fetch fails. Opus C-337-5 weekday on the card: not needed, b#655 now
  writes the weekday name in roman_text (B-655-3).
- Sol C-337-2 cancelled edit draft survives reopening (the steppers show the kept values, so what is applied is what is shown).
- b#655 ADJUSTMENTS_UNAVAILABLE server message still says "Your workouts are unchanged" (suggested to B-ADJB-122, optional).

## CI
- Lane ci/B-ADJM-122-1 (c37add1 + tsc --noEmit + RomanAdjustmentCard.test.tsx): success,
  https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37391376217 (branch deleted after).
- PR CI run 37391538418 at c37add1: attempt 1 "Typecheck, lint, test" failed only on unrelated
  src/screens/client/wearables/__tests__/ConnectProviderSheet.attemptFence.test.tsx (1/7,126; green on main 2c88eae; 21/21 locally
  at this head, log ops/aud-122/B-ADJM-122/attemptFence-local.log). Failed job rerun (no push); attempt 2 success:
  https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37391538418/job/112039305987 . CodeQL success.
- Lint, Typecheck, vendor guard all green in PR CI (B-337-1 closed).

## Comment
- FIX ROUND 1 (B-ADJB-122 / B-ADJM-122, agent 122) at c37add1c, ends READY FOR AUDIT:
  https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/337#issuecomment-6006171272
  (text: ops/aud-122/B-ADJM-122/comment-m337.md)

## Operator decisions (recommended defaults)
1. A-337-1 fixed in passing although it needs app/server contract drift: default keep (2 lines, same function as B-337-2).
2. C-337-1 negative "less volume" on upward edits (now on every upward stepper edit, since b#655 sends realized volume_pct): default a
   small changeSummary follow-up before FEATURE_ROMAN_ADJUST_ENABLED turns on; not in this round.
3. Sol B-337-4 (callback after unmount) downgraded to C (edge): default accept; no wrong data shown.
4. Flaky ConnectProviderSheet.attemptFence spec (unrelated, passed on rerun): default no action now; note for the wearables owner.

## HANDOFF
- Done. m#337 head c37add1c37dd47fb6d5ade587b320b84e64854db (fast-forward from 63be1013), PR CI green, FIX ROUND comment posted.
- Next: lens re-review of m#337 at c37add1c (prior Bs + changed lines only: romanAdjustCopy.ts, RomanAdjustmentCard.test.tsx,
  removal of node_modules). Backend half b#655 is B-ADJB-122's (see notify/adjust.txt).
- Cleanup done: worktree wt/B-ADJM-122-337 removed, local branch agent/clinic/roman-adjust-card-wt deleted, remote ci/B-ADJM-122-1
  deleted, lock roman-adjust-m released. No lane run in flight.
