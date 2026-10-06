AUDIT Claude Opus 5.5 — growth-project-mobile#388 @ 6ad27c87592fcfca38c7d145643c8deed1fb163f — VERDICT: APPROVE

Lens AUD-OPUS-W2B-123 (agent 123), job BC1. Full review at the exact head against backend main e6f9a5ec (src/broadcasts: controller, dto, feature guard, segment.ts, recurrence.ts, broadcasts.service.ts idempotency, broadcast-errors.ts). Required checks green at this head (Typecheck, lint, test; CodeQL). Size 1,278 changed lines (under 1,500). Conventional Commits title, tier header present, no new casts to any/unknown/never, no empty catch, copy has no first person.

**A: 0 | B: 0 | C: 3**

### Checked
- Flag off is invisible: every /coach route answers 503 `broadcasts.disabled` (broadcasts.feature.ts:39); `broadcastsAvailable` returns false for that (and a bare 404), so `BroadcastsEntry` renders nothing in both Messages headers (legacy and CoachInboxV2); a failed probe also renders nothing. The api client has no app-wide 503 handling, so the probe shows nothing to the coach.
- Audience safety (who receives member content): `segmentFor` maps tag / package / program to one `in` rule, and the empty-values case that would mean "all clients" is never sent because `composerProblem` requires `audienceReady` before the confirmation sheet. The confirmation names the live count from POST /coach/broadcasts/preview, and a 0-recipient audience is refused on the phone. The server evaluates every segment inside the author's roster (segment.ts header), so nothing widens past the tenant.
- Contract: create body (`body` <= 4000, `segment`, `timezone`, `send_at` ISO or null, `recurrence` {freq, interval 1, local_time HH:MM, by_weekday 0=Sun..6=Sat, by_month_day}, `status: 'scheduled'`) matches UpsertBroadcastDto + recurrence.ts; list/transition shapes match. Idempotency-Key is any string up to 128 (service:199), one per payload, reused on a retried identical tap.
- Cancel is confirmed; pause/resume only on recurring; server error sentences shown for `broadcast.*` codes are plain and second person (broadcast-errors.ts).
- Clients: the dispatcher writes ordinary CoachMessage rows into each client's coach thread, so no client-side code is needed (builder's finding, consistent with the backend).
- Story holds: "Gym closed Monday, do the home plan" to All clients now, plus a weekly Sunday check-in at a set time.

### C (one line each)
- C-388-1: `broadcastErrorMessage` shows the server's sentence for `broadcast.*` codes (plain today; a mobile copy map per code would keep copy owned by the app).
- C-388-2: the Messages header makes one GET /coach/broadcasts?limit=1 probe per 5 minutes per coach even while the flag is off.
- C-388-3 C (edge, deferred to 10k clients): the schedule uses the phone's time zone at send time.
