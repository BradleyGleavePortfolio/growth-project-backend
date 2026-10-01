# Engagement module (C05 items 6-7)

`src/engagement/`: two `@Cron` + Postgres claim-by-write jobs.
`CoachWelcomeService` (every minute) sends ONE message from the client's coach
into their existing thread at onboarding `completed_at + 13 min`, through
`MessagingService.sendAsCoach` (same push/realtime/audit path as a coach's own
message). Per-coach flag (default off) and template (`{first_name}`,
`{coach_first_name}`; generic default in code) live in
`CoachWelcomeMessageSetting`, set by the owner-only
`GET/PUT /admin/coaches/:coachId/welcome-message` or
`scripts/set-coach-welcome-message.ts`. `WorkoutReminderService` (every 5 min)
pushes at the client's preferred training time (S2) on C1 and each plan day,
client-local timezone, at most one per day, skipped when the session is
logged, opt-out via `workout_reminder_push`. Full detail:
[docs/clinic-engagement.md](../../docs/clinic-engagement.md).
