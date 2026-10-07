Tier: T3
Why: Core client flow (log food) on the 10-07 clinic build: a meal saved offline could stay on the phone and never reach the client's log or the coach.
T4 trigger scan: none (no auth, tenancy, PII, money, credentials or destructive data change; the queue owner fence, payloads and endpoints are unchanged)
T3 trigger scan: core flow (food logging, offline sync timing) in RootNavigator + LogScreen
Bounded T1: NO (touches RootNavigator lifecycle and a core flow)
Canonical builder: Claude Opus 5.5 (FU-FOODLOG-126, agent 126 fleet)
Parent owner: agent 126 (operator)
Acceptance evidence: new behaviour tests below fail on main (modules/props absent) and pass here; existing rootNavigatorConsultationColdBoot, LogScreen.foodSpeed and useFoodBrowse.speed suites pass locally; full CI on this PR.
Promotion triggers: any change to the queue payload, the owner fence, auth/session handling or backend contract would re-grade to T4.

## What this fixes

**B1 — a meal logged offline never reaches the log if the app was closed before signal returned.**
User story: a client logs lunch in a basement gym with no signal, sees "Saved offline ... will sync when you reconnect", locks the phone, and opens the app hours later on Wi-Fi; the lunch never appears in their log, totals or their coach's food review unless they happen to pull down on Food Log.
Cause: `flushFoodLogQueue()` ran only on an in-app offline -> online transition (`RootNavigator` `wasOnlineRef`, which starts `true` on every cold start) or a Food Log pull to refresh. The workout queue already syncs on foreground and auth change; food did not.
Fix: `useFoodLogQueueSync(authState === 'student', online)` sends the queue at sign-in / cold start, on reconnect and on return to the foreground. `syncFoodLogQueue()` shares one send between overlapping triggers, never rejects, and reloads the selected day in the shared client store (Food Log and Home) once at least one food lands, so the client does not log it twice.

**U1 — a food saved offline is invisible.** User story: offline, a client saves breakfast and the Food Log still shows an empty Breakfast and unchanged totals, with nothing saying it is waiting. Fix: the Food Log shows "1 food saved offline is not in this log or its totals yet. It syncs when the connection returns." (online: "Pull down to sync it now."), updated the moment a food is queued and after every sync.

**U2 — offline, Add Food says "No foods logged in the last 7 days".** User story: offline, a client who logs every day opens Add Food and is told nothing was logged this week, and the Recent list they could have used is wiped. Fix: when no day of the week can be read, `useFoodBrowse` keeps the last lists (a recent food can still be saved offline) and flags `browseUnavailable`; the empty state reads "Recent foods could not load. Check the connection, or tap Enter Manually to save this food now."

Works against the current production backend: no API, payload or contract change (same POST /foods + POST /log/food with client_uuid).

## Tests
- `src/services/__tests__/foodLogSync.test.ts` — reload after a sent food; no reload when nothing was sent or nobody is signed in; overlapping triggers share one send; a failed send never rejects and keeps the waiting count current.
- `src/hooks/__tests__/useFoodLogQueueSync.test.ts` — sends at cold start for a signed-in client, not while signed out; again on reconnect; again on return to the foreground; pending count follows updates.
- `src/screens/client/__tests__/LogScreen.offlinePending.test.tsx` — notice copy (one / several, offline / online), no notice when nothing waits, count refresh on an offline save, offline Add Food does not claim nothing was logged.
- `src/hooks/__tests__/useFoodBrowse.speed.test.ts` — offline keeps last lists and flags unavailable; next good read clears the flag.

## Overlap
No open PR touches these files (checked mobile open PRs at 18:02 PDT 10-06).
