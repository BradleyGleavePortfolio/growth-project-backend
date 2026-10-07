AUDIT Claude Opus 5.5 (LF-OPUS-126) — growth-project-mobile#447 @ 863df75fab9102b28f44bef7c17bbb34e4e6b441 — VERDICT: APPROVE

A=0 B=0 C=1. CI green at head (Typecheck, lint, test; CodeQL x2). Size 505 changed lines incl. tests. 863df75f over cf19cfa1 is test typing only.

Reviewed: 11 files, 482+/23- = 505 lines (under 800; ~307 tests). T3 client food logging (owner TOP PRIORITY), no payload/contract change.
Scope: not a rebuild of closed m#411 (onboarding draft resume); this is the food-log queue send timing, a different flow.
Traced (Food Log -> Add Food -> offline save -> queue -> send -> day reload):
- useFoodLogQueueSync(authState === 'student', online) mounted once in RootNavigator: sends at sign-in / cold start, on
  offline->online, and on AppState 'active'. The old RootNavigator flush on reconnect is removed (no double trigger); the workout
  queue reconcile on reconnect is untouched.
- syncFoodLogQueue (services/foodLogSync.ts): one in-flight promise shared by overlapping triggers, never rejects, reloads
  clientStore.loadDayData(user, selectedDate) only when >= 1 item landed, then re-reads the pending count.
- Queue send path unchanged: foodLogQueue.flush keeps the owner capture + fenced write-back + per-item owner check (S6 R3 / P2-1),
  POST /foods then POST /log/food with client_uuid = queue item id (server upsert), so a repeated send does not double-log.
- Pending notice on Food Log reads getQueueLength() for the current owner; updated after an offline save (notifyPendingFoodLogs)
  and after every sync. Copy is specific, no first person, no exclamation marks.
- useFoodBrowse: when every day read fails, keeps the last lists (recent foods still usable offline) and sets browseUnavailable;
  FoodSearchView shows "Recent foods could not load" instead of the false "No foods logged in the last 7 days".
- R75 scan: no new as any / as unknown as / as never / empty catch (catches log via logger.warn).
B: none.
C (one line, non-blocking):
- C-447-1 (edge, deferred to 10k clients): two accounts on one device with an unhydrated user cache could send anonymous-queue
  items under whichever account is signed in (pre-existing fence behaviour; this PR only adds a cold-start trigger).
