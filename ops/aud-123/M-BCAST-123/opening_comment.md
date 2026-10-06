FIX ROUND 1 (OPENING, M-BCAST-123, agent 123) — growth-project-mobile#388 @ 6ad27c87592fcfca38c7d145643c8deed1fb163f

**Tier:** T4 (member content fan-out). Both lenses at this exact head.
**Size:** 1,318 changed lines, 10 files, tests included (under 1,500).
**Base:** main a33e5d75. Pairs with backend b#726-#730 (on main, deployed in deploy 6). `FEATURE_COACH_BROADCASTS` stays unset in production; with it off this PR shows nothing new (entry hidden on 503 `broadcasts.disabled` and on a bare 404).

**What a coach can do:** Messages > Broadcasts: see Scheduled / Recurring / Sent with delivered and read counts; cancel (confirmed), pause and resume. New broadcast: message with `{first_name}`, audience all clients / tag / package / program with a live client count, send now or schedule, repeat daily / weekly / monthly at a set time, confirm before sending. One `Idempotency-Key` per distinct message.
**What clients see:** each copy is an ordinary coach message in their own thread (dispatcher writes `CoachMessage`, backend `src/broadcasts/broadcast-dispatcher.service.ts:418-421`). No client change.

**Pushes:** 56c7ea7a (PR CI all green), then 6ad27c87 before any audit: the Messages entry now opens Broadcasts with `initial: false` so a Clients stack opened there first keeps the client list as its root (the B-332-7 dead end), and the date/time pickers open under their control (iOS inline with Done).

**Evidence:** PR CI at 6ad27c87 all green: Typecheck, lint, test (run 37408085125, https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37408085125), CodeQL + Analyze (run 37408085084). Local (heavy.sh): new `src/screens/coach/broadcasts/__tests__/broadcasts.test.tsx` 11/11 (modules are new, so every case fails before); `CoachInboxV2.test.tsx` 10/10; eslint on changed files 0 errors; `tsc --noEmit` over the changed files and their imports 0 errors.

**Lens map (read first):** `src/api/broadcastsApi.ts` (payloads, gate, error copy) -> `src/screens/coach/broadcasts/BroadcastComposerScreen.tsx` (what gets sent to whom) -> `broadcastFormat.ts` (segment and recurrence builders) -> `CoachBroadcastsScreen.tsx` (cancel / pause / resume) -> `BroadcastsEntry.tsx` + `CoachNavigator.tsx` (reachability).

**Not in this PR (follow-ups, by decision):** cards (no messaging read returns `coach_message_cards`, so clients could not see them), saved replies picker (nothing in the app creates saved replies yet), client tag editor, editing a scheduled broadcast (cancel and re-create).

READY FOR AUDIT
