DRAFT round 2 (pre-read 9cc1fcdc = a1449f37 + 1 commit for Sol's B-441-1; re-check head before posting)

Reviewed the increment a1449f37..9cc1fcdc (7 files) on top of my a1449f37 review (APPROVE B=0). PR now 398+/41- = 439 lines.
Traced:
- answers.ts (new): Day-1 goals and the chosen check-in time are kept on the device per account in prefsStorage key
  onboarding.day1_answers:<userId>; merge only writes fields that are present (a skipped step never erases an earlier answer); never throws.
- saveGoals / saveCheckInTime now call keepDayOneAnswers before (not instead of) the existing work; the timezone route
  (PUT /notifications/timezone, older PATCH fallback) and the completion call are unchanged, so nothing new reaches production f71bb9a4.
- ReadyScreen: the draft copy is kept before clearResumeState; finish offline keeps it too. No reminder or schedule is promised.
- Sign-out: DAY1_ANSWERS_KEY_PREFIX joins USER_SCOPED_PREFIXES (prefs), so the next person on the phone never inherits goals; the import
  is a constant from a module with no import cycle back to authActions.
- R75 scan: no new as any / as unknown as / as never / empty catch (the parse catch returns null by design).
B: none.
C (one line, non-blocking):
- C-441-3 (edge, deferred to 10k clients): if the answers write fails at finish, the resume checkpoint is left on the device (the Day-1
  gate already passes on the local completion flag).
