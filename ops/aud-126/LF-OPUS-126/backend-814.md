DRAFT (pre-read at ba44c9aa, incremental e27aa237 = spec mock typing only; re-check head before posting)

Reviewed: 4 files, 91+/6- = 97 lines (68 spec). T3 client notifications for the workout core flow.
Traced:
- WorkoutBuilderService.emitAssignmentPush (single assign :634, assign-many :1399 sends once for created[0], notifyProgramAssigned
  :1434 for onboarding :968 and coach AI :461) and ProgramLibraryService.pushProgramAssigned (bulk :1284, once per client, skipped on
  replay) now chain sendPush after the existing createNotification. One push per assign event, no fan-out per workout day.
- sendPush (notifications.service.ts:565) does not write a second inbox row; it applies pushAllowedByPreferences, uses lockScreenCopy
  (WORKOUT_ASSIGNED -> "New workout" / "Your coach added a workout for you.", inbox body ignored, so no program name on the lock
  screen), resolves the client's zone, and is fire-and-forget behind the existing .catch (assignment stands on failure). Recipient is
  the same clientId as the inbox row.
- pushTapData: workout_assigned / workout_reminder -> actionScreen 'WorkoutMain'; every mobile build routes it
  (pushTapRouter.ts CLIENT_PUSH_ROUTES WorkoutMain -> WorkoutTab). Only clients receive these kinds.
- R75 scan: no new as any / as unknown as / as never / empty catch.
B: none.
C: none.
