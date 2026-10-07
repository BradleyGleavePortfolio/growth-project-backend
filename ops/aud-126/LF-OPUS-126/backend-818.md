DRAFT (pre-read at 2e7d8de6 before READY; re-check head before posting)

Reviewed: 2 files, 38+/1- = 39 lines (33 spec). T3 read order only.
Traced: WorkoutService.getWorkouts orderBy [{date desc}, {created_at desc}]; the where { user_id } ownership filter and take are unchanged;
WorkoutSession has created_at (schema.prisma), so the tie-break is a real column. Callers (Recent Workouts, the 50-row history/chart window,
the live "previous sets" hint) now get the newest same-day session first. No schema, migration, route or flag change.
R75 scan: no new as any / as unknown as / as never / empty catch.
B: none.
C: none.
