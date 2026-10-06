AUDIT Claude Opus 5.5 — growth-project-mobile#388 @ 6ad27c87592fcfca38c7d145643c8deed1fb163f — VERDICT: APPROVE

Lens AUD-OPUS-W2C-123 (agent 123), BC1. Tier T4 (member content fan-out). Reviewed only under the owner freeze (SoT A2 items 1-11): edge cases, races, retries and time zones are C and were not chased.

**A 0 / B 0 / C 6**

**Bs:** none.

**What was checked (money / data / access / safety first):**
- Who gets it: `segmentFor` (`src/screens/coach/broadcasts/broadcastFormat.ts:35-38`) gives `{match:'all', rules:[]}` for All clients and one `{field: tag|package|program, op:'in', values}` rule otherwise. That matches backend `parseSegment` (`src/broadcasts/segment.ts` on main: field names, `op:'in'`, uuid ids, normalized tags; package and program ids are `@default(uuid())`). A Tag, Package or Program audience with nothing picked is blocked before sending (`composerProblem`, `BroadcastComposerScreen.tsx:63`), so an empty filter never turns into "all clients". The server still resolves every audience inside the author's own roster (`broadcast-scope.service.ts`), and no request carries a coach or client id.
- What gets sent: the create body `{ body, segment, timezone, send_at, recurrence, status:'scheduled' }` with an `Idempotency-Key` (`broadcastsApi.ts:183-190`) matches `UpsertBroadcastDto` and `parseRecurrence` (`freq`, `interval:1`, `local_time` HH:MM, `by_weekday` 0=Sun..6, `by_month_day` 1-31; no `anchor_date` sent). The key changes whenever the text, audience, time or repeat changes (`BroadcastComposerScreen.tsx:97-101`), and the composer unmounts after a successful send, so a second broadcast with the same text never reuses the key and never comes back as a replay of the first one.
- Clients see it: the dispatcher writes a normal `CoachMessage` (coach_id = tenant, client_id, sender = author) in each client's thread (`broadcast-dispatcher.service.ts:419`). Messaging v1 and v2 both read `CoachMessage`, so nothing needs to change on the client side. The confirm copy "Clients in their quiet hours get it when those end" is true: the dispatcher holds those deliveries and sends them after quiet hours.
- Responses: the zod schemas match `present()` / `list()` / `get()` on backend main (status set, stats keys, nullable fields). Extra keys such as `card` and `runs` are dropped.
- Cancel / pause / resume: the buttons offered (`actionsFor`, `broadcastFormat.ts:148-153`) are a subset of what the server allows (`transition` from-states). Cancel asks for confirmation first, and its copy is true.
- Flag off: the guard order is `JwtAuthGuard, CoachGuard, CoachBroadcastsEnabledGuard` (`broadcasts.controller.ts:46`), so a coach gets 503 `broadcasts.disabled` with a top-level `code` (HttpExceptionFilter). `broadcastsAvailable` returns false and the Messages entry renders null (`BroadcastsEntry.tsx:19-20`). The axios interceptor has no global 5xx handler, so no banner or toast appears. Nothing new shows.
- Way back: the entry navigates `ClientsStack > CoachBroadcasts` with `initial: false` (`BroadcastsEntry.tsx:25`). Both new screens have native headers with a back button (`CoachNavigator.tsx:429-439`), so Back from Broadcasts lands on ClientsList and the Clients tab keeps its root. `MessagesScreen` is mounted only by `CoachNavigator` next to the `ClientsStack` tab, so the target always exists.
- Story walk: Messages > Broadcasts > New broadcast > "Gym closed Monday, do the home plan" > All clients > Send now > confirm "Send to N clients now?" > POST > back to the list (refetched on focus). Then New broadcast > Weekly > tap Sun (and untap today's default day) > At 9:00 AM > Start repeating > confirm "Every Sunday at 9:00 AM" > the series appears under Recurring with "Next: ...". Both paths are covered in `broadcasts.test.tsx`.
- Rules: 1,278 changed lines (1,277 + 1) against a 1,500 limit; no new `as any` / `as unknown as` / `as never`; no empty catch; no we/our/us, exclamation marks or emojis in the new copy; Conventional Commits title; tier header in the body.
- Required checks green at this exact head: Typecheck, lint, test (CI run 37408085125); Analyze (javascript-typescript) and Analyze (actions) (CodeQL run 37408085084); CodeQL also passed.

**Cs (follow-up, no fix now):**
- C-388-1 (ops): while the flag is unset, every probe gets a 503, and the backend filter sends every status >= 500 to Sentry (`src/filters/http-exception.filter.ts:78`). That means about one Sentry event per coach Messages visit (the probe's staleTime is 5 minutes), which is noise that can bury real errors. Fix in the backend (answer the kill switch as 404, or skip `broadcasts.disabled` in Sentry), or let it go away when the flag is flipped on.
- C-388-2: a `draft` broadcast (this app never creates one; only the raw API can) shows "Sent" as its timing line in the Scheduled tab (`broadcastFormat.ts:133`).
- C-388-3: if a response shape drifts and zod rejects it, the screen says "No connection, so nothing was loaded" (`broadcastsApi.ts:156-157`). The contract matches backend main today.
- C-388-4: the section counts and tabs cover only the pages loaded so far (50 per page). C (edge, deferred to 10k clients).
- C-388-5: the PR body and opening comment say 1,318 changed lines; GitHub counts 1,278. Both are under 1,500.
- C (edge, deferred to 10k clients): a retry after a lost response, with the payload edited before the retry, gets a new key and can send twice. Repeats follow the phone's time zone, falling back to UTC if Intl has no zone.

Builder-declared follow-ups (cards, saved replies picker, client tag editor, editing a scheduled broadcast) are out of scope for this entry and not counted.

Independent verdict: the Sol lens's comments and notes for this round were not read before posting.
